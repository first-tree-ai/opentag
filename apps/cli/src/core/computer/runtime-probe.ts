import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentRuntimeFactory,
  type AgentRuntimeProbeResult,
  claudeCodeProcessEnvironment,
  codexAgentRuntimeEnvironment,
  resolveCodexHome,
  resolvedClaudeCodeFactory,
  resolvedCodexFactory,
} from "@opentag/client";
import type { AgentRuntimeProvider, LocalPreparationComponent } from "@opentag/shared";
import { CLI_VERSION } from "../../build-info.js";
import { channelConfig } from "../channel/config.js";
import { redactSecrets } from "../command/policy.js";

/**
 * Read-only probe of one Agent Runtime CLI for targeted Computer preparation. It reuses the same
 * resolved factories the daemon runs (canonical environment filter, executable discovery, bounded
 * probe) so a connect-time verdict and the daemon's readiness cannot disagree. No model is ever
 * invoked and OpenTag never installs a Runtime CLI: the operator supplies it.
 */

/** Bounded probe budget; matches the daemon's default provider probe deadline. */
export const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

export interface ResolvedRuntimeProbeEnvironment {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
}

/**
 * Resolve the selected Runtime's home and filtered probe environment exactly like the daemon:
 * Codex under `CODEX_HOME` (default `~/.codex`) and Claude Code under `CLAUDE_CONFIG_DIR`
 * (default `~/.claude`). `CLAUDE_CONFIG_DIR` is omitted when it resolves to Claude's own default,
 * because setting it explicitly would change the credential record the daemon later reads.
 */
export async function resolveRuntimeProbeEnvironment(
  provider: AgentRuntimeProvider,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedRuntimeProbeEnvironment> {
  if (provider === "codex") {
    const home = await canonicalizeProviderHome(resolveCodexHome(sourceEnvironment));
    return {
      home,
      sourceEnvironment,
      environment: codexAgentRuntimeEnvironment({ ...sourceEnvironment, CODEX_HOME: home }),
    };
  }
  const configuredHome = resolve(
    sourceEnvironment.CLAUDE_CONFIG_DIR ?? join(sourceEnvironment.HOME ?? homedir(), ".claude"),
  );
  const claudeCodeHome = await canonicalizeProviderHome(configuredHome);
  const defaultClaudeCodeHome = resolve(join(sourceEnvironment.HOME ?? homedir(), ".claude"));
  const canonicalDefaultHome = await realpath(defaultClaudeCodeHome).catch(() => defaultClaudeCodeHome);
  return {
    home: claudeCodeHome,
    sourceEnvironment,
    environment: claudeCodeProcessEnvironment(sourceEnvironment, claudeCodeHome, canonicalDefaultHome),
  };
}

async function canonicalizeProviderHome(configured: string): Promise<string> {
  // Inspection does not create a Runtime home or install anything. An absent home is passed to
  // the existing probe, which owns the credential/capability diagnosis.
  return realpath(configured).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return configured;
    throw error;
  });
}

function resolvedFactoryFor(
  provider: AgentRuntimeProvider,
  environment: ResolvedRuntimeProbeEnvironment,
  clientVersion: string,
): AgentRuntimeFactory {
  if (provider === "codex") {
    return resolvedCodexFactory({
      clientVersion,
      codexHome: environment.home,
      command: "codex",
      environment: environment.environment,
      sourceEnvironment: environment.sourceEnvironment,
    });
  }
  return resolvedClaudeCodeFactory({
    claudeCodeHome: environment.home,
    command: "claude",
    environment: environment.environment,
    sourceEnvironment: environment.sourceEnvironment,
  });
}

export interface RuntimeProbeOptions {
  readonly provider: AgentRuntimeProvider;
  /** Source environment; defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides the channel Client version for factory tests only. */
  readonly clientVersion?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * Probe one Runtime CLI and fold the outcome into the shared local preparation vocabulary. The
 * returned Component never carries an OpenTag install command: recovery is the operator's manual
 * install/login/config step followed by an idempotent read-only `runtime-inspect` verify.
 */
export async function probeRuntimeComponent(options: RuntimeProbeOptions): Promise<LocalPreparationComponent> {
  const provider = options.provider;
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const bounded = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Runtime probe timed out")), timeoutMs);
  let abortListener: (() => void) | undefined;
  try {
    bounded.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(bounded.reason);
      bounded.addEventListener("abort", abortListener, { once: true });
    });
    const result = await Promise.race([probeSelectedRuntime(options, bounded), aborted]);
    return runtimeComponentFromProbeResult(provider, result, (options.now ?? (() => new Date()))().toISOString());
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return runtimeComponentFromProbeFailure(provider, error, (options.now ?? (() => new Date()))().toISOString());
  } finally {
    clearTimeout(timer);
    if (abortListener) bounded.removeEventListener("abort", abortListener);
  }
}

