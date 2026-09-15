import { existsSync, statSync } from "node:fs";
import {
  assertFixedResources,
  assertFreshContainerState,
  copyConfigIntoContainer,
  execInContainer,
  inspectRunnerContainer,
  removeContainer,
  startGuardContainer,
} from "./harness.mjs";
import { stageFilteredPiConfig } from "./pi-config-guard.mjs";

export const REAL_ACCEPT_TIMEOUT_MS = 1_800_000;

function parseMarker(stdout, name) {
  const match = new RegExp(`__${name}__=(.+)`).exec(stdout);
  return match?.[1]?.trim();
}

function lastJsonLine(stdout) {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"));
  return lines.length > 0 ? JSON.parse(lines.at(-1)) : undefined;
}

function validateRealInputs({ piConfigDir, provider }) {
  if (!piConfigDir) throw new Error("real mode requires --pi-config-dir");
  if (!provider) throw new Error("real mode requires --provider");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error(`invalid provider name: ${provider}`);
  if (!existsSync(piConfigDir) || !statSync(piConfigDir).isDirectory()) {
    throw new Error(`real mode config directory is missing: ${piConfigDir ?? ""}`);
  }
}

function assertRealReport(report, accept) {
  if (!report) throw new Error(`real acceptance produced no JSON report:\n${accept.stdout}`);
  if (report.model === "skipped") throw new Error("real mode must never report model=skipped");
  if (report.model !== "passed" || report.offline !== "passed" || report.failed !== false) {
    throw new Error(`real acceptance did not pass: ${JSON.stringify(report)}`);
  }
  if (typeof report.firstTaskMs !== "number" || report.firstTaskMs <= 0) {
    throw new Error("real acceptance report is missing a positive firstTaskMs");
  }
}

const ACCEPT_WRAPPER =
  'opentag-runner accept --mode real --pi-config-dir /tmp/pi-config --provider "$1" --json; status=$?; echo __MEMORY_PEAK__=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || true); exit $status';

/**
 * Real-model acceptance inside Docker. The supplied Pi config directory is validated and
 * filtered host-side (selected provider only, whitelisted regular files, no HOME, no symlinks,
 * no `!` shell indirections), then only the filtered staging copy reaches the container. The
 * provider travels as quoted positional argv, never through shell interpolation. Missing config
 * fails before any model claim; `model=skipped` is impossible here.
 */
export async function runRealSmoke({ image, prefix, piConfigDir, provider }) {
  validateRealInputs({ piConfigDir, provider });
  const staging = stageFilteredPiConfig({ source: piConfigDir, provider });
  const name = `${prefix}-real`;
  const started = Date.now();
  await startGuardContainer({ image, name });
  try {
    // Fresh container + Runner CLI startup (identity), before any config is injected.
    const identity = await execInContainer(name, ["opentag-runner", "identity", "--json"], { allowFailure: true });
    if (identity.status !== 0) throw new Error(`guard container Runner did not start:\n${identity.stderr}`);
    const startupMs = Date.now() - started;
    await assertFreshContainerState(name);
    await copyConfigIntoContainer(name, staging);
    // Quoted positional argv ($1) carries the provider; no string is ever interpolated into sh.
    const acceptStarted = Date.now();
    const accept = await execInContainer(name, ["sh", "-c", ACCEPT_WRAPPER, "sh", provider], {
      allowFailure: true,
      timeoutMs: REAL_ACCEPT_TIMEOUT_MS,
    });
    const acceptanceMs = Date.now() - acceptStarted;
    const memoryPeak = parseMarker(accept.stdout, "MEMORY_PEAK");
    if (!memoryPeak) {
      throw new Error(`memory.peak was not captured inside the container:\n${accept.stdout}\n${accept.stderr}`);
    }
    if (accept.status !== 0) {
      const report = lastJsonLine(accept.stdout);
      throw new Error(
        `real acceptance failed (exit ${accept.status}): ${JSON.stringify(report ?? accept.stdout.slice(-2000))}`,
      );
    }
    const report = lastJsonLine(accept.stdout);
    assertRealReport(report, accept);
    const inspect = await inspectRunnerContainer(name);
    assertFixedResources(inspect);
    return {
      firstTaskMs: report.firstTaskMs,
      inspect,
      memoryPeak,
      startupMs,
      acceptanceMs,
      report,
    };
  } finally {
    await removeContainer(name);
  }
}
