import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostPlatform } from "../portable/build-portable.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installerPath = join(repoRoot, "scripts", "portable", "install.sh");
const platform = hostPlatform();
const channel = "staging";
const binName = "opentag-staging";
const packageName = "open-tag-staging";

// The embedded runtime is replaced by a shell script so the installer can be exercised without
// downloading a real Node.js build. It answers the two invocations the installer makes: the
// pre-commit `--version` smoke check and the post-install service reconciliation.
const RUNTIME_DOUBLE = `#!/bin/sh
root=$(CDPATH= cd -L "$(dirname "$0")/../.." && pwd -L)
shift
case "\${1:-}" in
  --version)
    cat "$root/VERSION"
    ;;
  daemon)
    if [ "\${2:-}" = "ensure-service" ]; then
      echo "No credentials found; daemon service setup is deferred until login."
      exit 3
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`;

function writeExecutable(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o755 });
}

function buildRelease({ releaseRoot, version, baseUrl }) {
  const artifactRoot = join(releaseRoot, ".build", version);
  const appDir = join(artifactRoot, "app", "cli");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(artifactRoot, "VERSION"), `${version}\n`);
  writeFileSync(join(artifactRoot, "app", "cli", "index.mjs"), "// portable app entry test double\n");
  writeFileSync(
    join(artifactRoot, "app", "package.json"),
    `${JSON.stringify({ name: packageName, version, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactRoot, "INSTALL.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        channel,
        version,
        gitSha: "0".repeat(40),
        nodeVersion: "v24.19.0",
        packageName,
        binName,
        serviceId: "opentag-staging",
        generatedAt: "2026-08-25T00:00:00.000Z",
        platform,
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
      },
      null,
      2,
    )}\n`,
  );
  writeExecutable(join(artifactRoot, "node", "bin", "node"), RUNTIME_DOUBLE);
  writeExecutable(
    join(artifactRoot, "bin", binName),
    `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -L "$(dirname "$0")/.." && pwd -L)\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n`,
  );

  const fileName = `${packageName}-${version}-${platform}.tar.gz`;
  const versionDir = join(releaseRoot, channel, version);
  mkdirSync(versionDir, { recursive: true });
  const tarballPath = join(versionDir, fileName);
  const tar = spawnSync("tar", ["-czf", tarballPath, "-C", artifactRoot, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);

  const asset = {
    platform,
    fileName,
    url: `${baseUrl}/${channel}/${version}/${fileName}`,
    sha256: createHash("sha256").update(readFileSync(tarballPath)).digest("hex"),
    size: statSync(tarballPath).size,
  };
  const metadata = {
    schemaVersion: 1,
    channel,
    version,
    gitSha: "0".repeat(40),
    nodeVersion: "v24.19.0",
    packageName,
    binName,
    serviceId: "opentag-staging",
    generatedAt: "2026-08-25T00:00:00.000Z",
  };
  writeFileSync(join(versionDir, "manifest.json"), `${JSON.stringify({ ...metadata, assets: [asset] }, null, 2)}\n`);
  writeFileSync(join(versionDir, "SHA256SUMS"), `${asset.sha256}  ${fileName}\n`);
  writeFileSync(
    join(releaseRoot, channel, "latest.json"),
    `${JSON.stringify(
      { ...metadata, manifestUrl: `${baseUrl}/${channel}/${version}/manifest.json`, assets: [asset] },
      null,
      2,
    )}\n`,
  );
  return { asset, tarballPath, versionDir };
}

async function withReleaseServer(run) {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-install-test-"));
  const releaseRoot = join(root, "release");
  mkdirSync(releaseRoot, { recursive: true });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const path = join(releaseRoot, normalize(decodeURIComponent((request.url ?? "").split("?")[0])));
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-length": statSync(path).size });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, releaseRoot, requests, root });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { force: true, recursive: true });
  }
}

// The release server runs in this process, so the installer must be spawned asynchronously: a
// synchronous child would block the event loop and deadlock against its own download.
function runInstaller({ root, baseUrl, args = [] }) {
  return new Promise((complete, reject) => {
    const child = spawn(
      "sh",
      [installerPath, "--prefix", join(root, "prefix"), "--bin-dir", join(root, "bin"), "--no-path-edit", ...args],
      {
        env: {
          ...process.env,
          HOME: join(root, "home"),
          OPENTAG_PORTABLE_CHANNEL: channel,
          OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => complete({ status, stderr, stdout }));
  });
}

function tarballRequests(requests, version) {
  return requests.filter((url) => url.includes(`/${version}/`) && url.endsWith(".tar.gz")).length;
}

test("portable installer activates a release and short-circuits when it is already current", {
  skip: platform === null,
}, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, requests, root }) => {
    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });

    const first = await runInstaller({ baseUrl, root });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /OpenTag 0\.0\.2-staging\.1\.1 installed at/);
    assert.match(first.stdout, /daemon service setup is deferred until login/i);
    assert.equal(tarballRequests(requests, "0.0.2-staging.1.1"), 1);

    const shim = join(root, "bin", binName);
    const installed = spawnSync(shim, ["--version"], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim(), "0.0.2-staging.1.1");
    assert.ok(existsSync(join(root, "prefix", "current", "INSTALL.json")));

    const second = await runInstaller({ baseUrl, root });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /already installed and up to date; skipping download/);
    assert.match(second.stdout, /--force to reinstall/);
    assert.equal(
      tarballRequests(requests, "0.0.2-staging.1.1"),
      1,
      "an up-to-date install must not download the payload again",
    );
    // A short-circuited run must not touch service state either.
    assert.doesNotMatch(second.stdout, /daemon service setup is deferred/i);

    const forced = await runInstaller({ args: ["--force"], baseUrl, root });
    assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
    assert.match(forced.stdout, /OpenTag 0\.0\.2-staging\.1\.1 installed at/);
    assert.equal(tarballRequests(requests, "0.0.2-staging.1.1"), 2, "--force must reinstall the same version");
  });
});

