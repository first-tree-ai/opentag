/**
 * F6 cross-layer preparation contract, CLI boundary.
 *
 * Every scenario in the shared fixture (`scripts/fixtures/onboarding-preparation-contract.json`)
 * is consumed by the real `computer connect` command registration (`createProgram().parseAsync`).
 * The command's transport and probes are mocked at their module boundaries — the connect exchange,
 * the Runtime probe, and the Provider CLI ensure run — while the production projection
 * (`runLocalComputerPreparation`, its shared-schema validation, the guidance composition, and the
 * human/JSON presenters) executes for real. The fixture facts are translated mechanically into
 * probe/ensure outcomes; the row statuses, blocking, exit code, next actions, and guidance the
 * fixture expects are authored independently and pinned against the actual output.
 *
 * These are deterministic output-consumption cases: they prove what an executing Agent can rely
 * on (exit code, JSON envelope, one unambiguous next action, connected=true, no reused connect
 * code, no Server-ready claim, no implicit Runtime install) — not a live LLM execution.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeProbeIssue,
  AgentRuntimeProbeResult,
  ProviderCliDiagnosticCode,
  ProviderCliEnsureResult,
  ProviderCliWarning,
} from "@opentag/client";
import { type LocalComputerPreparationResult, LocalComputerPreparationResultSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as connectCore from "../core/computer/connect.js";
import * as runtimeProbeModule from "../core/computer/runtime-probe.js";
import { type RuntimeProbeOptions, runtimeComponentFromProbeResult } from "../core/computer/runtime-probe.js";
import type { DaemonServiceInfo } from "../core/daemon/service/types.js";
import type { ProviderCliEnsureCommandResult } from "../core/provider-cli/ensure.js";
import * as ensureModule from "../core/provider-cli/ensure.js";

const FIXED_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const FIXED_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const TEST_HOME = "/tmp/opentag-f6-contract-home";
const CONNECT_CODE = "contract-connect-code-000001";
const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

const SERVER_CONFIRMATION_GUIDANCE = "Server/Web confirmation still requires fresh daemon observations.";
const NO_CODE_REUSE_GUIDANCE = "Connection preserved. Do not reuse the one-time connect code.";

interface EnsureFact {
  readonly ensure: "ready" | "failed";
  readonly version?: string;
  readonly diagnosticCode?: ProviderCliDiagnosticCode;
  readonly remediation?: string;
  readonly warnings?: readonly { readonly code: string; readonly remediation?: string }[];
}

interface LocalFacts {
  readonly daemon: "active" | "skipped-no-start";
  readonly runtime: { readonly probe: string; readonly version?: string };
  readonly feishu: EnsureFact;
  readonly slack: EnsureFact;
}

interface LocalComponentExpectation {
  readonly id: string;
  readonly status: string;
  readonly blocking: boolean;
}

interface Scenario {
  readonly id: string;
  readonly runtimeProvider: "codex" | "claude-code";
  readonly local: {
    readonly facts: LocalFacts;
    readonly expected: {
      readonly status: "ready" | "needs_attention";
      readonly localReady: boolean;
      readonly exitCode: number;
      readonly components: LocalComponentExpectation[];
      readonly nextAction: {
        readonly kind: string;
        readonly instruction?: string;
        readonly commandTail?: string;
        readonly verifyCommandTail?: string;
        readonly repairCommandAbsent?: boolean;
        readonly repairInstructionAbsent?: boolean;
        readonly ownershipDetail?: string;
        readonly daemonSkippedDetail?: string;
        readonly warningVisible?: string;
      };
    };
  };
}

interface FixtureFile {
  readonly scenarios: Scenario[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../../../scripts/fixtures/onboarding-preparation-contract.json"), "utf8"),
) as FixtureFile;

interface RunOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type PreparationDocument = LocalComputerPreparationResult;

interface CommandResultEnvelope {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string; readonly retryability: string };
  readonly result?: {
    readonly connected: boolean;
    readonly guidance: readonly string[];
    readonly preparation: PreparationDocument;
  };
}

const ACTIVE_SERVICE: DaemonServiceInfo = {
  configuredHome: TEST_HOME,
  currentHome: TEST_HOME,
  definitionPath: `${TEST_HOME}/Library/LaunchAgents/ai.first-tree.opentag.plist`,
  drifted: false,
  logHint: `${TEST_HOME}/Library/Logs/OpenTag/daemon.log`,
  pid: 4321,
  platform: "launchd",
  runtimeOwner: { consistency: "consistent", pid: 4321 },
  serviceId: "opentag",
  state: "active",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function runtimeProbeResultFor(probe: string): AgentRuntimeProbeResult {
  if (probe === "ready") {
    return { ready: true, version: "1.0.0", issues: [] };
  }
  const issues: Record<string, AgentRuntimeProbeIssue> = {
    artifact_missing: { code: "artifact_missing", message: "not installed" },
    credential_missing: { code: "credential_missing", message: "no credentials" },
    configuration_invalid: { code: "configuration_invalid", message: "invalid config" },
    version_incompatible: { code: "version_incompatible", message: "old version" },
  };
  const issue = issues[probe];
  if (!issue) throw new Error(`Unsupported runtime probe fact: ${probe}`);
  return { ready: false, issues: [issue] };
}

function providerFlag(provider: "feishu" | "slack"): string {
  return provider === "feishu" ? "lark" : "slack";
}

function ensureResultFor(provider: "feishu" | "slack", fact: EnsureFact): ProviderCliEnsureResult {
  const base = {
    provider,
    phases: [],
    candidates: [],
    globalCommand: {
      active: true,
      path: `~/.local/bin/${providerFlag(provider)}`,
      resolvedPath: `/home/tester/.local/bin/${providerFlag(provider)}`,
    },
  } as const;
  if (fact.ensure === "ready") {
    return {
      ...base,
      ok: true,
      action: "selected-existing",
      readiness: "ready",
      selected: {
        path: `/home/tester/.local/bin/${providerFlag(provider)}`,
        version: fact.version ?? "1.0.0",
        source: "managed",
        trust: "catalog-verified",
      },
      warnings: (fact.warnings ?? []) as ProviderCliWarning[],
    };
  }
  return {
    ...base,
    ok: false,
    action: "failed",
    readiness: "unavailable",
    warnings: [],
    diagnostic: {
      code: fact.diagnosticCode ?? "probe_failed",
      ...(fact.remediation ? { remediation: fact.remediation } : {}),
    },
  };
}

/** Mocks the scenario world at the module boundaries; returns the exchange spy for call counts. */
function mockScenarioWorld(scenario: Scenario) {
  const facts = scenario.local.facts;
  const connect = vi.spyOn(connectCore, "runComputerConnect").mockResolvedValue({
    agentId: FIXED_AGENT_ID,
    runtimeProvider: scenario.runtimeProvider,
    computerId: FIXED_COMPUTER_ID,
    credentialsPath: `${TEST_HOME}/config/computer-credentials.json`,
    message: `Connected Computer ${FIXED_COMPUTER_ID} and bound Agent ${FIXED_AGENT_ID}`,
    ...(facts.daemon === "active" ? { service: ACTIVE_SERVICE } : {}),
  });
  const probeResult = runtimeProbeResultFor(facts.runtime.probe);
  vi.spyOn(runtimeProbeModule, "probeRuntimeComponent").mockImplementation(async (options: RuntimeProbeOptions) =>
    runtimeComponentFromProbeResult(options.provider, probeResult, OBSERVED_AT),
  );
  vi.spyOn(ensureModule, "runProviderCliEnsure").mockResolvedValue({
    exitCode: 0,
    results: [ensureResultFor("feishu", facts.feishu), ensureResultFor("slack", facts.slack)],
    nextActions: [],
  } satisfies ProviderCliEnsureCommandResult);
  return connect;
}

