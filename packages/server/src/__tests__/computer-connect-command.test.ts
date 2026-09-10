import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildComputerConnectCommand } from "../services/computers/machine-auth-service.js";

const DOWNLOAD_BASE_URL = "https://download.opentag.invalid/releases";
const CODE = "otcc_testcode";
const CHANNELS = [
  { environment: "prod" as const, binName: "opentag", publicUrl: "https://opentag.invalid" },
  { environment: "staging" as const, binName: "opentag-staging", publicUrl: "https://staging.opentag.invalid" },
];

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildComputerConnectCommand", () => {
  it.each(CHANNELS)("chains mktemp, curl -fsSL to a file, sh, then $binName connect for $environment", (channel) => {
    const command = releasedCommand(channel);
    const installerUrl = releasedInstallerUrl(channel.environment);
    expect(command).toBe(
      `opentag_installer="$(mktemp)" && curl -fsSL ${installerUrl} -o "$opentag_installer"` +
        ` && sh "$opentag_installer"` +
        ` && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/${channel.binName}" connect` +
        ` --server ${channel.publicUrl} -- ${CODE}`,
    );
    expect(command).not.toMatch(/(?:^|[\s;|&])rm(?:\s|$)/);
    expect(command).not.toMatch(/\btrap\b/);
    expect(command).not.toContain("|");
  });

  it("keeps the dev variant on the local install script", () => {
    const command = buildComputerConnectCommand({
      code: CODE,
      downloadBaseUrl: DOWNLOAD_BASE_URL,
      environment: "dev",
      publicUrl: "http://127.0.0.1:8000",
    });
    expect(command).toBe(
      `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" connect --server http://127.0.0.1:8000 -- ${CODE}`,
    );
    expect(command).not.toContain("mktemp");
    expect(command).not.toContain("curl");
    expect(command).not.toMatch(/(?:^|[\s;|&])rm(?:\s|$)/);
  });

  it("quotes an unsafe connect code without changing the install chain", () => {
    const command = buildComputerConnectCommand({
      code: "a'; echo nope",
      downloadBaseUrl: DOWNLOAD_BASE_URL,
      environment: "prod",
      publicUrl: "https://example.com/a b",
    });
    expect(command).toContain("'a'\\''; echo nope'");
    expect(command.startsWith('opentag_installer="$(mktemp)" && curl -fsSL ')).toBe(true);
    expect(command).not.toMatch(/(?:^|[\s;|&])rm(?:\s|$)/);
  });

  it("admits the generated command to a synthetic rm -f preflight that rejects the previous deletion chain", () => {
    // Synthetic fixture only: not a real target Agent, Cursor, or Codex execution-tool policy.
    const previousWithDeletion =
      `opentag_installer="$(mktemp)" && curl -fsSL https://download.opentag.invalid/releases/prod/install.sh -o "$opentag_installer"` +
      ` && sh "$opentag_installer" && rm -f "$opentag_installer"` +
      ` && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag" connect --server https://opentag.invalid -- ${CODE}`;
    expect(syntheticRmDashFPreflightAdmits(previousWithDeletion)).toBe(false);
    for (const channel of CHANNELS) {
      expect(syntheticRmDashFPreflightAdmits(releasedCommand(channel))).toBe(true);
    }
  });
});