test("portable installer can install an immutable version without a channel pointer", {
  skip: platform === null,
}, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, requests, root }) => {
    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });
    // The release gate installs by exact version before any pointer exists, so this path must not
    // depend on latest.json at all.
    await rm(join(releaseRoot, channel, "latest.json"), { force: true });

    const result = await runInstaller({ args: ["--version", "0.0.2-staging.1.1"], baseUrl, root });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /OpenTag 0\.0\.2-staging\.1\.1 installed at/);
    assert.ok(
      !requests.some((url) => url.endsWith("latest.json")),
      "a version-pinned install must never read the channel pointer",
    );

    const installed = spawnSync(join(root, "bin", binName), ["--version"], { encoding: "utf8" });
    assert.equal(installed.stdout.trim(), "0.0.2-staging.1.1");
  });
});

test("portable installer never rewrites the payload current points at", { skip: platform === null }, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, root }) => {
    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });
    assert.equal((await runInstaller({ baseUrl, root })).status, 0);

    const versionsDir = join(root, "prefix", "versions");
    const before = readdirSync(versionsDir).sort();
    assert.deepEqual(before, ["0.0.2-staging.1.1"]);
    const currentBefore = realpathSync(join(root, "prefix", "current"));

    const forced = await runInstaller({ args: ["--force"], baseUrl, root });
    assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);

    // The reinstall landed somewhere current did not already resolve to, so the link was never
    // pointing at a directory being replaced.
    const currentAfter = realpathSync(join(root, "prefix", "current"));
    assert.notEqual(currentAfter, currentBefore);
    assert.ok(existsSync(join(currentAfter, "INSTALL.json")));

    // Once current moved, the superseded copy is dropped so the next ordinary install cannot reuse
    // a stale payload under the canonical version directory.
    assert.ok(!existsSync(currentBefore), "the superseded payload must not survive the reinstall");
    assert.equal(readdirSync(join(root, "prefix", ".tmp")).length, 0, "no half-extracted payload may be left behind");

    const installed = spawnSync(join(root, "bin", binName), ["--version"], { encoding: "utf8" });
    assert.equal(installed.stdout.trim(), "0.0.2-staging.1.1");

    // A later ordinary install of the same version must still converge on a working payload.
    const again = await runInstaller({ baseUrl, root });
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.match(again.stdout, /already installed and up to date/);
  });
});

test("portable installer installs a newer release over a current one", { skip: platform === null }, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, requests, root }) => {
    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });
    assert.equal((await runInstaller({ baseUrl, root })).status, 0);

    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.2.1" });
    const upgrade = await runInstaller({ baseUrl, root });
    assert.equal(upgrade.status, 0, `${upgrade.stdout}\n${upgrade.stderr}`);
    assert.match(upgrade.stdout, /OpenTag 0\.0\.2-staging\.2\.1 installed at/);
    assert.equal(tarballRequests(requests, "0.0.2-staging.2.1"), 1);

    const installed = spawnSync(join(root, "bin", binName), ["--version"], { encoding: "utf8" });
    assert.equal(installed.stdout.trim(), "0.0.2-staging.2.1");
  });
});

test("portable installer repairs an install whose stable shim is missing", { skip: platform === null }, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, requests, root }) => {
    buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });
    assert.equal((await runInstaller({ baseUrl, root })).status, 0);

    await rm(join(root, "bin", binName), { force: true });
    const repair = await runInstaller({ baseUrl, root });
    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`);
    assert.match(repair.stdout, /OpenTag 0\.0\.2-staging\.1\.1 installed at/);
    assert.equal(
      tarballRequests(requests, "0.0.2-staging.1.1"),
      2,
      "a matching version with no working shim is not an up-to-date install",
    );
    assert.ok(existsSync(join(root, "bin", binName)));
  });
});

test("portable installer rejects a payload that fails its published checksum", {
  skip: platform === null,
}, async () => {
  await withReleaseServer(async ({ baseUrl, releaseRoot, root }) => {
    const { tarballPath } = buildRelease({ baseUrl, releaseRoot, version: "0.0.2-staging.1.1" });
    writeFileSync(tarballPath, Buffer.concat([readFileSync(tarballPath), Buffer.from("tampered")]));

    const result = await runInstaller({ baseUrl, root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch for portable payload/);
    assert.ok(!existsSync(join(root, "bin", binName)), "a rejected payload must not publish a shim");
  });
});
