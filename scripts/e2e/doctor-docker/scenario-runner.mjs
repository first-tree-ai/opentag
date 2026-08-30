#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const suite = process.argv[2] ?? "core";
const cli = "/opt/opentag/apps/cli/dist/cli/index.mjs";
const node = process.execPath;
const root = suite === "minimal" ? "/tmp/doctor-e2e" : "/home/node/doctor-e2e";
const runtimeBin = join(root, "runtime-bin");
const defaultPath = `${runtimeBin}:/usr/local/bin:/usr/bin:/bin`;
const computerId = "11111111-1111-4111-8111-111111111111";
const otherComputerId = "22222222-2222-4222-8222-222222222222";
const responseSecret = "doctor-e2e-response-secret";
const credentialSecret = "otmc_doctor-e2e-machine-token-secret";
const results = [];

function fail(message, result) {
  const diagnostics = result ? `\nexit: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : "";
  throw new Error(`${message}${diagnostics}`);
}

function expect(condition, message, result) {
  if (!condition) fail(message, result);
}

function expectIncludes(value, fragment, label, result) {
  expect(value.includes(fragment), `${label} is missing ${JSON.stringify(fragment)}`, result);
}

function expectExcludes(value, fragment, label, result) {
  expect(!value.includes(fragment), `${label} exposed ${JSON.stringify(fragment)}`, result);
}

async function record(name, operation) {
  const startedAt = performance.now();
  await operation();
  const elapsedMs = Math.round(performance.now() - startedAt);
  results.push({ elapsedMs, name, status: "PASS" });
  process.stdout.write(`PASS ${name} (${elapsedMs}ms)\n`);
}

function doctorEnvironment(home, options = {}) {
  return {
    ...process.env,
    HOME: options.userHome ?? process.env.HOME ?? "/home/node",
    OPENTAG_HOME: home,
    OPENTAG_SERVER_URL: "http://caller-controlled.invalid:65535",
    PATH: options.path ?? defaultPath,
    ...(options.shell ? { SHELL: options.shell } : {}),
    ...options.env,
  };
}

function runCli(home, arguments_, options = {}) {
  const result = spawnSync(node, [cli, ...arguments_], {
    encoding: "utf8",
    env: doctorEnvironment(home, options),
    timeout: options.timeoutMs ?? 25_000,
  });
  if (result.error) fail(`CLI process failed: ${result.error.message}`);
  return result;
}

function runDoctor(home, options = {}) {
  const result = runCli(home, ["doctor"], options);
  expect(result.signal === null, "doctor was terminated by a signal", result);
  expect(result.stderr === "", "doctor diagnostics were not stdout-only", result);
  expectIncludes(result.stdout, "OpenTag Doctor", "doctor report", result);
  expectIncludes(result.stdout, "Not evaluated", "doctor report", result);
  expectExcludes(result.stdout, credentialSecret, "doctor report", result);
  expectExcludes(result.stdout, "caller-controlled.invalid", "doctor report", result);
  return result;
}

async function resetRoot() {
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { mode: 0o700, recursive: true });
}

async function createHome(name) {
  const home = join(root, name);
  await mkdir(home, { mode: 0o700, recursive: true });
  return home;
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function enrollment({
  computer = computerId,
  serverUrl,
  workspaceComputerId = "33333333-3333-4333-8333-333333333333",
}) {
  return {
    workspaceComputerId,
    computerId: computer,
    machineToken: credentialSecret,
    serverUrl,
  };
}

async function writeValidHome(name, serverUrl, enrollments = [enrollment({ serverUrl })]) {
  const home = await createHome(name);
  const config = join(home, "config");
  await mkdir(config, { mode: 0o700 });
  await writePrivateJson(join(config, "computer.json"), { version: 2, computerId, serverUrl });
  await writePrivateJson(join(config, "computer-credentials.json"), { version: 1, enrollments });
  return home;
}

async function snapshot(path) {
  const entries = [];
  async function visit(current, relative) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      entries.push({ kind: "symlink", mode: metadata.mode & 0o777, path: relative, target: await readlink(current) });
      return;
    }
    if (metadata.isDirectory()) {
      entries.push({ kind: "directory", mode: metadata.mode & 0o777, path: relative });
      for (const child of (await readdir(current)).sort()) await visit(join(current, child), join(relative, child));
      return;
    }
    const content = await readFile(current);
    entries.push({
      hash: createHash("sha256").update(content).digest("hex"),
      kind: "file",
      mode: metadata.mode & 0o777,
      path: relative,
      size: content.length,
    });
  }
  await visit(path, ".");
  return JSON.stringify(entries);
}

async function requestCount(port) {
  const response = await fetch(`http://127.0.0.1:${port}/__count`);
  expect(response.ok, `could not read request count from port ${port}`);
  return (await response.json()).count;
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function installRuntimeFixture(name) {
  await mkdir(runtimeBin, { mode: 0o700, recursive: true });
  const path = join(runtimeBin, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function runMinimalSuite() {
  const home = await createHome("manager-missing");
  await record("linux manager missing fails closed", async () => {
    const result = runDoctor(home, { path: "/usr/local/bin:/usr/bin:/bin" });
    expect(result.status === 1, "manager-missing doctor must exit 1", result);
    expectIncludes(
      result.stdout,
      "systemctl service manager is unavailable at supported system locations",
      "daemon result",
      result,
    );
  });
}

async function runCoreSuite() {
  await installRuntimeFixture("codex");
  await waitForHttp("http://127.0.0.1:18080/healthz");
  await waitForHttp("http://127.0.0.1:8000/healthz", 60_000);

  await record("empty Home remains byte-for-byte untouched", async () => {
    const home = await createHome("empty-home");
    const before = await snapshot(home);
    const result = runDoctor(home);
    expect(result.status === 1, "empty Home doctor must exit 1", result);
    expectIncludes(result.stdout, "Computer identity is not configured", "local result", result);
    expectIncludes(
      result.stdout,
      "not checked because there is no authoritative enrolled Server",
      "server result",
      result,
    );
    expect((await snapshot(home)) === before, "doctor mutated the empty Home", result);
  });

  await record("malformed identity fails closed without content disclosure", async () => {
    const home = await createHome("malformed-identity");
    const config = join(home, "config");
    await mkdir(config, { mode: 0o700 });
    await writePrivateJson(join(config, "computer.json"), {
      version: 2,
      computerId,
      serverUrl: "http://127.0.0.1:18080",
      secret: responseSecret,
    });
    await writePrivateJson(join(config, "computer-credentials.json"), {
      version: 1,
      enrollments: [enrollment({ serverUrl: "http://127.0.0.1:18080" })],
    });
    const result = runDoctor(home);
    expectIncludes(result.stdout, "identity file is invalid", "identity result", result);
    expectExcludes(result.stdout, responseSecret, "identity result", result);
  });

  await record("one malformed enrollment invalidates the full credential set", async () => {
    const serverUrl = "http://127.0.0.1:18080";
    const before = await requestCount(18080);
    const home = await writeValidHome("malformed-enrollment", serverUrl, [
      enrollment({ serverUrl }),
      { workspaceComputerId: "not-a-uuid", machineToken: responseSecret, computerId, serverUrl },
    ]);
    const result = runDoctor(home);
    expectIncludes(result.stdout, "unusable OpenTag Computer credential", "enrollment result", result);
    expectExcludes(result.stdout, responseSecret, "enrollment result", result);
    expect((await requestCount(18080)) === before, "doctor contacted Server for malformed credentials");
  });

  await record("multiple enrolled Server origins receive zero requests", async () => {
    const first = "http://127.0.0.1:18081";
    const second = "http://127.0.0.1:18082";
    const beforeA = await requestCount(18081);
    const beforeB = await requestCount(18082);
    const home = await writeValidHome("multiple-servers", first, [
      enrollment({ serverUrl: first }),
      enrollment({
        serverUrl: second,
        workspaceComputerId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
    const result = runDoctor(home);
    expectIncludes(result.stdout, "multiple enrollments", "binding result", result);
    expect((await requestCount(18081)) === beforeA, "doctor contacted the first ambiguous Server");
    expect((await requestCount(18082)) === beforeB, "doctor contacted the second ambiguous Server");
  });

  await record("Computer mismatch skips the enrolled Server", async () => {
    const serverUrl = "http://127.0.0.1:18081";
    const before = await requestCount(18081);
    const home = await writeValidHome("computer-mismatch", serverUrl, [
      enrollment({ computer: otherComputerId, serverUrl }),
    ]);
    const result = runDoctor(home);
    expectIncludes(result.stdout, "do not belong to the local Computer identity", "binding result", result);
    expect((await requestCount(18081)) === before, "doctor contacted Server after Computer mismatch");
  });

  await record("symlinked private config is rejected without target disclosure", async () => {
    const home = await createHome("unsafe-symlink");
    const outside = join(root, "outside-config");
    await mkdir(outside, { mode: 0o700 });
    await writePrivateJson(join(outside, "computer.json"), { secret: responseSecret });
    await symlink(outside, join(home, "config"));
    const result = runDoctor(home);
    expect(result.status === 1, "unsafe symlink doctor must exit 1", result);
    expectExcludes(result.stdout, responseSecret, "symlink result", result);
    expectIncludes(
      result.stdout,
      "not checked because there is no authoritative enrolled Server",
      "server result",
      result,
    );
  });

  await record("HTTP 503 is classified without response-body disclosure", async () => {
    const home = await writeValidHome("http-503", "http://127.0.0.1:18083");
    const result = runDoctor(home);
    expectIncludes(result.stdout, "returned HTTP 503", "server result", result);
    expectExcludes(result.stdout, responseSecret, "server result", result);
  });

  await record("invalid health schema is classified without body disclosure", async () => {
    const home = await writeValidHome("invalid-schema", "http://127.0.0.1:18084");
    const result = runDoctor(home);
    expectIncludes(result.stdout, "returned an invalid health response", "server result", result);
    expectExcludes(result.stdout, responseSecret, "server result", result);
  });

  await record("hanging health response reaches the real five-second deadline", async () => {
    const home = await writeValidHome("health-timeout", "http://127.0.0.1:18085");
    const startedAt = performance.now();
    const result = runDoctor(home, { timeoutMs: 10_000 });
    const elapsedMs = performance.now() - startedAt;
    expectIncludes(result.stdout, "timed out while reaching", "server result", result);
    expect(elapsedMs >= 4_750 && elapsedMs <= 7_000, `deadline elapsed in ${Math.round(elapsedMs)}ms`, result);
  });

  await record("connection refusal is classified as a network failure", async () => {
    const home = await writeValidHome("network-refused", "http://127.0.0.1:9");
    const result = runDoctor(home);
    expectIncludes(result.stdout, "could not reach http://127.0.0.1:9", "server result", result);
  });

  await record("real OpenTag Server container passes the public health check", async () => {
    const home = await writeValidHome("real-server", "http://127.0.0.1:8000");
    const result = runDoctor(home);
    expectIncludes(
      result.stdout,
      "Server health endpoint: reachable at http://127.0.0.1:8000",
      "server result",
      result,
    );
  });

  await record("Runtime detection uses a real executable artifact", async () => {
    const home = await createHome("runtime-executable");
    const result = runDoctor(home);
    expectIncludes(
      result.stdout,
      "Agent Runtime CLI: at least one supported Runtime is installed",
      "runtime result",
      result,
    );
    expectIncludes(
      result.stdout,
      `Codex CLI: installed at ${join(runtimeBin, "codex")} (caller-path)`,
      "runtime result",
      result,
    );
  });

  await record("login-shell-only Runtime artifact is reported as login-shell", async () => {
    const userHome = join(root, "login-shell-home");
    const loginBin = join(userHome, "login-bin");
    await mkdir(loginBin, { mode: 0o700, recursive: true });
    const executable = join(loginBin, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    const exportLine = `export PATH="${loginBin}:$PATH"
`;
    await writeFile(join(userHome, ".bash_profile"), exportLine, { mode: 0o644 });
    await writeFile(join(userHome, ".bashrc"), exportLine, { mode: 0o644 });
    await writeFile(join(userHome, ".profile"), exportLine, { mode: 0o644 });
    const home = await createHome("runtime-login-shell");
    const result = runDoctor(home, {
      path: "/usr/bin:/bin",
      shell: "/bin/bash",
      userHome,
    });
    expectIncludes(
      result.stdout,
      "Agent Runtime CLI: at least one supported Runtime is installed",
      "runtime result",
      result,
    );
    expectIncludes(result.stdout, `${executable} (login-shell)`, "runtime result", result);
  });

  await record("executable directory is not a Runtime artifact", async () => {
    const path = join(root, "directory-runtime-bin");
    await mkdir(join(path, "codex"), { mode: 0o755, recursive: true });
    const home = await createHome("runtime-directory");
    const result = runDoctor(home, { path: `${path}:/usr/local/bin:/usr/bin:/bin` });
    expectIncludes(result.stdout, "Agent Runtime CLI: no supported Runtime is installed", "runtime result", result);
    expectIncludes(result.stdout, "Codex CLI: not installed", "runtime result", result);
  });

  await record("broken Runtime symlink is not an installed artifact", async () => {
    const path = join(root, "broken-runtime-bin");
    await mkdir(path, { mode: 0o700 });
    await symlink(join(path, "missing-target"), join(path, "codex"));
    const home = await createHome("runtime-broken-link");
    const result = runDoctor(home, { path: `${path}:/usr/local/bin:/usr/bin:/bin` });
    expectIncludes(result.stdout, "Agent Runtime CLI: no supported Runtime is installed", "runtime result", result);
  });

  await record("caller PATH cannot shadow the governed systemctl", async () => {
    const path = join(root, "shadow-bin");
    const marker = join(root, "shadow-systemctl-invoked");
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "systemctl"), `#!/bin/sh\ntouch ${marker}\nexit 0\n`, { mode: 0o755 });
    const home = await createHome("systemctl-shadow");
    runDoctor(home, { path: `${path}:/usr/local/bin:/usr/bin:/bin` });
    await expectMissing(marker, "PATH-shadowed systemctl was executed");
  });

  const baselineHome = await writeValidHome("systemd-baseline", "http://127.0.0.1:18086");
  await record("real systemd user service produces a fully passing P0 baseline", async () => {
    const install = runCli(baselineHome, ["daemon", "install"]);
    expect(install.status === 0, "daemon install failed in the systemd container", install);
    const result = await waitForDoctor(baselineHome, (candidate) => candidate.status === 0, 30_000);
    expectIncludes(result.stdout, "Daemon service: active for this OpenTag Home", "daemon result", result);
    expectIncludes(result.stdout, "Baseline checks passed for this OpenTag Home.", "summary", result);
  });

  await record("active service bound to another Home fails closed", async () => {
    const otherHome = await writeValidHome("systemd-other-home", "http://127.0.0.1:18086");
    const result = runDoctor(otherHome);
    expectIncludes(result.stdout, "active for a different or unverifiable OpenTag Home", "daemon result", result);
  });

  const unitPath = join(process.env.HOME ?? "/home/node", ".config/systemd/user/opentag-dev.service");
  const originalUnit = await readFile(unitPath, "utf8");
  await record("drifted live systemd definition fails closed", async () => {
    await writeFile(unitPath, `${originalUnit}\n# doctor-e2e-drift\n`, { mode: 0o644 });
    const result = runDoctor(baselineHome);
    expectIncludes(result.stdout, "service definition is drifted or unverifiable", "daemon result", result);
    await writeFile(unitPath, originalUnit, { mode: 0o644 });
  });

  await record("malformed live systemd definition is unknown", async () => {
    await writeFile(unitPath, originalUnit.replace(/^Environment="OPENTAG_HOME=.*"$/mu, ""), { mode: 0o644 });
    const result = runDoctor(baselineHome);
    expectIncludes(
      result.stdout,
      "installed systemd unit does not contain a valid OPENTAG_HOME",
      "daemon result",
      result,
    );
    await writeFile(unitPath, originalUnit, { mode: 0o644 });
  });

  await record("stopped real systemd service is reported inactive", async () => {
    const stop = runCli(baselineHome, ["daemon", "stop"]);
    expect(stop.status === 0, "daemon stop failed in the systemd container", stop);
    const result = runDoctor(baselineHome);
    expectIncludes(result.stdout, "Daemon service: inactive", "daemon result", result);
  });

  const uninstall = runCli(baselineHome, ["daemon", "uninstall"]);
  expect(uninstall.status === 0, "daemon uninstall cleanup failed in the systemd container", uninstall);
}

async function runIssue239Suite() {
  const accountCode = (await readStandardInput()).trim();
  expect(accountCode.length > 0, "issue #239 suite did not receive an Account login code");
  await installRuntimeFixture("codex");
  await waitForHttp("http://127.0.0.1:8000/healthz", 60_000);

  const serverUrl = "http://127.0.0.1:8000";
  const home = await createHome("issue-239-home");
  const shellXdgConfigHome = await createHome("issue-239-shell-xdg");
  const shellHome = await createHome("issue-239-shell-home");
  const login = runCli(home, ["login", "--server", serverUrl, "--", accountCode]);
  expect(login.status === 0, "Account login failed in the issue #239 suite", login);
  const credentials = JSON.parse(await readFile(join(home, "config", "credentials.json"), "utf8"));

  await record("formal Computer connect flow passes doctor", async () => {
    const code = await issueComputerConnectCode(serverUrl, credentials.accessToken);
    const connect = runCli(home, ["computer", "connect", "--server", serverUrl, "--", code]);
    expect(connect.status === 0, "computer connect failed in the issue #239 suite", connect);
    expectIncludes(connect.stdout, "Daemon service opentag-dev is active", "computer connect result", connect);
    const result = await waitForDoctor(home, (candidate) => candidate.status === 0, 30_000);
    expectIncludes(result.stdout, "Baseline checks passed for this OpenTag Home.", "doctor result", result);
    await waitForComputerOnline(serverUrl, credentials.accessToken, 30_000);
  });

  await record("shell XDG_CONFIG_HOME cannot redirect doctor service lookup", async () => {
    const result = runDoctor(home, { env: { XDG_CONFIG_HOME: shellXdgConfigHome } });
    expect(result.status === 0, "doctor failed after only XDG_CONFIG_HOME changed", result);
    expectIncludes(result.stdout, "Daemon service: active for this OpenTag Home", "daemon result", result);
    await expectMissing(
      join(shellXdgConfigHome, "systemd", "user", "opentag-dev.service"),
      "doctor created or selected a shell-XDG service definition",
    );
  });

  await record("shell HOME cannot redirect doctor service lookup", async () => {
    const result = runDoctor(home, { env: { HOME: shellHome } });
    expect(result.status === 0, "doctor failed after only HOME changed", result);
    expectIncludes(result.stdout, "Daemon service: active for this OpenTag Home", "daemon result", result);
    await expectMissing(
      join(shellHome, ".config", "systemd", "user", "opentag-dev.service"),
      "doctor created or selected a shell-HOME service definition",
    );
  });

  await record("connect and doctor agree under the same custom XDG environment", async () => {
    const code = await issueComputerConnectCode(serverUrl, credentials.accessToken);
    const environment = { XDG_CONFIG_HOME: shellXdgConfigHome };
    const connect = runCli(home, ["computer", "connect", "--server", serverUrl, "--", code], {
      env: environment,
    });
    expect(connect.status === 0, "computer reconnect failed under custom XDG_CONFIG_HOME", connect);
    const result = await waitForDoctor(home, (candidate) => candidate.status === 0, 30_000, { env: environment });
    expectIncludes(result.stdout, "Daemon service: active for this OpenTag Home", "daemon result", result);
    const fragment = runSystemctl(["show", "opentag-dev.service", "--property", "FragmentPath", "--value"]);
    expect(fragment.status === 0, "systemd FragmentPath query failed", fragment);
    expect(
      fragment.stdout.trim() === "/home/node/.config/systemd/user/opentag-dev.service",
      `systemd loaded an unexpected definition: ${fragment.stdout.trim() || "<empty>"}`,
      fragment,
    );
    await waitForComputerOnline(serverUrl, credentials.accessToken, 30_000);
  });

  const uninstall = runCli(home, ["daemon", "uninstall"]);
  expect(uninstall.status === 0, "issue #239 daemon cleanup failed", uninstall);
}

async function readStandardInput() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function issueComputerConnectCode(serverUrl, accessToken) {
  const response = await fetch(`${serverUrl}/api/v1/computer-connect-codes`, {
    body: "{}",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status === 201, `Computer connect-code issuance returned HTTP ${response.status}`);
  const payload = await response.json();
  const match = /computer connect --server\s+'?([^\s']+)'?\s+--\s+'?([A-Za-z0-9_-]+)'?/.exec(
    payload.bootstrapCommand ?? "",
  );
  expect(match?.[1] === serverUrl && match[2], "Computer connect-code response was invalid");
  return match[2];
}

async function waitForComputerOnline(serverUrl, accessToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    const response = await fetch(`${serverUrl}/api/v1/computers`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    lastStatus = response.status;
    if (response.ok) {
      const payload = await response.json();
      if (payload.computers?.some((computer) => computer.connectionStatus === "online")) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Computer did not become online within ${timeoutMs}ms (last HTTP status ${lastStatus ?? "none"})`);
}

function runSystemctl(arguments_) {
  const result = spawnSync("/usr/bin/systemctl", ["--user", ...arguments_], {
    encoding: "utf8",
    env: doctorEnvironment("/home/node/doctor-e2e/issue-239-home"),
    timeout: 15_000,
  });
  if (result.error) fail(`systemctl process failed: ${result.error.message}`);
  return result;
}

async function expectMissing(path, message) {
  try {
    await access(path);
    throw new Error(message);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function waitForDoctor(home, predicate, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = runDoctor(home, options);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`doctor did not reach the expected state within ${timeoutMs}ms`, last);
}

async function main() {
  await resetRoot();
  if (suite === "minimal") await runMinimalSuite();
  else if (suite === "core") await runCoreSuite();
  else if (suite === "issue-239") await runIssue239Suite();
  else throw new Error(`unknown suite: ${suite}`);
  process.stdout.write(`RESULT ${results.length}/${results.length} Docker doctor scenarios passed\n`);
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
