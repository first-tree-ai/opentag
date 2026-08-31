import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePrivateDirectory } from "../../storage/durable-file.js";
import { resolveAccountHome, resolveProviderCliAccountLayout } from "./account-layout.js";
import { PROVIDER_CLI_CATALOG, type ProviderCliCatalogEntry, requireProviderCliCatalogEntry } from "./catalog.js";
import { computeFileIdentity, computeTargetFingerprint, ProviderCliFileError } from "./fingerprint.js";
import {
  assertPlanWithinRoot,
  deriveProviderCliSessionKey,
  isProviderCliHomeNamespace,
  isProviderCliSessionKey,
  managedArtifactDigest,
  type ProviderCliTurnPlan,
  ProviderCliTurnPlanError,
  readProviderCliTurnPlan,
} from "./turn-plan.js";
import type { ProviderCliProvider } from "./types.js";

export interface ProviderCliTurnRunnerArgv {
  readonly planPath: string;
  readonly provider: ProviderCliProvider;
  readonly runId: string;
  readonly userArgv: readonly string[];
}

export interface ExecuteProviderCliTurnPlanOptions {
  readonly planPath: string;
  readonly provider: ProviderCliProvider;
  readonly runId: string;
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly catalog?: readonly ProviderCliCatalogEntry[];
  /** Test/composition override. The standalone runner derives this from the OS account record. */
  readonly plansRoot?: string;
  readonly spawnTarget?: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<number>;
}

export function parseProviderCliTurnRunnerArgv(argv: readonly string[]): ProviderCliTurnRunnerArgv {
  if (argv[0] !== "--plan" || argv[2] !== "--provider" || argv[4] !== "--run-id" || argv[6] !== "--") {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn runner fence is malformed");
  }
  const planPath = argv[1];
  const provider = argv[3];
  const runId = argv[5];
  if (planPath === undefined || provider === undefined || runId === undefined) {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn runner fence is incomplete");
  }
  if (provider !== "feishu" && provider !== "slack") {
    throw new ProviderCliTurnPlanError("provider_mismatch", "Provider CLI Turn runner provider is unknown");
  }
  if (!isAbsolute(planPath)) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan path must be absolute");
  }
  if (runId.length === 0) {
    throw new ProviderCliTurnPlanError("run_mismatch", "Provider CLI Turn runner run is missing");
  }
  return { planPath, provider, runId, userArgv: argv.slice(7) };
}

export async function loadProviderCliTurnPlanForRun(options: {
  readonly planPath: string;
  readonly provider: ProviderCliProvider;
  readonly runId: string;
  readonly plansRoot?: string;
}): Promise<ProviderCliTurnPlan> {
  const plansRoot = options.plansRoot ?? resolveProviderCliAccountLayout(resolveAccountHome()).plans;
  const location = await validateTurnPlanLocation(plansRoot, options.planPath);
  const plan = await readProviderCliTurnPlan(options.planPath);
  if (!plan) throw new ProviderCliTurnPlanError("plan_missing", "Provider CLI Turn plan is missing");
  if (plan.homeNamespace !== location.homeNamespace) {
    throw new ProviderCliTurnPlanError("home_mismatch", "Provider CLI Turn plan is outside its Home namespace");
  }
  if (deriveProviderCliSessionKey(plan.sessionId) !== location.sessionKey) {
    throw new ProviderCliTurnPlanError("session_mismatch", "Provider CLI Turn plan is outside its Session namespace");
  }
  if (plan.provider !== options.provider) {
    throw new ProviderCliTurnPlanError("provider_mismatch", "Provider CLI Turn plan provider does not match the fence");
  }
  if (plan.runId !== options.runId) {
    throw new ProviderCliTurnPlanError("run_mismatch", "Provider CLI Turn plan run does not match the fence");
  }
  return plan;
}

/**
 * Execute the immutable plan: re-hash the exact target, apply the provider/run fence,
 * and spawn without a shell. The current selection record is never consulted.
 */