async function probeSelectedRuntime(
  options: RuntimeProbeOptions,
  signal: AbortSignal,
): Promise<AgentRuntimeProbeResult> {
  const environment = await resolveRuntimeProbeEnvironment(options.provider, options.environment);
  signal.throwIfAborted();
  return resolvedFactoryFor(options.provider, environment, options.clientVersion ?? CLI_VERSION).probe({ signal });
}

export function runtimeComponentLabel(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}

export function runtimeComponentId(provider: AgentRuntimeProvider): `runtime:${AgentRuntimeProvider}` {
  return `runtime:${provider}`;
}

/** The exact idempotent read-only verify command for a known Runtime provider. */
export function runtimeInspectCommand(provider: AgentRuntimeProvider): string {
  return `"$HOME/.local/bin/${channelConfig.binName}" computer runtime-inspect --provider ${provider}`;
}

export function runtimeComponentFromProbeResult(
  provider: AgentRuntimeProvider,
  result: AgentRuntimeProbeResult,
  observedAt: string,
): LocalPreparationComponent {
  const label = runtimeComponentLabel(provider);
  const base = {
    id: runtimeComponentId(provider),
    label,
    required: true as const,
    ...(result.version ? { version: redactSecrets(result.version).slice(0, 64) } : {}),
    observedAt,
  };
  if (result.ready) {
    return { ...base, status: "ready" as const, blocking: false };
  }
  const issue = result.issues[0];
  const verifyAction = { command: runtimeInspectCommand(provider) };
  if (!issue) {
    return {
      ...base,
      status: "unavailable" as const,
      blocking: true,
      diagnosticCode: "runtime_probe_failed",
      message: `${label} readiness could not be established.`,
      nextAction: { instruction: "Wait briefly, then run the verify command again." },
      verifyAction,
    };
  }
  switch (issue.code) {
    case "artifact_missing":
      return {
        ...base,
        status: "install_required" as const,
        blocking: true,
        diagnosticCode: issue.code,
        message: `${label} is not installed or could not run.`,
        nextAction: {
          instruction: `Install and sign in to the ${label} yourself (OpenTag never installs Runtime CLIs), then run the verify command.`,
        },
        verifyAction,
      };
    case "credential_missing":
      return {
        ...base,
        status: "needs_attention" as const,
        blocking: true,
        diagnosticCode: issue.code,
        message: `${label} credentials were not found.`,
        nextAction: { instruction: `Sign in to the ${label} with its own login command, then run the verify command.` },
        verifyAction,
      };
    case "version_incompatible":
      return {
        ...base,
        status: "needs_attention" as const,
        blocking: true,
        diagnosticCode: issue.code,
        message: `${label} does not provide the required version or capabilities.`,
        nextAction: { instruction: `Update the ${label} to a supported version, then run the verify command.` },
        verifyAction,
      };
    case "configuration_invalid":
      return {
        ...base,
        status: "needs_attention" as const,
        blocking: true,
        diagnosticCode: issue.code,
        message: `${label} configuration is invalid.`,
        nextAction: { instruction: `Fix the ${label} configuration, then run the verify command.` },
        verifyAction,
      };
    default:
      return {
        ...base,
        status: "unavailable" as const,
        blocking: true,
        diagnosticCode: issue.code,
        message: `${label} could not be checked right now.`,
        nextAction: { instruction: "Wait briefly, then run the verify command again." },
        verifyAction,
      };
  }
}

export function runtimeComponentFromProbeFailure(
  provider: AgentRuntimeProvider,
  error: unknown,
  observedAt: string,
): LocalPreparationComponent {
  const label = runtimeComponentLabel(provider);
  const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 480);
  return {
    id: runtimeComponentId(provider),
    label,
    required: true,
    status: "unavailable",
    blocking: true,
    diagnosticCode: "runtime_probe_failed",
    message: detail.length > 0 ? `${label} check failed: ${detail}` : `${label} check failed.`,
    nextAction: { instruction: "Wait briefly, then run the verify command again." },
    verifyAction: { command: runtimeInspectCommand(provider) },
    observedAt,
  };
}

/**
 * The fail-closed row for a marked Client talking to an older Server that answered `agentId`
 * without a `runtimeProvider`. The exact provider is unknown, so no probe runs, no default
 * Runtime is assumed, and the recovery is a Server upgrade plus a Web recheck — never a made-up
 * provider command.
 */
export function unconfirmedRuntimeComponent(): LocalPreparationComponent {
  return {
    id: "runtime:unconfirmed",
    label: "Runtime CLI (unconfirmed)",
    required: true,
    status: "needs_attention",
    blocking: true,
    diagnosticCode: "RUNTIME_UNCONFIRMED",
    message: "The connected Server did not report which Runtime CLI this Agent uses.",
    nextAction: {
      instruction: "Upgrade the OpenTag Server (and this CLI), then recheck this Computer in the OpenTag Web app.",
    },
  };
}
