#!/usr/bin/env python3
"""Cooperative, foreground acceptance-session control for macOS and Linux."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse
import urllib.request
import uuid

OUTPUTS = [f"packages/{name}/dist" for name in
           ("shared", "client", "server", "mcp-presets", "skill-presets")]
OUTPUTS += ["apps/cli/dist", "apps/web/dist"]
SCHEMA = ["packages/server/drizzle", "packages/server/src/db/schema",
          "packages/server/src/db/migrate.ts"]
ENTRIES = {"server": "packages/server/dist/index.mjs",
           "daemon": "apps/cli/dist/cli/index.mjs"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump(value, output, indent=2)
        output.write("\n")
    temporary.replace(path)


def git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args],
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def candidate(source, sha):
    source = Path(source).resolve(strict=True)
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Use a full 40-character candidate SHA")
    require(git(source, "rev-parse", "--show-toplevel") == str(source), "Source must be a worktree root")
    require(git(source, "rev-parse", "HEAD") == sha, "Candidate HEAD differs from requested SHA")
    require(not git(source, "status", "--porcelain", "--untracked-files=all"), "Dirty candidate refused")
    return source


def schema(source, sha):
    trees = [git(source, "ls-tree", "-r", sha, "--", path) for path in SCHEMA]
    require(all(trees), "Missing schema/migration inputs; compatibility is unknown")
    return digest(trees)


def artifacts(source):
    result = {}
    for relative in OUTPUTS:
        directory = source / relative
        require(directory.is_dir() and not directory.is_symlink(), f"Missing or linked build output: {relative}")
        files = sorted(directory.rglob("*"))
        require(any(p.is_file() for p in files), f"Empty build output: {relative}")
        for path in files:
            require(not path.is_symlink(), "Linked build artifacts refused")
            if path.is_file():
                result[str(path.relative_to(source))] = hashlib.sha256(path.read_bytes()).hexdigest()
    for entry in ENTRIES.values():
        require(entry in result, f"Missing build entry: {entry}")
    return digest(result)


def process_identity(pid):
    require(type(pid) is int and pid > 1, "Invalid PID; refusing mutation")
    result = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "uid=,lstart=,stat=,command="],
                            capture_output=True, text=True, check=False)
    if result.returncode == 1 and not result.stdout.strip():
        return None
    require(result.returncode == 0, "Cannot inspect PID; refusing mutation")
    fields = result.stdout.strip().split(None, 7)
    require(len(fields) == 8, "Cannot parse PID identity; refusing mutation")
    if fields[6].startswith("Z"):
        return None
    return {"uid": int(fields[0]), "started": " ".join(fields[1:6]), "command": fields[7]}


def owned(record):
    identity = process_identity(record["pid"])
    if identity is None:
        return False
    require(identity["uid"] == os.getuid() and identity == record["identity"],
            "PID ownership mismatch; refusing mutation")
    require(identity["command"] == " ".join(record["argv"]), "PID command mismatch; refusing mutation")
    return True


class Controller:
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve(strict=True)
        self.config = read_json(self.config_path)
        self.config_id = digest(self.config)
        for key in ("state_dir", "home_dir", "env_file", "node"):
            value = Path(self.config[key])
            require(value.is_absolute(), f"{key} must be absolute")
            self.config[key] = str(value.resolve())
        self.state = Path(self.config["state_dir"])
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.runtime_path = self.state / "runtime.json"
        self.runtime = read_json(self.runtime_path, {})
        self.children = []
        self.locked = False
        self.lock_path = Path(self.config["home_dir"]) / ".im-acceptance.lock"
        self.url = urlparse(self.config["server_url"])
        require(self.url.scheme == "http" and self.url.hostname == "127.0.0.1"
                and self.url.port and self.url.path in ("", "/")
                and not self.url.username and not self.url.query and not self.url.fragment,
                "server_url must be an explicit http://127.0.0.1:PORT")

    @contextlib.contextmanager
    def session(self):
        # Never unlink this file: flock ownership is attached to its inode.
        with self.lock_path.open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError("Acceptance session is already exclusively owned") from error
            self.locked = True
            self.runtime = read_json(self.runtime_path, {})
            lock.seek(0)
            lock.truncate()
            json.dump({"pid": os.getpid(), "state_dir": str(self.state), "config": self.config_id}, lock)
            lock.flush()
            try:
                yield
            finally:
                self.locked = False
                fcntl.flock(lock, fcntl.LOCK_UN)

    def guard(self):
        require(self.locked, "Mutation requires an exclusive acceptance session")
        require(digest(read_json(self.config_path)) == self.config_id, "Config changed during session")
        for record in self.runtime.values():
            require(record["config"] == self.config_id, "Runtime belongs to a different config")
            owned(record)  # Validate every role before any destructive action.

    def receipt_path(self, source, sha):
        return self.state / f"build-{digest([str(source), sha])}.json"

    def build(self, source, sha):
        self.guard()
        source = candidate(source, sha)
        for record in self.runtime.values():
            require(not (Path(record["source"]) == source and owned(record)), "Cannot rebuild a running source")
        receipt = self.receipt_path(source, sha)
        receipt.unlink(missing_ok=True)
        for relative in OUTPUTS:
            path = source / relative
            require(not path.is_symlink() and path.resolve().is_relative_to(source),
                    "Linked or external output directory refused")
            if path.exists():
                shutil.rmtree(path)
        command = self.config.get("build_command", ["pnpm", "exec", "turbo", "run", "build", "--force"])
        require(isinstance(command, list) and command and all(isinstance(x, str) for x in command),
                "build_command must be an argv array")
        with (self.state / "build.log").open("w") as output:
            subprocess.run(command, cwd=source, env=self.base_environment(), stdin=subprocess.DEVNULL,
                           stdout=output, stderr=subprocess.STDOUT, check=True)
        candidate(source, sha)
        proof = {"source": str(source), "sha": sha, "build_id": str(uuid.uuid4()),
                 "artifacts": artifacts(source), "schema": schema(source, sha), "command": command}
        write_json(receipt, proof)
        return proof

    def proof(self, source, sha):
        source = candidate(source, sha)
        proof = read_json(self.receipt_path(source, sha))
        require(proof and proof["sha"] == sha and proof["source"] == str(source), "No build receipt for candidate")
        require(proof["artifacts"] == artifacts(source), "Stale build identity; rebuild candidate")
        require(proof["schema"] == schema(source, sha), "Schema identity changed")
        return proof

    def plan(self, source, sha):
        self.guard()
        proof = self.proof(source, sha)
        baseline = self.config["database_source"]
        baseline_source = Path(baseline["source"]).resolve(strict=True)
        require(re.fullmatch(r"[0-9a-f]{40}", baseline["sha"]), "Database source needs a full SHA")
        require(proof["schema"] == schema(baseline_source, baseline["sha"]),
                "Migration/schema difference from declared database source; refusing automatic switch")
        for record in self.runtime.values():
            require(record["schema"] == proof["schema"], "Running source schema differs; refusing switch")
        self.check_daemon_home()
        if not (self.runtime.get("server") and owned(self.runtime["server"])):
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(("127.0.0.1", self.url.port))
        return proof

    def check_daemon_home(self):
        path = Path(self.config["home_dir"]) / "config" / "computer-credentials.json"
        credentials = read_json(path, {})
        require(isinstance(credentials, dict) and credentials.get("version") == 3
                and isinstance(credentials.get("computer"), dict),
                "Missing or unsupported daemon credentials; preserve the existing configured home")
        target = credentials["computer"].get("serverUrl")
        require(isinstance(target, str) and target.rstrip("/") == self.config["server_url"].rstrip("/"),
                "Daemon credential server differs from acceptance server; refusing switch")

    @staticmethod
    def base_environment():
        return {k: v for k, v in os.environ.items()
                if not k.startswith(("OPENTAG_", "COMPOSE_")) and k != "BETTER_AUTH_SECRET"}

    def environment(self, role):
        result = self.base_environment()
        # Parse literal assignments only; do not execute shell or print values.
        for line in Path(self.config["env_file"]).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = shlex.split(line)
            require(len(parts) == 1 and "=" in parts[0], "Malformed environment assignment")
            key, value = parts[0].split("=", 1)
            require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key), "Invalid environment key")
            result[key] = value
        if role == "daemon":
            allowed = {"OPENTAG_LOG_LEVEL", "OPENTAG_RUNTIME_CREDENTIAL_MODE"}
            result = {k: v for k, v in result.items()
                      if (not k.startswith("OPENTAG_") or k in allowed)
                      and not k.startswith("COMPOSE_") and k != "BETTER_AUTH_SECRET"}
        result.update(OPENTAG_HOME=self.config["home_dir"], OPENTAG_SERVICE_MODE="1",
                      OPENTAG_SERVER_URL=self.config["server_url"], OPENTAG_AUTO_MIGRATE="false")
        if role == "server":
            result.update(OPENTAG_HOST="127.0.0.1", OPENTAG_PORT=str(self.url.port),
                          OPENTAG_PUBLIC_URL=self.config["server_url"])
        return result

    def stop_role(self, role):
        record = self.runtime.get(role)
        if not record or not owned(record):
            return
        os.kill(record["pid"], signal.SIGTERM)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            for child in self.children:
                child.poll()  # Reap owned children so zombies are not mistaken for live processes.
            if not owned(record):
                return
            time.sleep(0.1)
        raise RuntimeError(f"{role} did not stop gracefully; no forced kill attempted")

    def stop(self):
        self.guard()
        self.stop_role("daemon")
        self.stop_role("server")

    def start_role(self, role, proof, environment):
        if role == "server":
            environment["OPENTAG_BUILD_REVISION"] = proof["sha"]
        argv = [self.config["node"], str(Path(proof["source"]) / ENTRIES[role])]
        if role == "daemon":
            argv += ["daemon", "service-run"]
        with (self.state / f"{role}.log").open("ab") as output:
            child = subprocess.Popen(argv, cwd=proof["source"], env=environment,
                                     stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(child)
        time.sleep(0.1)
        identity = process_identity(child.pid)
        if not (identity and identity["uid"] == os.getuid() and identity["command"] == " ".join(argv)):
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
            raise RuntimeError(f"Cannot prove launched {role} identity; inspect logs")
        self.runtime[role] = {**proof, "pid": child.pid, "identity": identity, "argv": argv,
                              "config": self.config_id}
        write_json(self.runtime_path, self.runtime)
        require(child.poll() is None, f"{role} exited; inspect private log")

    def select(self, source, sha):
        proof = self.plan(source, sha)  # All compatibility failures precede stop.
        environments = {role: self.environment(role) for role in ENTRIES}
        self.stop()
        # Unknown listeners (including the legacy controller) must never be taken over.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", self.url.port))
        self.proof(source, sha)
        self.start_role("server", proof, environments["server"])
        deadline = time.monotonic() + 30
        while True:
            require(owned(self.runtime["server"]), "Server exited before readiness")
            try:
                self.ready_revision(proof["sha"])
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Server readiness timed out; inspect private log")
                time.sleep(0.2)
        self.start_role("daemon", proof, environments["daemon"])
        return self.status()

    def ready_revision(self, sha):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.config["server_url"].rstrip("/") + "/readyz", timeout=1) as response:
            require(response.status == 200, "Server is not ready")
            revision = response.headers.get("x-opentag-revision")
            require(revision == sha, "Readiness revision differs from candidate build")
            return revision

    def reservation(self):
        with self.lock_path.open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock.seek(0)
                return {"active": True, "owner": json.load(lock)}
            fcntl.flock(lock, fcntl.LOCK_UN)
            return {"active": False}

    def status(self):
        self.runtime = read_json(self.runtime_path, {})
        result = {"server_url": self.config["server_url"], "reservation": self.reservation(), "processes": {}}
        for role, record in self.runtime.items():
            state = {k: record[k] for k in ("pid", "sha", "source", "build_id", "argv")}
            try:
                state["running"] = owned(record)
                self.proof(record["source"], record["sha"])
                require(record["config"] == self.config_id, "Runtime config differs")
                require(record["artifacts"] == artifacts(Path(record["source"])), "Runtime build identity differs")
                if role == "server" and state["running"]:
                    state["ready_revision"] = self.ready_revision(record["sha"])
                state["verified"] = True
            except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
                state.update(verified=False, error=str(error))
            result["processes"][role] = state
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("action", choices=["status", "session"])
    args = parser.parse_args()
    controller = Controller(args.config)
    if args.action == "status":
        print(json.dumps(controller.status(), indent=2))
        return
    with controller.session():
        print("Exclusive session acquired. Commands: build|plan|select SOURCE FULL_SHA; status; stop; exit", flush=True)
        for line in sys.stdin:
            try:
                parts = shlex.split(line)
                if parts == ["exit"]:
                    break
                if parts == ["status"]:
                    result = controller.status()
                elif parts == ["stop"]:
                    controller.stop()
                    result = controller.status()
                elif len(parts) == 3 and parts[0] in ("build", "plan", "select"):
                    result = getattr(controller, parts[0])(parts[1], parts[2])
                else:
                    raise RuntimeError("Expected build|plan|select SOURCE FULL_SHA, status, stop, or exit")
                print(json.dumps(result, indent=2), flush=True)
            except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
                print(f"Refused: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        sys.exit(1)
