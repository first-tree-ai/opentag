import { spawn } from "node:child_process";
import { chmod, cp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  type ProviderCliSelectionRecord,
  ProviderCliTurnPlanManager,
  type ProviderCliTurnPlanManagerDeps,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../../index.js";
import { makeTempDir } from "./provider-cli.js";

const TARGET_SOURCE = fileURLToPath(new URL("./provider-cli-turn-target.mjs", import.meta.url));
const TSX_LOADER = fileURLToPath(new URL("../../../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
const RUNNER_MODULE = fileURLToPath(new URL("./provider-cli-turn-runner-entry.ts", import.meta.url));

export function providerCliTurnRunnerInvocation(): readonly string[] {
  return [process.execPath, "--import", pathToFileURL(TSX_LOADER).href, RUNNER_MODULE];
}

export async function makeTurnPlanHarness(overrides: Partial<ProviderCliTurnPlanManagerDeps> = {}): Promise<{
  accountHome: string;
  openTagHome: string;
  layout: ReturnType<typeof resolveProviderCliAccountLayout>;
  manager: ProviderCliTurnPlanManager;
}> {
  const accountHome = await makeTempDir("opentag-turn-plan-account-");
  const openTagHome = await makeTempDir("opentag-turn-plan-home-");
  const layout = resolveProviderCliAccountLayout(accountHome);
  const manager = new ProviderCliTurnPlanManager({
    accountHome,
    openTagHome,
    runnerInvocation: providerCliTurnRunnerInvocation(),
    ...overrides,
  });
  return { accountHome, openTagHome, layout, manager };
}

export async function installTurnTarget(directory: string, name = "lark-cli"): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, name);
  await cp(TARGET_SOURCE, target);
  await chmod(target, 0o755);
  return realpath(target);
}

export async function writeExternalTurnSelection(
  layout: ReturnType<typeof resolveProviderCliAccountLayout>,
  provider: "feishu" | "slack",
  targetPath: string,
  version = "1.0.92",
): Promise<ProviderCliSelectionRecord> {
  const identity = await computeFileIdentity(targetPath);
  return writeProviderCliSelection(
    layout,
    provider,
    {
      kind: "external",
      executablePath: identity.path,
      fingerprint: computeTargetFingerprint(identity, version),
      trust: "compatible-unverified",
      version,
    },
    undefined,
  );
}

export async function writeManagedTurnSelection(
  layout: ReturnType<typeof resolveProviderCliAccountLayout>,
  provider: "feishu" | "slack",
  targetPath: string,
  version = "1.0.92",
  digest = "aa".repeat(32),
): Promise<string> {
  const identity = await computeFileIdentity(targetPath);
  const artifactId = `${version}/test-platform/${digest}`;
  await writeProviderCliSelection(
    layout,
    provider,
    {
      kind: "managed",
      artifactId,
      version,
      targetPath: identity.path,
      fingerprint: computeTargetFingerprint(identity, version, digest),
    },
    undefined,
  );
  return artifactId;
}

export function runTurnLauncher(
  launcherPath: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcherPath, [...args], {
      env: options.env ?? { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export async function makePrivateSlackConfigDir(parent: string, name = "slack-config"): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return realpath(directory);
}