async function invokeCommand(json: boolean, noStart: boolean): Promise<void> {
  await createProgram().parseAsync([
    "node",
    "opentag",
    "computer",
    "connect",
    CONNECT_CODE,
    "--home",
    TEST_HOME,
    ...(noStart ? ["--no-start"] : []),
    ...(json ? ["--json"] : []),
  ]);
}

async function run(scenario: Scenario, json: boolean): Promise<RunOutput> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  let exitCode: number | undefined;
  try {
    await invokeCommand(json, scenario.local.facts.daemon === "skipped-no-start");
  } finally {
    exitCode = process.exitCode ?? 0;
    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

function envelopeOf(output: RunOutput): CommandResultEnvelope {
  // presentCommand routes success envelopes to stdout and failure envelopes to stderr, so the
  // JSON envelope is the last JSON document across both streams.
  const lines = [...output.stdout.split("\n"), ...output.stderr.split("\n")].filter(
    (item) => item.trim().length > 0 && item.trim().startsWith("{"),
  );
  const line = lines[lines.length - 1];
  if (!line) throw new Error("JSON mode produced no envelope");
  return JSON.parse(line) as CommandResultEnvelope;
}

/** Human projection: `[id] status (blocking)? — detail` plus indented next/verify/warning lines. */
function humanComponentRows(
  output: RunOutput,
  ids: readonly string[],
): Map<string, { status: string; blocking: boolean }> {
  const map = new Map<string, { status: string; blocking: boolean }>();
  for (const line of `${output.stdout}\n${output.stderr}`.split("\n")) {
    const match = /^\[([a-z0-9:_-]+)\] (\w+)( \(blocking\))?(?:\s|$)/.exec(line);
    if (!match) continue;
    const id = match[1] ?? "";
    if (!ids.includes(id)) continue;
    map.set(id, { status: match[2] ?? "", blocking: (match[3] ?? "") !== "" });
  }
  return map;
}

function expectEnvelopeVerdict(scenario: Scenario, envelope: CommandResultEnvelope): PreparationDocument {
  const expected = scenario.local.expected;
  expect(envelope.ok).toBe(expected.localReady);
  const result = envelope.result;
  if (!result) throw new Error("JSON envelope carried no result");
  expect(result.connected).toBe(true);
  const preparation = result.preparation;
  expect(LocalComputerPreparationResultSchema.parse(preparation)).toEqual(preparation);
  expect(preparation.status).toBe(expected.status);
  expect(preparation.localReady).toBe(expected.localReady);
  expect(preparation.requiredCount).toBe(4);
  expect(preparation.readyCount).toBe(expected.components.filter((component) => component.status === "ready").length);
  return preparation;
}

function expectStreamRouting(
  scenario: Scenario,
  jsonRun: RunOutput,
  humanRun: RunOutput,
  envelope: CommandResultEnvelope,
): void {
  const expected = scenario.local.expected;
  if (expected.localReady) {
    expect(jsonRun.stderr).toBe("");
    return;
  }
  expect(envelope.error?.code).toBe("LOCAL_COMPUTER_PREPARATION_INCOMPLETE");
  expect(envelope.error?.retryability).toBe("never");
  expect(envelope.error?.message).toBe(NO_CODE_REUSE_GUIDANCE);
  // The failure envelope and the human report both stay off the success stream.
  expect(jsonRun.stdout).toBe("");
  expect(humanRun.stdout).toBe("");
}

function expectRowProjection(scenario: Scenario, preparation: PreparationDocument, humanRun: RunOutput): void {
  const expected = scenario.local.expected;
  const ids = expected.components.map((component) => component.id);
  // The same four components, in the same order, in both projections.
  expect(preparation.components.map((component) => component.id)).toEqual(ids);
  const humanRows = humanComponentRows(humanRun, ids);
  for (const component of expected.components) {
    const jsonRow = preparation.components.find((candidate) => candidate.id === component.id);
    if (!jsonRow) throw new Error(`missing JSON row ${component.id}`);
    expect(jsonRow.status, `${component.id} JSON status`).toBe(component.status);
    expect(jsonRow.blocking, `${component.id} JSON blocking`).toBe(component.blocking);
    const humanRow = humanRows.get(component.id);
    if (!humanRow) throw new Error(`missing human row ${component.id}`);
    expect(humanRow.status, `${component.id} human status`).toBe(component.status);
    expect(humanRow.blocking, `${component.id} human blocking`).toBe(component.blocking);
  }
  const verdictLine = expected.localReady
    ? "Local computer preparation: READY"
    : "Local computer preparation: NEEDS_ATTENTION";
  expect(humanRun.stdout + humanRun.stderr).toContain(verdictLine);
}

function expectGuidance(scenario: Scenario, humanRun: RunOutput, envelope: CommandResultEnvelope): void {
  const result = envelope.result;
  if (!result) throw new Error("JSON envelope carried no result");
  if (scenario.local.expected.localReady) {
    // A ready local verdict only waits for fresh daemon observations and never mentions the code.
    expect(result.guidance).toEqual([SERVER_CONFIRMATION_GUIDANCE]);
    expect(humanRun.stdout).toContain(SERVER_CONFIRMATION_GUIDANCE);
    expect(JSON.stringify(result.preparation.components)).not.toMatch(/nextAction|verifyAction/);
    return;
  }
  expect(result.guidance).toContain(NO_CODE_REUSE_GUIDANCE);
  expect(result.guidance).toContain(SERVER_CONFIRMATION_GUIDANCE);
  expect(result.guidance[result.guidance.length - 1]).toBe(SERVER_CONFIRMATION_GUIDANCE);
  expect(humanRun.stderr).toContain(NO_CODE_REUSE_GUIDANCE);
  expect(humanRun.stderr).toContain(SERVER_CONFIRMATION_GUIDANCE);
}

function expectNextActionPins(scenario: Scenario, preparation: PreparationDocument, humanRun: RunOutput): void {
  const nextAction = scenario.local.expected.nextAction;
  const jsonText = JSON.stringify(preparation.components);
  const humanText = humanRun.stderr;
  if (nextAction.commandTail) {
    expect(jsonText).toContain(nextAction.commandTail);
    expect(humanText).toContain(nextAction.commandTail);
  }
  if (nextAction.verifyCommandTail) {
    expect(jsonText).toContain(nextAction.verifyCommandTail);
    expect(humanText).toContain(nextAction.verifyCommandTail);
  }
  if (nextAction.instruction) {
    expect(jsonText).toContain(nextAction.instruction);
    expect(humanText).toContain(nextAction.instruction);
  }
  if (nextAction.repairCommandAbsent) {
    // A manual repair is an explicit instruction, never an OpenTag repair command.
    expect(jsonText).not.toMatch(/provider-cli ensure|daemon install/);
    expect(humanText).not.toMatch(/provider-cli ensure|daemon install/);
  }
  if (nextAction.repairInstructionAbsent) {
    // An auto-repairable row names its idempotent repair command; no instruction is invented.
    expect(jsonText).not.toMatch(/manually, then run the verify command/);
    expect(humanText).not.toMatch(/manually, then run the verify command/);
  }
  if (nextAction.ownershipDetail) {
    expect(jsonText).toContain(nextAction.ownershipDetail);
    expect(humanText).toContain(nextAction.ownershipDetail);
  }
  if (nextAction.daemonSkippedDetail) {
    expect(jsonText).toContain(nextAction.daemonSkippedDetail);
    expect(humanText).toContain(nextAction.daemonSkippedDetail);
  }
}

describe("F6 shared preparation matrix, CLI boundary", () => {
  it.each(fixture.scenarios.map((scenario) => [scenario.id, scenario] as const))(
    "scenario %s: the real computer connect command projects the fixture's local verdict in JSON and human modes",
    async (_scenarioId, scenario) => {
      mockScenarioWorld(scenario);
      const expected = scenario.local.expected;
      const jsonRun = await run(scenario, true);
      const humanRun = await run(scenario, false);

      // The exchanged Runtime identity selects the probe in both output modes, including Claude
      // Code failures. The separate ensure boundary is called only for the IM Provider CLI set.
      expect(runtimeProbeModule.probeRuntimeComponent).toHaveBeenCalledTimes(2);
      expect(ensureModule.runProviderCliEnsure).toHaveBeenCalledTimes(2);
      for (const call of [1, 2]) {
        expect(runtimeProbeModule.probeRuntimeComponent).toHaveBeenNthCalledWith(
          call,
          expect.objectContaining({ provider: scenario.runtimeProvider }),
        );
        expect(ensureModule.runProviderCliEnsure).toHaveBeenNthCalledWith(
          call,
          expect.objectContaining({ provider: "all" }),
        );
      }

      // One deterministic exit code in both projections.
      expect(humanRun.exitCode).toBe(expected.exitCode);
      expect(jsonRun.exitCode).toBe(expected.exitCode);

      const envelope = envelopeOf(jsonRun);
      const preparation = expectEnvelopeVerdict(scenario, envelope);
      expectStreamRouting(scenario, jsonRun, humanRun, envelope);
      expectRowProjection(scenario, preparation, humanRun);
      expectGuidance(scenario, humanRun, envelope);

      if (!expected.localReady) {
        // Output-consumption assertions apply to failing verdicts: the fixture names the one
        // unambiguous next action an executing Agent may take. Ready verdicts carry no per-row
        // action at all (already pinned above); their narrative instruction lives in the fixture.
        expectNextActionPins(scenario, preparation, humanRun);
      }
      if (expected.nextAction.warningVisible) {
        expect(humanRun.stdout + humanRun.stderr).toContain("warning (non-blocking)");
        expect(JSON.stringify(preparation.components)).toContain('"warnings"');
      }
    },
  );

  it("asserts the same four components and no implicit Runtime install for a missing Runtime", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "runtime-missing-codex");
    if (!scenario) throw new Error("missing runtime-missing-codex scenario");
    mockScenarioWorld(scenario);
    const jsonRun = await run(scenario, true);
    const envelope = envelopeOf(jsonRun);
    const preparation = envelope.result?.preparation;
    if (!preparation) throw new Error("no preparation");
    expect(preparation.components.map((component) => component.id)).toEqual([
      "computer",
      "runtime:codex",
      "im-cli:lark",
      "im-cli:slack",
    ]);
    expect(preparation.components.map((component) => component.label)).toEqual([
      "Computer",
      "Codex CLI",
      "Lark CLI",
      "Slack CLI",
    ]);
    const runtime = preparation.components.find((component) => component.id === "runtime:codex");
    if (!runtime) throw new Error("missing runtime row");
    expect(runtime.status).toBe("install_required");
    expect(runtime.blocking).toBe(true);
    // OpenTag never installs a Runtime CLI: the next action is an explicit instruction and the
    // verify command is the idempotent read-only runtime-inspect.
    expect(runtime.nextAction?.command).toBeUndefined();
    expect(runtime.nextAction?.instruction).toBe(
      "Install and sign in to the Codex CLI yourself (OpenTag never installs Runtime CLIs), then run the verify command.",
    );
    expect(runtime.verifyAction?.command).toContain("computer runtime-inspect --provider codex");
    const jsonText = JSON.stringify(preparation.components);
    expect(jsonText).not.toContain("provider-cli ensure");
    expect(jsonText).not.toContain("daemon install");
  });

  it("keeps an auto-repairable Provider CLI failure a command and a manual one an instruction", async () => {
    const autoRepair = fixture.scenarios.find((candidate) => candidate.id === "lark-cli-failure");
    const manual = fixture.scenarios.find((candidate) => candidate.id === "manual-repair-slack");
    if (!autoRepair || !manual) throw new Error("missing repair scenarios");

    mockScenarioWorld(autoRepair);
    const autoPreparation = envelopeOf(await run(autoRepair, true)).result?.preparation;
    if (!autoPreparation) throw new Error("no auto preparation");
    const autoLark = autoPreparation.components.find((component) => component.id === "im-cli:lark");
    if (!autoLark) throw new Error("missing lark row");
    expect(autoLark.status).toBe("install_required");
    expect(autoLark.blocking).toBe(true);
    expect(autoLark.nextAction?.command).toContain("provider-cli ensure --provider lark");
    expect(autoLark.nextAction?.instruction).toBeUndefined();
    expect(autoLark.verifyAction?.command).toContain("provider-cli inspect --provider lark");
    expect(autoLark.verifyAction?.command).not.toBe(autoLark.nextAction?.command);

    vi.restoreAllMocks();
    mockScenarioWorld(manual);
    const manualPreparation = envelopeOf(await run(manual, true)).result?.preparation;
    if (!manualPreparation) throw new Error("no manual preparation");
    const manualSlack = manualPreparation.components.find((component) => component.id === "im-cli:slack");
    if (!manualSlack) throw new Error("missing slack row");
    expect(manualSlack.status).toBe("needs_attention");
    expect(manualSlack.blocking).toBe(true);
    expect(manualSlack.nextAction?.command).toBeUndefined();
    expect(manualSlack.nextAction?.instruction).toBe(
      "Install the Slack CLI version pinned by this workspace, then run the verify command.",
    );
    expect(manualSlack.verifyAction?.command).toContain("provider-cli inspect --provider slack");
  });

  it("keeps a non-blocking warning from changing the ready verdict", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "warning-non-blocking");
    if (!scenario) throw new Error("missing warning-non-blocking scenario");
    mockScenarioWorld(scenario);
    const jsonRun = await run(scenario, true);
    const preparation = envelopeOf(jsonRun).result?.preparation;
    if (!preparation) throw new Error("no preparation");
    expect(preparation.localReady).toBe(true);
    expect(preparation.status).toBe("ready");
    const lark = preparation.components.find((component) => component.id === "im-cli:lark");
    if (!lark) throw new Error("missing lark row");
    expect(lark.status).toBe("ready");
    expect(lark.blocking).toBe(false);
    expect(lark.warnings).toEqual([
      {
        code: "global_path_not_configured",
        message: "Add the CLI directory to your PATH for future shells.",
        blocking: false,
      },
    ]);
    const humanRun = await run(scenario, false);
    expect(humanRun.stdout).toContain("warning (non-blocking): global_path_not_configured");
    expect(humanRun.exitCode).toBe(0);
  });

  it("reports checking ownership as a real checking row and never claims installation", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "checking-ownership");
    if (!scenario) throw new Error("missing checking-ownership scenario");
    mockScenarioWorld(scenario);
    const jsonRun = await run(scenario, true);
    const preparation = envelopeOf(jsonRun).result?.preparation;
    if (!preparation) throw new Error("no preparation");
    const lark = preparation.components.find((component) => component.id === "im-cli:lark");
    if (!lark) throw new Error("missing lark row");
    expect(lark.status).toBe("checking");
    expect(lark.blocking).toBe(true);
    expect(lark.message).toContain("owned by another OpenTag process");
    const humanRun = await run(scenario, false);
    expect(humanRun.stderr).toContain("[im-cli:lark] checking (blocking)");
    expect(humanRun.stderr).toContain("owned by another OpenTag process");
  });

  it("skips only the daemon when --no-start is real and prints idempotent install and status commands", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "daemon-skipped");
    if (!scenario) throw new Error("missing daemon-skipped scenario");
    mockScenarioWorld(scenario);
    const jsonRun = await run(scenario, true);
    const envelope = envelopeOf(jsonRun);
    const preparation = envelope.result?.preparation;
    if (!preparation) throw new Error("no preparation");
    expect(envelope.ok).toBe(false);
    expect(jsonRun.exitCode).toBe(3);
    const computer = preparation.components.find((component) => component.id === "computer");
    if (!computer) throw new Error("missing computer row");
    expect(computer.status).toBe("needs_attention");
    expect(computer.blocking).toBe(true);
    const daemon = computer.checks?.find((check) => check.id === "computer:daemon");
    if (!daemon) throw new Error("missing daemon child check");
    expect(daemon.status).toBe("skipped");
    expect(daemon.blocking).toBe(true);
    expect(daemon.message).toContain("--no-start");
    expect(daemon.nextAction?.command).toContain("daemon install");
    expect(daemon.verifyAction?.command).toContain("daemon status");
    expect(daemon.nextAction?.command).not.toBe(daemon.verifyAction?.command);
    const humanRun = await run(scenario, false);
    expect(humanRun.stderr).toContain("[computer:daemon] skipped (blocking)");
    expect(humanRun.stderr).toContain("daemon install");
    expect(humanRun.stderr).toContain("daemon status");
  });

  it("never exchanges the one-time code twice or claims Server readiness for any scenario", async () => {
    for (const scenario of fixture.scenarios) {
      const connectSpy = mockScenarioWorld(scenario);
      const jsonRun = await run(scenario, true);
      expect(jsonRun.exitCode).toBe(scenario.local.expected.exitCode);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({ code: CONNECT_CODE, home: TEST_HOME }));
      // No scenario output ever claims the Server side is ready or suggests retrying the
      // one-time code (the error envelope legitimately says the code must NOT be reused).
      const output = jsonRun.stdout + jsonRun.stderr;
      expect(output).not.toMatch(/Server is ready|ready on the Server|retry the one-time code|run .*connect.* again/i);
      expect(output).toContain(SERVER_CONFIRMATION_GUIDANCE);
      vi.restoreAllMocks();
    }
  });
});
