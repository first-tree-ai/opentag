import {
  type AgentRuntimeCliInstallation,
  checkServerHealth,
  probeAgentRuntimeCliInstallations,
  readMachineCredentials,
  resolveOpenTagHome,
  ServerHealthConfigurationError,
  ServerHealthHttpError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
  type StoredMachineCredentials,
} from "@opentag/client";
import type { ServerHealth } from "@opentag/shared";
import { channelConfig } from "../channel/config.js";

export type HealthChecker = (serverUrl: string) => Promise<ServerHealth>;
type DoctorCheckState = "pass" | "fail" | "info";

interface DoctorCheck {
  state: DoctorCheckState;
  label: string;
  detail: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  healthChecker?: HealthChecker;
  home?: string;
  readCredentials?: (home: string) => Promise<StoredMachineCredentials | undefined>;
  probeRuntimeInstallations?: () => Promise<AgentRuntimeCliInstallation[]>;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 1;
  message: string;
}

/**
 * Diagnose the local OpenTag installation. The Server target is local machine
 * state, never a caller-selected URL: every distinct enrolled Server is checked.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const environment = options.env ?? process.env;
  const home = options.home ?? resolveOpenTagHome(environment);
  const checks = await Promise.all([
    checkConfiguredServers(
      home,
      options.readCredentials ?? readMachineCredentials,
      options.healthChecker ?? checkServerHealth,
    ),
    checkAgentRuntimeInstallations(
      options.probeRuntimeInstallations ?? (() => probeAgentRuntimeCliInstallations({ environment })),
    ),
  ]).then((groups) => groups.flat());
  const exitCode = checks.some((check) => check.state === "fail") ? 1 : 0;
  return { checks, exitCode, message: formatDoctorReport(checks) };
}

async function checkConfiguredServers(
  home: string,
  readCredentials: (home: string) => Promise<StoredMachineCredentials | undefined>,
  healthChecker: HealthChecker,
): Promise<DoctorCheck[]> {
  let credentials: StoredMachineCredentials | undefined;
  try {
    credentials = await readCredentials(home);
  } catch (error) {
    return [
      {
        state: "fail",
        label: "OpenTag server",
        detail: `cannot read this computer's enrollment (${error instanceof Error ? error.message : String(error)})`,
      },
    ];
  }
  const serverUrls = [...new Set(credentials?.enrollments.map((enrollment) => enrollment.serverUrl) ?? [])].sort();
  if (serverUrls.length === 0) {
    return [
      {
        state: "fail",
        label: "OpenTag server",
        detail: `not configured — run \`${channelConfig.binName} computer connect <code>\` first`,
      },
    ];
  }
  return Promise.all(
    serverUrls.map(async (serverUrl): Promise<DoctorCheck> => {
      const displayUrl = displayServerUrl(serverUrl);
      try {
        const health = await healthChecker(serverUrl);
        return { state: "pass", label: "OpenTag server", detail: `healthy (${health.service}) at ${displayUrl}` };
      } catch (error) {
        return { state: "fail", label: "OpenTag server", detail: formatServerHealthError(error, displayUrl) };
      }
    }),
  );
}

async function checkAgentRuntimeInstallations(
  probeRuntimeInstallations: () => Promise<AgentRuntimeCliInstallation[]>,
): Promise<DoctorCheck[]> {
  let installations: AgentRuntimeCliInstallation[];
  try {
    installations = await probeRuntimeInstallations();
  } catch (error) {
    return [
      {
        state: "fail",
        label: "Agent Runtime CLI",
        detail: `installation detection failed (${error instanceof Error ? error.message : String(error)})`,
      },
    ];
  }
  const installed = installations.filter((installation) => installation.installed);
  const summary: DoctorCheck =
    installed.length > 0
      ? {
          state: "pass",
          label: "Agent Runtime CLI",
          detail: `${installed.map((installation) => installation.displayName).join(", ")} installed`,
        }
      : { state: "fail", label: "Agent Runtime CLI", detail: "no supported Agent Runtime CLI is installed" };
  return [
    summary,
    ...installations.map(
      (installation): DoctorCheck => ({
        state: "info",
        label: installation.displayName,
        detail: installation.installed
          ? `installed${installation.path ? ` at ${installation.path}` : ""}`
          : "not installed",
      }),
    ),
  ];
}

function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const lines = ["Checks"];
  for (const check of checks) {
    const marker = check.state === "pass" ? "✓" : check.state === "fail" ? "✗" : "-";
    lines.push(`  ${marker} ${check.label}: ${check.detail}`);
  }
  const failures = checks.filter((check) => check.state === "fail").length;
  lines.push("");
  lines.push(failures === 0 ? "All required checks passed." : `${failures} required check(s) failed.`);
  lines.push("Agent Runtime authentication was not checked.");
  lines.push("Integration CLI availability was not checked.");
  return lines.join("\n");
}

function formatServerHealthError(error: unknown, serverUrl: string): string {
  if (error instanceof ServerHealthConfigurationError) return `invalid configured URL ${serverUrl}`;
  if (error instanceof ServerHealthNetworkError) return `unreachable at ${serverUrl}`;
  if (error instanceof ServerHealthHttpError) return `HTTP ${error.status} at ${serverUrl}`;
  if (error instanceof ServerHealthResponseError) return `invalid health response from ${serverUrl}`;
  const detail = error instanceof Error ? error.message : String(error);
  return `unexpected failure at ${serverUrl} (${detail})`;
}

function displayServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return "<invalid configured URL>";
  }
}
