import type { HandoffReadiness } from "@opentag/client";
import type { ServiceRunner } from "./types.js";

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const LOG_SHOW_TIMEOUT_MS = 30_000;
const ENTERING_ON_DEMAND = "entering ondemand mode";
const EXITING_ON_DEMAND = "exiting ondemand mode";

export interface LaunchdHandoffReadinessOptions {
  runner: ServiceRunner;
  uid: number;
  launchctl?: string;
  log?: string;
  /** How far back to read launchd's on-demand transitions. */
  lookback?: string;
}

/**
 * Whether launchd will respawn the LaunchAgent after the upgrade handoff exits.
 *
 * While a `gui/<uid>` domain is in on-demand-only mode (for example after a failed logout or restart
 * countdown), launchd records `KeepAlive` respawns as pending and starts nothing until the login
 * session recovers. `launchctl print` does not expose that mode, but launchd logs every transition
 * under the domain's subsystem (`gui/<uid> [<handle>]`), so the newest transition for the current
 * domain instance decides. Only a positive `entering ondemand mode` blocks the handoff; anything the
 * check cannot read is reported as uncertain so a broken check never blocks every upgrade.
 */
export function createLaunchdHandoffReadiness(
  options: LaunchdHandoffReadinessOptions,
): () => Promise<HandoffReadiness> {
  const launchctl = options.launchctl ?? "launchctl";
  const log = options.log ?? "log";
  const lookback = options.lookback ?? "7d";
  const domain = `gui/${options.uid}`;
  return async () => {
    const printed = await options.runner.run(launchctl, ["print", domain], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
    if (printed.timedOut || printed.code !== 0) {
      return uncertain(`launchctl print ${domain} failed: ${commandFailure(printed)}`);
    }
    const handle = parseLaunchdDomainHandle(printed.stdout);
    if (handle === undefined) return uncertain(`launchctl print ${domain} did not report a domain handle`);
    const subsystem = `${domain} [${handle}]`;
    const shown = await options.runner.run(
      log,
      [
        "show",
        "--style",
        "ndjson",
        "--last",
        lookback,
        "--predicate",
        `processID == 1 AND subsystem == "${subsystem}" AND (eventMessage == "${ENTERING_ON_DEMAND}" OR eventMessage == "${EXITING_ON_DEMAND}")`,
      ],
      { timeoutMs: LOG_SHOW_TIMEOUT_MS },
    );
    if (shown.timedOut || shown.code !== 0) {
      return uncertain(`log show for ${subsystem} failed: ${commandFailure(shown)}`);
    }
    const transition = lastOnDemandTransition(shown.stdout, subsystem);
    if (transition === "entering") {
      return { ready: false, reason: `launchd domain ${subsystem} is in on-demand-only mode` };
    }
    return { ready: true };
  };
}

export function parseLaunchdDomainHandle(output: string): string | undefined {
  return output.match(/^\thandle = (\d+)$/mu)?.[1];
}

/** Newest on-demand transition in `log show --style ndjson` output, which lists events oldest first. */
export function lastOnDemandTransition(output: string, subsystem: string): "entering" | "exiting" | undefined {
  let transition: "entering" | "exiting" | undefined;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const { eventMessage, subsystem: eventSubsystem } = event as { eventMessage?: unknown; subsystem?: unknown };
    if (eventSubsystem !== subsystem) continue;
    if (eventMessage === ENTERING_ON_DEMAND) transition = "entering";
    else if (eventMessage === EXITING_ON_DEMAND) transition = "exiting";
  }
  return transition;
}

function uncertain(detail: string): HandoffReadiness {
  return { ready: true, uncertain: detail };
}

function commandFailure(result: { code: number | null; stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return "command timed out";
  return result.stderr || `exit code ${result.code}`;
}