describe("generated Computer connect command shell execution", () => {
  it.each(CHANNELS)(
    "installs and connects with the new $binName for $environment, leaving the installer in TMPDIR",
    async (channel) => {
      const sandbox = await createSandbox({
        binName: channel.binName,
        installerUrl: releasedInstallerUrl(channel.environment),
      });
      const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(await readEventLog(sandbox.eventLog)).toEqual([
        "mktemp",
        "curl",
        "install",
        `new-connect connect --server ${channel.publicUrl} -- ${CODE}`,
      ]);
      expect(await readdir(sandbox.tmp)).not.toEqual([]);
    },
  );

  it.each(CHANNELS)("does not use the preexisting $binName when mktemp fails for $environment", async (channel) => {
    const sandbox = await createSandbox({
      binName: channel.binName,
      installerUrl: releasedInstallerUrl(channel.environment),
      mktempFail: true,
    });
    const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
    expect(result.status).not.toBe(0);
    expect(await readEventLog(sandbox.eventLog)).toEqual(["mktemp"]);
  });

  it.each(CHANNELS)("does not use the preexisting $binName when download fails for $environment", async (channel) => {
    const sandbox = await createSandbox({
      binName: channel.binName,
      curlMode: "fail",
      installerUrl: releasedInstallerUrl(channel.environment),
    });
    const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
    expect(result.status).toBe(22);
    expect(await readEventLog(sandbox.eventLog)).toEqual(["mktemp", "curl"]);
  });

  it.each(CHANNELS)(
    "does not run a partial executable download or the preexisting $binName for $environment",
    async (channel) => {
      const sandbox = await createSandbox({
        binName: channel.binName,
        curlMode: "partial",
        installerUrl: releasedInstallerUrl(channel.environment),
      });
      const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
      expect(result.status).toBe(22);
      expect(await readEventLog(sandbox.eventLog)).toEqual(["mktemp", "curl"]);
    },
  );

  it.each(CHANNELS)(
    "does not use the preexisting $binName when installation fails for $environment",
    async (channel) => {
      const sandbox = await createSandbox({
        binName: channel.binName,
        installFail: true,
        installerUrl: releasedInstallerUrl(channel.environment),
      });
      const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
      expect(result.status).not.toBe(0);
      expect(await readEventLog(sandbox.eventLog)).toEqual(["mktemp", "curl", "install"]);
    },
  );

  it.each(CHANNELS)("still connects for $environment when rm is unavailable", async (channel) => {
    const sandbox = await createSandbox({
      binName: channel.binName,
      installerUrl: releasedInstallerUrl(channel.environment),
      rm: "unavailable",
    });
    const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
    expect(result.status, result.stderr).toBe(0);
    expect(await readEventLog(sandbox.eventLog)).toEqual([
      "mktemp",
      "curl",
      "install",
      `new-connect connect --server ${channel.publicUrl} -- ${CODE}`,
    ]);
  });

  it.each(CHANNELS)("still connects for $environment when rm fails", async (channel) => {
    const sandbox = await createSandbox({
      binName: channel.binName,
      installerUrl: releasedInstallerUrl(channel.environment),
      rm: "fail",
    });
    const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
    expect(result.status, result.stderr).toBe(0);
    expect(await readEventLog(sandbox.eventLog)).toEqual([
      "mktemp",
      "curl",
      "install",
      `new-connect connect --server ${channel.publicUrl} -- ${CODE}`,
    ]);
  });

  it.each(CHANNELS)("propagates a nonzero $binName connect status for $environment", async (channel) => {
    const sandbox = await createSandbox({
      binName: channel.binName,
      connectExit: 9,
      installerUrl: releasedInstallerUrl(channel.environment),
    });
    const result = runGeneratedCommand(releasedCommand(channel), sandbox.env);
    expect(result.status).toBe(9);
    expect(await readEventLog(sandbox.eventLog)).toEqual([
      "mktemp",
      "curl",
      "install",
      `new-connect connect --server ${channel.publicUrl} -- ${CODE}`,
    ]);
  });
});

function releasedInstallerUrl(environment: "prod" | "staging"): string {
  return `${DOWNLOAD_BASE_URL}/${environment}/install.sh`;
}

function releasedCommand(channel: (typeof CHANNELS)[number]): string {
  return buildComputerConnectCommand({
    code: CODE,
    downloadBaseUrl: DOWNLOAD_BASE_URL,
    environment: channel.environment,
    publicUrl: channel.publicUrl,
  });
}

/**
 * Narrow stand-in for an execution-tool preflight that refuses explicit `rm -f`.
 * This is not a real target Agent acceptance check.
 */
function syntheticRmDashFPreflightAdmits(command: string): boolean {
  return !/(?:^|[\s;|&])rm\s+-f(?:\s|$)/.test(command);
}

