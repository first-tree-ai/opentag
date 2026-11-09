"""Offline integration tests: disposable Git worktrees, build scripts and processes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("control", Path(__file__).with_name("control.py"))
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)

FAKE_ENTRY = '''import http from "node:http";
import assert from "node:assert/strict";
assert.equal(process.env.OPENTAG_AUTO_MIGRATE, "false");
assert.ok(process.env.OPENTAG_HOME);
if (process.argv.includes("daemon")) {
    assert.equal(process.env.BETTER_AUTH_SECRET, undefined);
    assert.equal(process.env.OPENTAG_DATABASE_URL, undefined);
    setInterval(() => {}, 100);
} else {
    http.createServer((req, res) => { res.writeHead(200, { "x-opentag-revision": process.env.OPENTAG_BUILD_REVISION }); res.end(); })
        .listen(Number(process.env.OPENTAG_PORT), "127.0.0.1");
}
'''


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opentag-acceptance-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        self.put(".gitignore", "dist/\n")
        for path in control.SCHEMA:
            target = path if path.endswith(".ts") else f"{path}/input.txt"
            self.put(target, "baseline\n")
        build = "from pathlib import Path\n"
        build += f"outputs = {control.OUTPUTS!r}\n"
        build += "for folder in outputs:\n    p = Path(folder)\n    p.mkdir(parents=True)\n    (p / 'asset.txt').write_text('fresh')\n"
        for entry in control.ENTRIES.values():
            build += f"p = Path({entry!r})\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text({FAKE_ENTRY!r})\n"
        self.put("build.py", build)
        self.sha = self.commit()
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = self.root / "private.env"
        self.env.write_text("OPENTAG_DATABASE_URL=fixture-only\nBETTER_AUTH_SECRET=fixture-only\nOPENTAG_AUTO_MIGRATE=true\n")
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            self.port = port.getsockname()[1]
        self.config = {"state_dir": str(self.root / "state"), "home_dir": str(self.home),
                       "env_file": str(self.env), "node": str(Path(shutil.which("node")).resolve()),
                       "server_url": f"http://127.0.0.1:{self.port}",
                       "database_source": {"source": str(self.source), "sha": self.sha},
                       "build_command": [sys.executable, "build.py"]}
        credentials = self.home / "config" / "computer-credentials.json"
        credentials.parent.mkdir()
        credentials.write_text(json.dumps({"version": 3, "computer": {"serverUrl": self.config["server_url"]}}))
        self.path = self.root / "config.json"
        self.path.write_text(json.dumps(self.config))
        self.controller = control.Controller(self.path)
        self.addCleanup(self.cleanup_processes)

    def put(self, relative, value):
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self):
        control.git(self.source, "add", ".")
        control.git(self.source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return control.git(self.source, "rev-parse", "HEAD")

    def cleanup_processes(self):
        for child in self.controller.children:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)

    def build(self):
        return self.controller.build(str(self.source), self.sha)

    def select(self):
        return self.controller.select(str(self.source), self.sha)

    def test_exclusion_survives_commands_and_is_shared_by_home(self):
        session = subprocess.Popen([sys.executable, str(SPEC.origin), "--config", str(self.path), "session"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn("Exclusive session acquired", session.stdout.readline())
            self.assertTrue(self.controller.status()["reservation"]["active"])
            session.stdin.write("status\n")
            session.stdin.flush()
            # A different state directory cannot bypass the reservation of the same home.
            other = dict(self.config, state_dir=str(self.root / "other-state"))
            other_path = self.root / "other.json"
            other_path.write_text(json.dumps(other))
            refused = subprocess.run([sys.executable, str(SPEC.origin), "--config", str(other_path), "session"],
                                     input="", text=True, capture_output=True, timeout=5)
            self.assertEqual(refused.returncode, 1)
            self.assertIn("already exclusively owned", refused.stderr)
            session.communicate("exit\n", timeout=5)
            self.assertEqual(session.returncode, 0)
            with control.Controller(other_path).session():
                pass
        finally:
            if session.poll() is None:
                session.terminate()
                session.communicate(timeout=5)

    def test_dirty_and_abbreviated_candidates_are_refused(self):
        with self.controller.session():
            with self.assertRaisesRegex(RuntimeError, "full 40-character"):
                self.controller.build(str(self.source), self.sha[:8])
            self.put("untracked.txt", "uncommitted")
            with self.assertRaisesRegex(RuntimeError, "Dirty candidate"):
                self.build()

    def test_build_is_observed_not_inferred_from_head(self):
        with self.controller.session():
            with self.assertRaisesRegex(RuntimeError, "No build receipt"):
                self.controller.plan(str(self.source), self.sha)
            proof = self.build()
            (self.source / control.ENTRIES["server"]).write_text("stale build")
            with self.assertRaisesRegex(RuntimeError, "Stale build identity"):
                self.select()
            # Force-build cleans stale files, rather than attesting to leftover outputs.
            (self.source / "apps/web/dist/leftover").write_text("old")
            rebuilt = self.build()
            self.assertNotEqual(proof["build_id"], rebuilt["build_id"])
            self.assertFalse((self.source / "apps/web/dist/leftover").exists())

    def test_failed_build_invalidates_previous_receipt(self):
        with self.controller.session():
            self.build()
            (self.source / "apps/web/dist/old").write_text("leftover")
            self.controller.config["build_command"] = [sys.executable, "-c", "raise SystemExit(1)"]
            with self.assertRaises(subprocess.CalledProcessError):
                self.build()
            with self.assertRaisesRegex(RuntimeError, "No build receipt"):
                self.controller.proof(str(self.source), self.sha)

    def test_actual_runtime_records_both_roles_and_stops_gracefully(self):
        with self.controller.session():
            proof = self.build()
            status = self.select()
            for role in control.ENTRIES:
                row = status["processes"][role]
                self.assertTrue(row["running"])
                self.assertTrue(row["verified"])
                self.assertEqual(row["sha"], self.sha)
                self.assertEqual(row["build_id"], proof["build_id"])
                self.assertEqual(row["argv"][1], str(self.source / control.ENTRIES[role]))
            self.assertEqual(status["processes"]["server"]["ready_revision"], self.sha)
            with self.assertRaisesRegex(RuntimeError, "running source"):
                self.build()
            self.controller.stop()
            self.assertTrue(all(not x["running"] for x in self.controller.status()["processes"].values()))
        # Leaving the session retains processes and receipts, rather than fabricating an empty state.
        restored = control.Controller(self.path)
        self.assertEqual(restored.status()["processes"]["server"]["sha"], self.sha)

    def test_wrong_pid_cannot_stop_any_role(self):
        with self.controller.session():
            self.build()
            self.select()
            server = self.controller.runtime["server"]["pid"]
            record = self.controller.runtime["daemon"]
            original = dict(record)
            record["pid"] = os.getpid()
            with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                self.controller.stop()
            self.assertIsNotNone(control.process_identity(server))
            record.update(original)
            record["identity"] = dict(record["identity"], started="a reused PID")
            with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                self.select()
            self.assertIsNotNone(control.process_identity(server))

    def test_migration_and_schema_differences_refuse_before_stop(self):
        with self.controller.session():
            self.build()
            self.select()
            server = self.controller.runtime["server"]["pid"]
            other = self.root / "candidate"
            control.git(self.source, "worktree", "add", "--detach", str(other), self.sha)
            for relative in ("packages/server/drizzle/new.sql", "packages/server/src/db/schema/new.ts"):
                path = other / relative
                path.write_text("new schema")
                control.git(other, "add", ".")
                control.git(other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                            "commit", "-qm", "schema change")
                target = control.git(other, "rev-parse", "HEAD")
                self.controller.build(str(other), target)
                with self.assertRaisesRegex(RuntimeError, "Migration/schema difference"):
                    self.controller.select(str(other), target)
                self.assertIsNotNone(control.process_identity(server))
                control.git(other, "reset", "--hard", self.sha)

    def test_unknown_listener_is_not_adopted(self):
        with self.controller.session(), socket.socket() as listener:
            self.build()
            listener.bind(("127.0.0.1", self.port))
            listener.listen()
            with self.assertRaises(OSError):
                self.select()
            self.assertEqual(self.controller.runtime, {})

    def test_session_release_preserves_runtime_and_allows_next_owner(self):
        with self.controller.session():
            self.build()
            self.select()
        next_owner = control.Controller(self.path)
        with next_owner.session():
            self.assertTrue(next_owner.status()["processes"]["server"]["running"])
            next_owner.stop()

    def test_switch_reports_new_candidate_not_controller_head(self):
        with self.controller.session():
            self.build()
            self.select()
            old_pid = self.controller.runtime["server"]["pid"]
            other = self.root / "second"
            self.put("change.txt", "new application behavior")
            target = self.commit()
            control.git(self.source, "worktree", "add", "--detach", str(other), target)
            proof = self.controller.build(str(other), target)
            status = self.controller.select(str(other), target)
            self.assertIsNone(control.process_identity(old_pid))
            self.assertEqual(status["processes"]["server"]["sha"], target)
            self.assertEqual(status["processes"]["daemon"]["build_id"], proof["build_id"])
            self.assertTrue(status["processes"]["server"]["verified"])

    def test_stale_build_refuses_before_stopping_live_server(self):
        with self.controller.session():
            self.build()
            self.select()
            server = self.controller.runtime["server"]["pid"]
            (self.source / "apps/web/dist/asset.txt").write_text("replaced after build")
            with self.assertRaisesRegex(RuntimeError, "Stale build identity"):
                self.select()
            self.assertIsNotNone(control.process_identity(server))
            self.assertFalse(self.controller.status()["processes"]["server"]["verified"])

    def test_ready_revision_mismatch_is_not_accepted(self):
        # The build itself is valid, but the running entry reports a different revision.
        path = self.source / "build.py"
        path.write_text(path.read_text().replace("process.env.OPENTAG_BUILD_REVISION }", '\"wrong\" }'))
        self.sha = self.commit()
        self.config["database_source"]["sha"] = self.sha
        self.path.write_text(json.dumps(self.config))
        self.controller = control.Controller(self.path)
        with self.controller.session():
            self.build()
            with self.assertRaisesRegex(RuntimeError, "Readiness revision differs"):
                self.select()
            self.assertNotIn("daemon", self.controller.runtime)
            self.assertFalse(self.controller.status()["processes"]["server"]["verified"])

    def test_daemon_credential_target_mismatch_refuses_before_stop(self):
        with self.controller.session():
            self.build()
            self.select()
            server = self.controller.runtime["server"]["pid"]
            path = self.home / "config" / "computer-credentials.json"
            path.write_text(json.dumps({"version": 3, "computer": {"serverUrl": "https://other.invalid"}}))
            with self.assertRaisesRegex(RuntimeError, "Daemon credential server differs"):
                self.select()
            self.assertIsNotNone(control.process_identity(server))

    def test_changed_config_and_missing_lock_refuse_mutation(self):
        with self.assertRaisesRegex(RuntimeError, "exclusive acceptance session"):
            self.build()
        with self.controller.session():
            self.path.write_text(json.dumps(dict(self.config, home_dir="/other")))
            with self.assertRaisesRegex(RuntimeError, "Config changed"):
                self.build()


if __name__ == "__main__":
    unittest.main()
