import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENTRYPOINT = fileURLToPath(new URL("../runner/entrypoint.sh", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../runner/Dockerfile", import.meta.url));
const INIT_PATH = "/usr/local/bin/opentag-init";

/** Run the entrypoint with a controlled PATH; never relies on the host's uid or setpriv. */
async function runEntrypoint(args, { path, workspace }) {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", [ENTRYPOINT, ...args], {
      env: { PATH: path, HOME: workspace, TMPDIR: workspace, OPENTAG_WORKSPACE: workspace },
      timeout: 5_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function stub(directory, name, body) {
  const file = join(directory, name);
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

test("entrypoint runs non-root commands directly and never elevates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentag-entrypoint-"));
  try {
    await stub(directory, "id", "#!/bin/sh\nprintf 10000\n");
    await stub(directory, "setpriv", "#!/bin/sh\nprintf 'setpriv-called'\n");
    await stub(directory, "probe", '#!/bin/sh\nprintf "<%s>" "$@"\n');
    const result = await runEntrypoint(["probe", "a b", "c"], { path: directory, workspace: directory });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "<a b><c>");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entrypoint refuses the exact serve path without the source-owned init instead of running unprivileged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentag-entrypoint-"));
  try {
    await stub(directory, "id", "#!/bin/sh\nprintf 10000\n");
    await stub(directory, "setpriv", "#!/bin/sh\nprintf 'setpriv-called'\n");
    for (const args of [["opentag-runner", "serve"], ["serve"]]) {
      const result = await runEntrypoint(args, { path: directory, workspace: directory });
      assert.equal(result.code, 1, `expected fail-closed for ${args.join(" ")}`);
      assert.match(result.stderr, /opentag-init is missing/);
      assert.equal(result.stdout, "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entrypoint source keeps the privileged serve path ahead of the unprivileged drop", async () => {
  const entrypoint = await readFile(ENTRYPOINT, "utf8");
  assert.match(entrypoint, /exec \/usr\/bin\/setpriv --reuid=10000 --regid=10000 --clear-groups -- "\$@"/);
  assert.match(entrypoint, /if \[ "\$\(id -u\)" -eq 0 \]; then/);
  assert.match(entrypoint, /exec \/usr\/local\/bin\/opentag-init \/usr\/local\/bin\/opentag-runner serve "\$@"/);
  assert.ok(
    entrypoint.indexOf(INIT_PATH) < entrypoint.indexOf("/usr/bin/setpriv"),
    "the serve/init branch must be evaluated before the unprivileged drop",
  );
});

test("image defaults to root only for serve and asserts the base-image setpriv without downloading it", async () => {
  const dockerfile = await readFile(DOCKERFILE, "utf8");
  assert.match(dockerfile, /^USER root$/m);
  assert.doesNotMatch(dockerfile, /^USER runner$/m);
  assert.match(dockerfile, /\/usr\/bin\/setpriv --version \| grep -F "setpriv from util-linux"/);
  assert.match(dockerfile, /setpriv --reuid=10000 --regid=10000 --clear-groups -- id -u/);
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*util-linux/i);
  assert.doesNotMatch(dockerfile, /(curl|wget)[^\n]*setpriv/i);
});
