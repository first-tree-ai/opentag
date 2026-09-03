import { type ProviderCliEnsureResult, ProviderCliManager, type ProviderCliProvider } from "@opentag/client";
import {
  type AgentRuntimeProvider,
  LocalComputerPreparationResultSchema,
  type LocalPreparationComponent,
} from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as connect from "../core/computer/connect.js";
import { formatPreparationResultLines } from "../core/computer/formatting.js";
import * as preparation from "../core/computer/preparation.js";
import * as runtime from "../core/computer/runtime-probe.js";
import * as provider from "../core/provider-cli/ensure.js";

const now = () => new Date("2026-09-03T00:00:00.000Z");
const home = "/tmp/f3 home 'quoted'";
const service = {
  currentHome: home,
  definitionPath: `${home}/service`,
  logHint: "logs",
  platform: "systemd" as const,
  serviceId: "opentag-dev",
  state: "active" as const,
};
const connection = {
  agentId: "11111111-1111-4111-8111-111111111111",
  computerId: "computer-1",
  credentialsPath: `${home}/config/computer-credentials.json`,
  message: "Connected this Computer",
  runtimeProvider: "claude-code" as const,
  service,
};
const initialExitCode = process.exitCode;

function readyRuntime(provider: AgentRuntimeProvider): LocalPreparationComponent {
  return runtime.runtimeComponentFromProbeResult(
    provider,
    { ready: true, issues: [], version: "1.0.0" },
    now().toISOString(),
  );
}

function readyProvider(provider: ProviderCliProvider): ProviderCliEnsureResult {
  return {
    ok: true,
    provider,
    action: "noop",
    phases: [],
    candidates: [],
    readiness: "ready",
    selected: { path: `/managed/${provider}`, version: "1.0.0", source: "managed", trust: "catalog-verified" },
    globalCommand: { active: true },
    warnings: [],
  };
}

function failedProvider(
  provider: ProviderCliProvider,
  code: NonNullable<ProviderCliEnsureResult["diagnostic"]>["code"],
): ProviderCliEnsureResult {
  return {
    ...readyProvider(provider),
    selected: undefined,
    ok: false,
    action: "failed",
    readiness: "unavailable",
    diagnostic: { code },
  };
}