export async function executeProviderCliTurnPlan(options: ExecuteProviderCliTurnPlanOptions): Promise<number> {
  const plan = await loadProviderCliTurnPlanForRun({
    planPath: options.planPath,
    provider: options.provider,
    runId: options.runId,
    plansRoot: options.plansRoot,
  });
  const identity = await computeFileIdentity(plan.targetPath).catch((error: unknown) => {
    throw mapTargetError(error);
  });
  if (identity.path !== plan.targetPath) {
    throw new ProviderCliTurnPlanError("artifact_drifted", "Provider CLI Turn target path drifted");
  }
  const managedDigest = plan.selectionKind === "managed" ? managedArtifactDigest(plan.artifactId) : undefined;
  const fingerprint = computeTargetFingerprint(identity, plan.selectionVersion, managedDigest);
  if (fingerprint !== plan.fingerprint) {
    throw new ProviderCliTurnPlanError("artifact_drifted", "Provider CLI Turn target fingerprint drifted");
  }

  const entry = requireProviderCliCatalogEntry(plan.provider, options.catalog ?? PROVIDER_CLI_CATALOG);
  const baseEnv = options.env ?? process.env;
  const env = plan.selectionKind === "managed" ? { ...baseEnv, ...entry.managedEnvironment } : { ...baseEnv };
  const args = plan.selectionKind === "managed" ? [...entry.managedArguments, ...options.argv] : [...options.argv];
  const spawnTarget = options.spawnTarget ?? spawnProviderCliTarget;
  return spawnTarget(plan.targetPath, args, { env });
}

export async function runProviderCliTurnRunner(
  argv: readonly string[],
  options: { readonly plansRoot?: string } = {},
): Promise<number> {
  try {
    const parsed = parseProviderCliTurnRunnerArgv(argv);
    return await executeProviderCliTurnPlan({
      planPath: parsed.planPath,
      provider: parsed.provider,
      runId: parsed.runId,
      argv: parsed.userArgv,
      plansRoot: options.plansRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider CLI Turn runner failed";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

async function validateTurnPlanLocation(
  plansRoot: string,
  planPath: string,
): Promise<{ homeNamespace: string; sessionKey: string }> {
  const root = resolve(plansRoot);
  const target = resolve(planPath);
  assertPlanWithinRoot(root, target);
  const segments = relative(root, target).split(sep);
  const [homeNamespace, sessionKey, fileName] = segments;
  if (
    segments.length !== 3 ||
    homeNamespace === undefined ||
    sessionKey === undefined ||
    !isProviderCliHomeNamespace(homeNamespace ?? "") ||
    !isProviderCliSessionKey(sessionKey ?? "") ||
    fileName !== "plan.json"
  ) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan path is not a derived plan location");
  }
  const sessionDir = dirname(target);
  if (!(await validatePrivateDirectory(root, sessionDir))) {
    throw new ProviderCliTurnPlanError("plan_missing", "Provider CLI Turn plan directory is missing");
  }
  for (const directory of [root, join(root, homeNamespace), sessionDir]) {
    const status = await lstat(directory);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      (currentUid !== undefined && status.uid !== currentUid) ||
      (status.mode & 0o077) !== 0
    ) {
      throw new ProviderCliTurnPlanError(
        "unsafe",
        "Provider CLI Turn plan directories must be private and owned by the daemon account",
      );
    }
  }
  return { homeNamespace, sessionKey };
}

export function isProviderCliTurnRunnerMain(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

function spawnProviderCliTarget(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(file, [...args], {
      env: options.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (child.killed || child.exitCode !== null) return;
      child.kill(signal);
    };
    const onSigterm = (): void => forward("SIGTERM");
    const onSigint = (): void => forward("SIGINT");
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
    const stopListening = (): void => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };
    child.once("error", (error) => {
      stopListening();
      reject(new ProviderCliTurnPlanError("runner_failed", error.message));
    });
    child.once("exit", (code, signal) => {
      stopListening();
      if (code !== null) {
        resolveExit(code);
        return;
      }
      if (signal === "SIGTERM") {
        resolveExit(143);
        return;
      }
      if (signal === "SIGINT") {
        resolveExit(130);
        return;
      }
      resolveExit(1);
    });
  });
}

function mapTargetError(error: unknown): ProviderCliTurnPlanError {
  if (error instanceof ProviderCliTurnPlanError) return error;
  if (error instanceof ProviderCliFileError) {
    if (error.code === "too-large") {
      return new ProviderCliTurnPlanError("too_large", error.message);
    }
    if (error.code === "not-regular-file") {
      return new ProviderCliTurnPlanError("unsafe", error.message);
    }
    return new ProviderCliTurnPlanError("artifact_drifted", error.message);
  }
  return new ProviderCliTurnPlanError(
    "artifact_drifted",
    error instanceof Error ? error.message : "Provider CLI Turn target could not be verified",
  );
}

if (isProviderCliTurnRunnerMain(import.meta.url)) {
  void runProviderCliTurnRunner(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