function runGeneratedCommand(command: string, env: Record<string, string>) {
  return spawnSync("/bin/sh", ["-c", command], {
    cwd: env.HOME,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

async function createSandbox(input: {
  binName: string;
  installerUrl: string;
  curlMode?: "success" | "fail" | "partial";
  mktempFail?: boolean;
  installFail?: boolean;
  connectExit?: number;
  rm?: "fail" | "unavailable";
}): Promise<{ env: Record<string, string>; eventLog: string; tmp: string }> {
  const root = await mkdtemp(join(tmpdir(), "opentag-connect-cmd-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const stubBin = join(root, "stub-bin");
  const tools = join(root, "tools");
  const fixtures = join(root, "fixtures");
  const eventLog = join(root, "events.log");
  const localBin = join(home, ".local", "bin");
  await Promise.all([mkdir(tmp), mkdir(stubBin), mkdir(tools), mkdir(fixtures), mkdir(localBin, { recursive: true })]);
  await Promise.all(["sh", "mkdir", "cat", "chmod"].map(async (name) => symlink(resolveTool(name), join(tools, name))));
  await writeExecutable(
    join(stubBin, "mktemp"),
    `#!/bin/sh
printf '%s\\n' mktemp >> "$OPENTAG_TEST_EVENT_LOG"
if [ "\${OPENTAG_TEST_MKTEMP_FAIL:-}" = "1" ]; then
  exit 1
fi
file="\${TMPDIR%/}/opentag-installer-$$"
i=0
while [ -e "$file" ]; do
  i=$((i + 1))
  file="\${TMPDIR%/}/opentag-installer-$$.$i"
done
: > "$file"
printf '%s\\n' "$file"
`,
  );
  await writeExecutable(
    join(stubBin, "curl"),
    `#!/bin/sh
printf '%s\\n' curl >> "$OPENTAG_TEST_EVENT_LOG"
fs_sl=0
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -fsSL)
      fs_sl=1
      shift
      ;;
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      exit 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [ "$fs_sl" -ne 1 ] || [ -z "$out" ] || [ -z "$url" ]; then
  exit 2
fi
if [ "$url" != "$OPENTAG_TEST_INSTALLER_URL" ]; then
  printf '%s\\n' "unexpected-url $url" >> "$OPENTAG_TEST_EVENT_LOG"
  exit 3
fi
mode="\${OPENTAG_TEST_CURL_MODE:-success}"
if [ "$mode" = "fail" ]; then
  exit 22
fi
if [ "$mode" = "partial" ]; then
  cat "$OPENTAG_TEST_PARTIAL_INSTALLER" > "$out"
  exit 22
fi
cat "$OPENTAG_TEST_INSTALLER" > "$out"
exit 0
`,
  );
  if (input.rm === "fail") {
    await writeExecutable(
      join(stubBin, "rm"),
      `#!/bin/sh
printf '%s\\n' "rm $*" >> "$OPENTAG_TEST_EVENT_LOG"
exit 1
`,
    );
  }
  await writeFile(
    join(fixtures, "installer.sh"),
    `#!/bin/sh
printf '%s\\n' install >> "$OPENTAG_TEST_EVENT_LOG"
if [ "\${OPENTAG_TEST_INSTALL_FAIL:-}" = "1" ]; then
  exit 1
fi
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/$OPENTAG_TEST_BIN_NAME" <<'BIN'
#!/bin/sh
printf '%s\\n' "new-connect $*" >> "$OPENTAG_TEST_EVENT_LOG"
exit "\${OPENTAG_TEST_CONNECT_EXIT:-0}"
BIN
chmod +x "$HOME/.local/bin/$OPENTAG_TEST_BIN_NAME"
`,
    { mode: 0o644 },
  );
  await writeFile(
    join(fixtures, "partial-installer.sh"),
    `#!/bin/sh
printf '%s\\n' partial-installer >> "$OPENTAG_TEST_EVENT_LOG"
exit 0
`,
    { mode: 0o755 },
  );
  await writeExecutable(
    join(localBin, input.binName),
    `#!/bin/sh
printf '%s\\n' "old-connect $*" >> "$OPENTAG_TEST_EVENT_LOG"
exit 0
`,
  );
  const env: Record<string, string> = {
    HOME: home,
    OPENTAG_TEST_BIN_NAME: input.binName,
    OPENTAG_TEST_CURL_MODE: input.curlMode ?? "success",
    OPENTAG_TEST_EVENT_LOG: eventLog,
    OPENTAG_TEST_INSTALLER: join(fixtures, "installer.sh"),
    OPENTAG_TEST_INSTALLER_URL: input.installerUrl,
    OPENTAG_TEST_PARTIAL_INSTALLER: join(fixtures, "partial-installer.sh"),
    PATH: `${stubBin}:${tools}`,
    TMPDIR: tmp,
  };
  if (input.mktempFail) env.OPENTAG_TEST_MKTEMP_FAIL = "1";
  if (input.installFail) env.OPENTAG_TEST_INSTALL_FAIL = "1";
  if (input.connectExit !== undefined) env.OPENTAG_TEST_CONNECT_EXIT = String(input.connectExit);
  return { env, eventLog, tmp };
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

function resolveTool(name: string): string {
  for (const dir of ["/bin", "/usr/bin"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`missing ${name} for the Computer connect command sandbox`);
}

async function readEventLog(eventLog: string): Promise<string[]> {
  try {
    const contents = await readFile(eventLog, "utf8");
    return contents.trim() === "" ? [] : contents.trim().split("\n");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