beforeEach(() => {
  process.exitCode = undefined;
  vi.spyOn(connect, "runComputerConnect").mockResolvedValue(connection);
  vi.spyOn(runtime, "probeRuntimeComponent").mockImplementation(async ({ provider }) => readyRuntime(provider));
  vi.spyOn(provider, "runProviderCliEnsure").mockResolvedValue({
    exitCode: 0,
    results: [readyProvider("feishu"), readyProvider("slack")],
    nextActions: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = initialExitCode;
});

async function invoke(flags: string[] = []) {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await createProgram().parseAsync(["node", "opentag", "connect", "one-time-code", "--home", home, ...flags]);
  const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
  const err = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
  stdout.mockRestore();
  stderr.mockRestore();
  return { out, err, text: out + err, exitCode: process.exitCode };
}

describe("targeted local Computer preparation", () => {
  it.each(["codex", "claude-code"] as const)("checks only the exact selected %s Runtime", async (runtimeProvider) => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({ ...connection, runtimeProvider });
    const output = await invoke(["--json"]);
    const document = JSON.parse(output.out);
    expect(runtime.probeRuntimeComponent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ provider: runtimeProvider }),
    );
    expect(provider.runProviderCliEnsure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "all" }));
    expect(document).toMatchObject({
      ok: true,
      result: { connected: true, preparation: { status: "ready", localReady: true, readyCount: 4, requiredCount: 4 } },
    });
    const result = LocalComputerPreparationResultSchema.parse(document.result.preparation);
    expect(result.components.map(({ id }) => id)).toEqual([
      "computer",
      `runtime:${runtimeProvider}`,
      "im-cli:lark",
      "im-cli:slack",
    ]);
    expect(output.err).toBe("");
    expect(output.exitCode).toBe(0);
    expect(document.result.guidance).toEqual([preparation.SERVER_CONFIRMATION_GUIDANCE]);
  });

  it("renders the ready human golden projection without claiming Server readiness", async () => {
    const result = await preparation.runLocalComputerPreparation({
      ...connection,
      home,
      noStart: false,
      prepareProviderClis: true,
      now,
    });
    expect(formatPreparationResultLines(result).join("\n")).toBe(
      [
        "Local computer preparation: READY",
        "4 / 4 ready",
        "[computer] ready",
        "  [computer:connection] ready",
        "  [computer:daemon] ready",
        "[runtime:claude-code] ready — 1.0.0",
        "[im-cli:lark] ready — 1.0.0",
        "[im-cli:slack] ready — 1.0.0",
      ].join("\n"),
    );
    const output = await invoke();
    expect(output.text).toContain("Local computer preparation: READY");
    expect(output.text).toContain(preparation.SERVER_CONFIRMATION_GUIDANCE);
    expect(output.text).not.toMatch(/choose Lark|choose Slack|Server ready|Computer.*online/);
  });

  const scenarios = [
    {
      name: "Lark fails",
      results: [failedProvider("feishu", "install_incomplete"), readyProvider("slack")],
      count: 3,
      codes: ["install_incomplete"],
    },
    {
      name: "Slack fails",
      results: [readyProvider("feishu"), failedProvider("slack", "probe_failed")],
      count: 3,
      codes: ["probe_failed"],
    },
    {
      name: "both fail",
      results: [failedProvider("feishu", "probe_failed"), failedProvider("slack", "probe_failed")],
      count: 2,
      codes: ["probe_failed", "probe_failed"],
    },
    {
      name: "manual repair",
      results: [readyProvider("feishu"), failedProvider("slack", "integrity_failed")],
      count: 3,
      codes: ["integrity_failed"],
    },
    {
      name: "lock held",
      results: [readyProvider("feishu"), failedProvider("slack", "operation_in_progress")],
      count: 3,
      codes: ["operation_in_progress"],
    },
    {
      name: "missing result despite exit zero",
      results: [readyProvider("slack")],
      count: 3,
      codes: ["provider_result_missing"],
    },
  ];

  it.each(scenarios)(
    "keeps human/JSON outcomes and repair actions aligned: $name",
    async ({ results, count, codes }) => {
      vi.mocked(provider.runProviderCliEnsure).mockResolvedValue({ exitCode: 0, results, nextActions: [] });
      const json = await invoke(["--json"]);
      const document = JSON.parse(json.err);
      expect(json.out).toBe("");
      expect(json.err.trim().split("\n")).toHaveLength(1);
      expect(document).toMatchObject({
        ok: false,
        error: {
          code: preparation.LOCAL_COMPUTER_PREPARATION_INCOMPLETE,
          category: "dependency",
          retryability: "never",
        },
        result: {
          connected: true,
          preparation: { status: "needs_attention", localReady: false, readyCount: count, requiredCount: 4 },
        },
      });
      const parsed = LocalComputerPreparationResultSchema.parse(document.result.preparation);
      expect(preparation.preparationBlockerCodes(parsed)).toEqual(codes);
      const human = await invoke();
      expect(human.err).toContain("Local computer preparation: NEEDS_ATTENTION");
      expect(human.err).toContain(`${count} / 4 ready`);
      expect(human.exitCode).toBe(json.exitCode);
      expect(human.exitCode).toBe(3);
      expect(human.err).toContain(preparation.NO_CODE_REUSE_GUIDANCE);
      expect(document.result.guidance).toContain(preparation.NO_CODE_REUSE_GUIDANCE);
      expect(human.err).toContain(`Blocked by: ${codes.join(", ")}`);
      expect(document.result.guidance).toContain(`Blocked by: ${codes.join(", ")}`);
      for (const row of parsed.components.filter((row) => row.id.startsWith("im-cli:") && row.blocking)) {
        const action = row.nextAction;
        expect(action).toBeDefined();
        expect(row.verifyAction?.command).toContain("provider-cli inspect");
        expect(human.err).toContain(action?.command ?? action?.instruction);
        if (row.diagnosticCode === "integrity_failed") {
          expect(action?.command).toBeUndefined();
          expect(action?.instruction).toContain("manually");
        } else expect(action?.command).toContain("provider-cli ensure --provider");
      }
    },
  );

  it.each([
    "artifact_missing",
    "credential_missing",
    "version_incompatible",
    "configuration_invalid",
    "temporarily_unavailable",
  ] as const)("still ensures both Providers after Runtime %s", async (code) => {
    vi.mocked(runtime.probeRuntimeComponent).mockResolvedValue(
      runtime.runtimeComponentFromProbeResult(
        "claude-code",
        { ready: false, issues: [{ code, message: "private child output" }] },
        now().toISOString(),
      ),
    );
    const output = await invoke(["--json"]);
    const document = JSON.parse(output.err);
    expect(provider.runProviderCliEnsure).toHaveBeenCalledOnce();
    expect(document.result.preparation).toMatchObject({ readyCount: 3, requiredCount: 4, localReady: false });
    expect(document.result.preparation.components[1]).toMatchObject({
      id: "runtime:claude-code",
      blocking: true,
      diagnosticCode: code,
      verifyAction: { command: expect.stringContaining("runtime-inspect --provider claude-code") },
    });
    expect(document.result.preparation.components[1].nextAction.command).toBeUndefined();
    expect(output.text).not.toContain("private child output");
    expect(output.text).not.toContain("npm install");
    expect(document.error.retryability).toBe("never");
    expect(document.result.connected).toBe(true);
  });

  it("fails closed on an old Server without guessing or probing a Runtime", async () => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({ ...connection, runtimeProvider: undefined });
    const output = await invoke(["--json"]);
    const document = JSON.parse(output.err);
    expect(runtime.probeRuntimeComponent).not.toHaveBeenCalled();
    expect(provider.runProviderCliEnsure).toHaveBeenCalledOnce();
    expect(document.result.preparation.components[1]).toMatchObject({
      id: "runtime:unconfirmed",
      blocking: true,
      diagnosticCode: "RUNTIME_UNCONFIRMED",
      nextAction: { instruction: expect.stringContaining("Upgrade") },
    });
    expect(document.result.connected).toBe(true);
    expect(output.text).not.toContain("runtime:codex");
  });

  it("no-start skips only daemon, and preserves the custom Home in independent repair/verify", async () => {
    const output = await invoke(["--no-start", "--json"]);
    expect(provider.runProviderCliEnsure).toHaveBeenCalledOnce();
    expect(runtime.probeRuntimeComponent).toHaveBeenCalledOnce();
    expect(connect.runComputerConnect).toHaveBeenCalledWith(expect.objectContaining({ noStart: true, home }));
    const computer = JSON.parse(output.err).result.preparation.components[0];
    expect(computer).toMatchObject({ status: "needs_attention", blocking: true });
    expect(computer.checks[1]).toMatchObject({ status: "skipped", blocking: true });
    expect(computer.checks[1].nextAction.command).toBe(
      `OPENTAG_HOME='/tmp/f3 home '"'"'quoted'"'"'' "$HOME/.local/bin/opentag-dev" daemon install`,
    );
    expect(computer.checks[1].verifyAction.command).toContain("daemon status");
    expect(computer.checks[0].status).toBe("ready");
  });

  it("skips Providers only on their explicit flag, not the Runtime probe", async () => {
    const output = await invoke(["--no-prepare-provider-clis", "--json"]);
    const document = JSON.parse(output.err);
    expect(provider.runProviderCliEnsure).not.toHaveBeenCalled();
    expect(runtime.probeRuntimeComponent).toHaveBeenCalledOnce();
    expect(document.result.preparation).toMatchObject({ readyCount: 2, localReady: false });
    expect(document.result.preparation.components.slice(2).map((row: LocalPreparationComponent) => row.status)).toEqual(
      ["skipped", "skipped"],
    );
  });

  it("preserves terminal ready despite an explicit non-blocking PATH warning", async () => {
    vi.mocked(provider.runProviderCliEnsure).mockResolvedValue({
      exitCode: 0,
      results: [
        {
          ...readyProvider("feishu"),
          warnings: [{ code: "global_path_not_configured", remediation: "Use the managed launcher." }],
        },
        readyProvider("slack"),
      ],
      nextActions: [],
    });
    const json = await invoke(["--json"]);
    expect(JSON.parse(json.out).result.preparation.components[2]).toMatchObject({
      status: "ready",
      blocking: false,
      warnings: [{ code: "global_path_not_configured", blocking: false }],
    });
    const human = await invoke();
    expect(human.text).toContain("4 / 4 ready");
    expect(human.text).toContain("warning (non-blocking): global_path_not_configured");
  });

  it.each(["inactive", "unknown", "not-installed"] as const)(
    "does not equate daemon state %s with ready",
    async (state) => {
      vi.mocked(connect.runComputerConnect).mockResolvedValue({ ...connection, service: { ...service, state } });
      const output = await invoke(["--json"]);
      const document = JSON.parse(output.err);
      expect(document.result.preparation.components[0].checks[1]).toMatchObject({
        blocking: true,
        nextAction: { command: expect.stringContaining("daemon install") },
      });
      expect(document.result.connected).toBe(true);
      expect(provider.runProviderCliEnsure).toHaveBeenCalledOnce();
    },
  );

  it("runs all preparation after a daemon installation failure", async () => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({
      ...connection,
      service: undefined,
      serviceError: "service failed",
    });
    const output = await invoke(["--json"]);
    const document = JSON.parse(output.err);
    expect(document.result.preparation.components[0].checks[1]).toMatchObject({
      diagnosticCode: "DAEMON_SERVICE_FAILED",
      blocking: true,
    });
    expect(provider.runProviderCliEnsure).toHaveBeenCalledOnce();
    expect(runtime.probeRuntimeComponent).toHaveBeenCalledOnce();
    expect(document.result.connected).toBe(true);
  });

  it("keeps blank daemon errors valid in normal and fallback projections", async () => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({ ...connection, service: undefined, serviceError: "  " });
    const normal = await invoke(["--json"]);
    vi.spyOn(preparation, "runLocalComputerPreparation").mockRejectedValue(new Error("projection failed"));
    const fallback = await invoke(["--json"]);
    for (const output of [normal, fallback]) {
      const result = LocalComputerPreparationResultSchema.parse(JSON.parse(output.err).result.preparation);
      expect(result.components[0]?.checks?.[1]).toMatchObject({ message: "Daemon service failed.", blocking: true });
      expect(JSON.parse(output.err).result.connected).toBe(true);
    }
  });

  it("does not lose the connection or Provider results when Runtime throws unexpectedly", async () => {
    vi.mocked(runtime.probeRuntimeComponent).mockRejectedValue(new Error("unexpected Runtime failure"));
    const output = await invoke(["--json"]);
    const document = JSON.parse(output.err);
    expect(document.result.preparation).toMatchObject({ readyCount: 3, requiredCount: 4 });
    expect(document.result.preparation.components[1].diagnosticCode).toBe("runtime_probe_failed");
    expect(document.result.connected).toBe(true);
    expect(connect.runComputerConnect).toHaveBeenCalledOnce();
  });

  it("renders all rows after unexpected ensure or projection errors without reconnecting", async () => {
    vi.mocked(provider.runProviderCliEnsure).mockRejectedValue(new Error("ensure crashed"));
    const output = await invoke(["--json"]);
    expect(JSON.parse(output.err).result.preparation.components).toHaveLength(4);
    expect(JSON.parse(output.err).result.connected).toBe(true);
    vi.spyOn(preparation, "runLocalComputerPreparation").mockRejectedValue(new Error("projection failed"));
    const fallback = await invoke(["--json"]);
    expect(
      LocalComputerPreparationResultSchema.parse(JSON.parse(fallback.err).result.preparation).components,
    ).toHaveLength(4);
    expect(JSON.parse(fallback.err).error.retryability).toBe("never");
    for (const caseOutput of [output, fallback]) {
      const rows = JSON.parse(caseOutput.err).result.preparation.components.slice(2);
      expect(rows.map((row: LocalPreparationComponent) => row.verifyAction?.command)).toEqual([
        '"$HOME/.local/bin/opentag-dev" provider-cli inspect --provider lark',
        '"$HOME/.local/bin/opentag-dev" provider-cli inspect --provider slack',
      ]);
    }
    expect(connect.runComputerConnect).toHaveBeenCalledTimes(2);
    expect(provider.runProviderCliEnsure).toHaveBeenCalledTimes(1);
  });

  it("validates projection invariants and counts required rows in both paths", async () => {
    const ready = readyRuntime("codex");
    expect(preparation.projectPreparation([ready, { ...ready, id: "optional", required: false }])).toMatchObject({
      readyCount: 1,
      requiredCount: 1,
      localReady: true,
    });
    expect(() => preparation.projectPreparation([{ ...ready, blocking: true }])).toThrow("cannot be blocking");
    vi.mocked(runtime.probeRuntimeComponent).mockResolvedValue({ ...ready, blocking: true });
    const output = await invoke(["--json"]);
    const result = LocalComputerPreparationResultSchema.parse(JSON.parse(output.err).result.preparation);
    expect(result).toMatchObject({ readyCount: 1, requiredCount: 4, localReady: false });
    expect(result.components[1]?.diagnosticCode).toBe("runtime_probe_failed");
    expect(connect.runComputerConnect).toHaveBeenCalledOnce();
  });

  it.each([true, false])("preserves a consumed-code local persistence failure (targeted: %s)", async (targeted) => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({
      ...connection,
      agentId: targeted ? connection.agentId : undefined,
      service: undefined,
      persistenceError: {
        stage: "credentials",
        installationId: "22222222-2222-4222-8222-222222222222",
        message: "disk full",
      },
    });
    const json = await invoke(["--json"]);
    expect(JSON.parse(json.err)).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_LOCAL_PERSISTENCE_FAILED", retryability: "never" },
      result: { connected: true, codeConsumed: true, localPersistenceReady: false },
    });
    expect(json.out).toBe("");
    expect(json.exitCode).toBe(3);
    const human = await invoke();
    expect(human.err).toContain("Do not reuse it");
    expect(human.err).toContain("previous credentials may no longer work");
    expect(human.err).toContain("computer repair-local --installation-id 22222222-2222-4222-8222-222222222222");
    expect(human.err).toContain(`--home '/tmp/f3 home '"'"'quoted'"'"''`);
    expect(human.err).toContain("NEW connect/repair code");
    expect(provider.runProviderCliEnsure).not.toHaveBeenCalled();
    expect(runtime.probeRuntimeComponent).not.toHaveBeenCalled();
  });

  it("does not invent preparation for an untargeted connection", async () => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({
      ...connection,
      agentId: undefined,
      runtimeProvider: undefined,
    });
    const output = await invoke(["--json"]);
    expect(JSON.parse(output.out)).toMatchObject({ ok: true, result: { connected: true } });
    expect(JSON.parse(output.out).result).not.toHaveProperty("preparation");
    expect(provider.runProviderCliEnsure).not.toHaveBeenCalled();
    expect(runtime.probeRuntimeComponent).not.toHaveBeenCalled();
  });

  it("forwards only real ensure phases when connect owns presentation", async () => {
    vi.mocked(provider.runProviderCliEnsure).mockRestore();
    vi.spyOn(ProviderCliManager.prototype, "ensure").mockImplementation(async (provider, options) => {
      options?.onPhase?.({ provider, phase: "verify", status: "completed", detail: "actual artifact verified" });
      return readyProvider(provider);
    });
    const human = await invoke();
    expect(human.out).toContain("[im-cli:lark] verify: completed — actual artifact verified");
    expect(human.out).toContain("[im-cli:slack] verify: completed — actual artifact verified");
    const json = await invoke(["--json"]);
    expect(json.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(json.out).ok).toBe(true);
    expect(json.err).toBe("");
  });

  it("preserves an ordinary connection on daemon failure without retrying the code", async () => {
    vi.mocked(connect.runComputerConnect).mockResolvedValue({
      ...connection,
      agentId: undefined,
      runtimeProvider: undefined,
      service: undefined,
      serviceError: "failed",
    });
    const json = await invoke(["--json"]);
    expect(JSON.parse(json.err)).toMatchObject({
      ok: false,
      error: { code: "DAEMON_SERVICE_FAILED", retryability: "never", phase: "startup" },
      result: { connected: true },
    });
    expect(json.text).toContain("daemon install");
    expect(provider.runProviderCliEnsure).not.toHaveBeenCalled();
  });

  it("reports a pre-exchange failure as one JSON envelope without claiming connection", async () => {
    vi.mocked(connect.runComputerConnect).mockRejectedValue(new Error("connection refused"));
    const output = await invoke(["--json"]);
    expect(JSON.parse(output.err)).toMatchObject({ ok: false, error: { category: "unavailable" } });
    expect(JSON.parse(output.err)).not.toHaveProperty("result");
    expect(provider.runProviderCliEnsure).not.toHaveBeenCalled();
  });
});
