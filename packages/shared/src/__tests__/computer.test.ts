import { describe, expect, it } from "vitest";
import {
  AccountComputerConnectCodeIssueRequestSchema,
  COMPUTER_RUNTIME_PROVIDER_CAPABILITY,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerConnectCodeStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerProviderReadinessCollectionSchema,
  clientSupportsComputerRuntimeProvider,
  LocalComputerPreparationResultSchema,
  LocalPreparationActionSchema,
  LocalPreparationCheckSchema,
  LocalPreparationComponentSchema,
  withComputerRuntimeProviderSupport,
} from "../computer.js";
import { compareSemVer } from "../semver.js";

describe("computer contracts", () => {
  it("returns strict Computer-scoped machine authority", () => {
    const response = {
      agentId: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      machineToken: "opaque-secret",
    };
    expect(ComputerConnectCodeExchangeResponseSchema.parse(response)).toEqual(response);
    expect(() => ComputerConnectCodeExchangeResponseSchema.parse({ ...response, accessToken: "human" })).toThrow();
  });

  it("treats an empty Account connect-code request as create and requires an explicit repair target", () => {
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({})).toEqual({});
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "create" })).toEqual({ mode: "create" });
    const targetAgentId = crypto.randomUUID();
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "create", targetAgentId })).toEqual({
      mode: "create",
      targetAgentId,
    });
    const targetComputerId = crypto.randomUUID();
    expect(
      AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "repair", targetAgentId, targetComputerId }),
    ).toEqual({ mode: "repair", targetAgentId, targetComputerId });
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "repair" })).toThrow();
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "create", targetComputerId })).toThrow();
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ accountId: crypto.randomUUID() })).toThrow();
  });

  it("keeps exchange as an installation report rather than a Computer identity hint", () => {
    const request = {
      code: "otcc_abcdefghijklmnopqrstuvwx",
      installationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.2",
    };
    expect(ComputerConnectCodeExchangeRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      ComputerConnectCodeExchangeRequestSchema.parse({ ...request, targetComputerId: crypto.randomUUID() }),
    ).toThrow();
    expect(() => ComputerConnectCodeExchangeRequestSchema.parse({ ...request, mode: "repair" })).toThrow();
  });

  it("accepts optional create and repair mode on the issue response", () => {
    const response = {
      connectCodeId: crypto.randomUUID(),
      bootstrapCommand: "opentag connect --server https://opentag.example -- otcc_code",
      expiresIn: 900,
      issuedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(ComputerConnectCodeIssueResponseSchema.parse(response)).toEqual(response);
    expect(ComputerConnectCodeIssueResponseSchema.parse({ ...response, mode: "repair" })).toEqual({
      ...response,
      mode: "repair",
    });
    expect(() => ComputerConnectCodeIssueResponseSchema.parse({ ...response, mode: "merge" })).toThrow();
  });

  it("requires the non-secret connectCodeId on the issue response", () => {
    const response = {
      bootstrapCommand: "opentag connect --server https://opentag.example -- otcc_code",
      expiresIn: 900,
      issuedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(() => ComputerConnectCodeIssueResponseSchema.parse(response)).toThrow();
    expect(() => ComputerConnectCodeIssueResponseSchema.parse({ ...response, connectCodeId: "not-a-uuid" })).toThrow();
  });

  it("correlates a redeemed code with exactly the Computer that redeemed it, and nothing else", () => {
    const connectCodeId = crypto.randomUUID();
    const computerId = crypto.randomUUID();
    const redeemed = {
      connectCodeId,
      state: "redeemed",
      computerId,
      redeemedAt: "2026-08-29T00:00:10.000Z",
    };
    expect(ComputerConnectCodeStatusSchema.parse(redeemed)).toEqual(redeemed);

    for (const state of ["pending", "expired", "revoked"] as const) {
      const quiet = { connectCodeId, state, computerId: null, redeemedAt: null };
      expect(ComputerConnectCodeStatusSchema.parse(quiet)).toEqual(quiet);
    }

    // The correlation read must never become a channel for the code, its hash, or a machine token.
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, code: "otcc_raw" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, tokenHash: "abc123" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, machineToken: "otmc_secret" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, state: "consumed" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, computerId: null })).toThrow();
    expect(() =>
      ComputerConnectCodeStatusSchema.parse({
        connectCodeId,
        state: "pending",
        computerId,
        redeemedAt: "2026-08-29T00:00:10.000Z",
      }),
    ).toThrow();
  });

  it("keeps provider readiness canonical", () => {
    expect(() =>
      ComputerProviderReadinessCollectionSchema.parse([
        { provider: "claude-code", status: "ready", observedAt: null },
        { provider: "codex", status: "ready", observedAt: null },
      ]),
    ).toThrow();
    expect(() =>
      ComputerProviderReadinessCollectionSchema.parse([
        { provider: "codex", status: "ready", observedAt: null },
        { provider: "codex", status: "checking", observedAt: null },
      ]),
    ).toThrow("Provider readiness must be unique");
  });

  it("enforces unique canonical order for IM CLI readiness", () => {
    expect(
      ComputerImCliReadinessCollectionSchema.parse([{ provider: "feishu", status: "ready", observedAt: null }]),
    ).toEqual([{ provider: "feishu", status: "ready", observedAt: null }]);
    expect(() =>
      ComputerImCliReadinessCollectionSchema.parse([
        { provider: "slack", status: "ready", observedAt: null },
        { provider: "slack", status: "checking", observedAt: null },
      ]),
    ).toThrow("IM CLI readiness must be unique");
    expect(() =>
      ComputerImCliReadinessCollectionSchema.parse([
        { provider: "slack", status: "ready", observedAt: null },
        { provider: "feishu", status: "checking", observedAt: null },
      ]),
    ).toThrow("IM CLI readiness must use canonical Provider order");
  });

  it("marks a Client version with the connect runtime provider capability metadata", () => {
    expect(COMPUTER_RUNTIME_PROVIDER_CAPABILITY).toBe("opentag-connect-runtime-v1");
    expect(withComputerRuntimeProviderSupport("0.0.2")).toBe("0.0.2+opentag-connect-runtime-v1");
    expect(withComputerRuntimeProviderSupport("0.0.3-staging.1.0")).toBe(
      "0.0.3-staging.1.0+opentag-connect-runtime-v1",
    );
    expect(withComputerRuntimeProviderSupport("0.0.3+build.7")).toBe("0.0.3+build.7.opentag-connect-runtime-v1");
    expect(withComputerRuntimeProviderSupport("0.0.3-rc.1+build.7")).toBe(
      "0.0.3-rc.1+build.7.opentag-connect-runtime-v1",
    );
  });

  it("keeps the marker idempotent and invisible to SemVer precedence", () => {
    const marked = withComputerRuntimeProviderSupport("0.0.3+build.7");
    expect(withComputerRuntimeProviderSupport(marked)).toBe(marked);
    expect(compareSemVer(marked, "0.0.3+build.7")).toBe(0);
    expect(compareSemVer("0.0.3", marked)).toBe(0);
  });

  it("rejects Client versions that cannot carry the marker within the 64-character bound", () => {
    for (const invalid of ["", "latest", "v0.0.2", "0.0.2.1", "0.0.3-alpha..1", "0.0.3+build..7", "00.0.3"]) {
      expect(() => withComputerRuntimeProviderSupport(invalid), invalid).toThrow(TypeError);
    }
    // A 37-character base plus the 27-character marker fits exactly; 38 does not.
    const atBoundary = `0.0.3-${`a`.repeat(31)}`;
    const markedAtBoundary = withComputerRuntimeProviderSupport(atBoundary);
    expect(markedAtBoundary).toBe(`0.0.3-${`a`.repeat(31)}+opentag-connect-runtime-v1`);
    expect(markedAtBoundary).toHaveLength(64);
    expect(() => withComputerRuntimeProviderSupport(`0.0.3-${`a`.repeat(32)}`)).toThrow(TypeError);
  });

  it("preserves large SemVer numeric identifiers without rounding or scientific notation", () => {
    for (const version of ["9007199254740993.0.0", "1000000000000000000000.0.0", "0.0.3+build.9007199254740993"]) {
      const marked = withComputerRuntimeProviderSupport(version);
      expect(marked).toBe(`${version}${version.includes("+") ? "." : "+"}opentag-connect-runtime-v1`);
      expect(withComputerRuntimeProviderSupport(marked)).toBe(marked);
      expect(clientSupportsComputerRuntimeProvider(marked)).toBe(true);
    }
  });

  it("recognizes the exact capability marker and fails closed on anything else", () => {
    expect(clientSupportsComputerRuntimeProvider("0.0.3+opentag-connect-runtime-v1")).toBe(true);
    expect(clientSupportsComputerRuntimeProvider(withComputerRuntimeProviderSupport("0.0.3-staging.1.0"))).toBe(true);
    expect(clientSupportsComputerRuntimeProvider("0.0.3+build.7.opentag-connect-runtime-v1")).toBe(true);
    expect(clientSupportsComputerRuntimeProvider("0.0.2")).toBe(false);
    for (const invalid of ["", "latest", "v0.0.3", "0.0.2.1", "0.0.3+build..7"]) {
      expect(clientSupportsComputerRuntimeProvider(invalid), invalid).toBe(false);
    }
    // Overlong even though it carries the exact marker (base already exceeds the Client bound).
    expect(clientSupportsComputerRuntimeProvider(`0.0.3-${`a`.repeat(38)}+opentag-connect-runtime-v1`)).toBe(false);
    // Unknown or lookalike markers never match the exact capability identifier.
    for (const lookalike of [
      "0.0.3+opentag-connect-runtime-v2",
      "0.0.3+x-opentag-connect-runtime-v1",
      "0.0.3+opentag-connect-runtime-v1x",
      "0.0.3+opentag_connect_runtime_v1",
      "0.0.3-opentag-connect-runtime-v1",
    ]) {
      expect(clientSupportsComputerRuntimeProvider(lookalike), lookalike).toBe(false);
    }
  });

  it("keeps the exchange response pair strict: runtimeProvider only next to its bound Agent", () => {
    const agentId = crypto.randomUUID();
    for (const runtimeProvider of ["codex", "claude-code"] as const) {
      const response = {
        agentId,
        runtimeProvider,
        computerId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
        machineToken: "opaque-secret",
      };
      expect(ComputerConnectCodeExchangeResponseSchema.parse(response)).toEqual(response);
    }
    const legacy = {
      agentId,
      computerId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      machineToken: "opaque-secret",
    };
    expect(ComputerConnectCodeExchangeResponseSchema.parse(legacy)).toEqual(legacy);
    expect(() =>
      ComputerConnectCodeExchangeResponseSchema.parse({
        runtimeProvider: "codex",
        computerId: crypto.randomUUID(),
        installationId: crypto.randomUUID(),
        machineToken: "opaque-secret",
      }),
    ).toThrow("runtimeProvider is only meaningful next to the bound agentId it describes");
  });

  it("accepts a fully ready local computer preparation result with child Checks", () => {
    const result = {
      status: "ready" as const,
      localReady: true,
      readyCount: 4,
      requiredCount: 4,
      components: [
        {
          id: "computer",
          label: "Computer",
          required: true,
          status: "ready" as const,
          blocking: false,
          checks: [
            {
              id: "computer:credential",
              label: "Machine credential",
              required: true,
              status: "ready" as const,
              blocking: false,
            },
            {
              id: "computer:daemon",
              label: "Daemon service",
              required: true,
              status: "ready" as const,
              blocking: false,
              phase: "started",
              observedAt: "2026-08-30T00:00:00.000Z",
            },
          ],
        },
        {
          id: "runtime:codex",
          label: "Codex CLI",
          required: true,
          status: "ready" as const,
          blocking: false,
          version: "0.45.0",
        },
        {
          id: "im-cli:lark",
          label: "Lark CLI",
          required: true,
          status: "ready" as const,
          blocking: false,
          warnings: [
            {
              code: "path_shadowed",
              message: "A managed launcher takes precedence over PATH",
              blocking: false,
            },
          ],
        },
        { id: "im-cli:slack", label: "Slack CLI", required: true, status: "ready" as const, blocking: false },
      ],
    };
    expect(LocalComputerPreparationResultSchema.parse(result)).toEqual(result);
  });

  it("accepts an action, Check, and Component with bounded optional detail", () => {
    expect(LocalPreparationActionSchema.parse({ command: "opentag computer repair" })).toEqual({
      command: "opentag computer repair",
    });
    expect(LocalPreparationActionSchema.parse({ instruction: "Install the Codex CLI and retry" })).toEqual({
      instruction: "Install the Codex CLI and retry",
    });
    expect(() => LocalPreparationActionSchema.parse({})).toThrow();
    expect(() => LocalPreparationActionSchema.parse({ command: "  " })).toThrow();
    expect(() => LocalPreparationActionSchema.parse({ command: "x", repair: true })).toThrow();
    const check = {
      id: "runtime:codex:version",
      label: "Codex CLI version",
      required: true,
      status: "install_required" as const,
      blocking: true,
      phase: "detect",
      message: "Codex CLI was not found on PATH",
      diagnosticCode: "runtime_cli_missing",
      nextAction: { command: "npm install -g @openai/codex" },
      verifyAction: { command: "codex --version" },
      warnings: [{ code: "version_unknown", blocking: false }],
    };
    expect(LocalPreparationCheckSchema.parse(check)).toEqual(check);
    const component = LocalPreparationComponentSchema.parse({ ...check, checks: [{ ...check, id: "child" }] });
    expect(component.checks?.[0]?.id).toBe("child");
    expect(() =>
      LocalPreparationCheckSchema.parse({ ...check, warnings: [{ code: "blocked", blocking: true }] }),
    ).toThrow();
    expect(() => LocalPreparationCheckSchema.parse({ ...check, status: "install_required!" })).toThrow();
  });

  it("rejects duplicate top-level ids and inconsistent counts", () => {
    const base = {
      status: "ready" as const,
      localReady: true,
      readyCount: 1,
      requiredCount: 1,
      components: [{ id: "computer", label: "Computer", required: true, status: "ready" as const, blocking: false }],
    };
    expect(LocalComputerPreparationResultSchema.parse(base)).toEqual(base);
    expect(() =>
      LocalComputerPreparationResultSchema.parse({
        ...base,
        readyCount: 0,
        components: [...base.components, { ...base.components[0], label: "Runtime CLI" }],
      }),
    ).toThrow("Component ids must be unique");
    expect(() => LocalComputerPreparationResultSchema.parse({ ...base, readyCount: 0 })).toThrow(
      "readyCount must match",
    );
    expect(() => LocalComputerPreparationResultSchema.parse({ ...base, requiredCount: 0 })).toThrow(
      "requiredCount must match",
    );
    expect(() => LocalComputerPreparationResultSchema.parse({ ...base, localReady: false })).toThrow();
    expect(() =>
      LocalComputerPreparationResultSchema.parse({ ...base, localReady: false, status: "needs_attention" }),
    ).toThrow("localReady must be true");
    expect(() => LocalComputerPreparationResultSchema.parse({ ...base, extra: true })).toThrow();
  });

  it("derives the verdict from required Components and lets optional gaps pass", () => {
    const required = {
      id: "computer",
      label: "Computer",
      required: true,
      status: "ready" as const,
      blocking: false,
    };
    const partial = {
      status: "needs_attention" as const,
      localReady: false,
      readyCount: 2,
      requiredCount: 4,
      components: [
        required,
        {
          id: "runtime:codex",
          label: "Codex CLI",
          required: true,
          status: "needs_attention" as const,
          blocking: true,
          diagnosticCode: "runtime_cli_missing",
          message: "Codex CLI was not found",
          nextAction: { instruction: "Install the Codex CLI, then run opentag computer repair" },
        },
        {
          id: "im-cli:lark",
          label: "Lark CLI",
          required: true,
          status: "ready" as const,
          blocking: false,
        },
        {
          id: "im-cli:slack",
          label: "Slack CLI",
          required: true,
          status: "unavailable" as const,
          blocking: true,
          message: "Slack CLI is not installed",
        },
      ],
    };
    expect(LocalComputerPreparationResultSchema.parse(partial)).toEqual(partial);
    // A "ready" status while a required Component is still unavailable is a contradiction.
    expect(() => LocalComputerPreparationResultSchema.parse({ ...partial, status: "ready" })).toThrow(
      "status must be needs_attention",
    );
    // A false localReady with every required Component ready is also a contradiction.
    expect(() =>
      LocalComputerPreparationResultSchema.parse({
        ...partial,
        components: partial.components.map((component) => ({
          ...component,
          status: "ready" as const,
          blocking: false,
        })),
      }),
    ).toThrow("localReady must be true");
    // Optional Components never gate the verdict, and optional non-ready child Checks do not
    // conceal anything a required/blocking Check would.
    const optionalGap = {
      status: "ready" as const,
      localReady: true,
      readyCount: 2,
      requiredCount: 2,
      components: [
        required,
        { ...required, id: "im-cli:lark", label: "Lark CLI" },
        {
          ...required,
          id: "im-cli:slack",
          label: "Slack CLI",
          required: false,
          status: "skipped" as const,
          blocking: false,
        },
      ],
    };
    expect(LocalComputerPreparationResultSchema.parse(optionalGap)).toEqual(optionalGap);
  });

  it("never lets a ready Component conceal a required or blocking non-ready child Check", () => {
    const concealing = {
      status: "needs_attention" as const,
      localReady: false,
      readyCount: 0,
      requiredCount: 1,
      components: [
        {
          id: "computer",
          label: "Computer",
          required: true,
          status: "ready" as const,
          blocking: false,
          checks: [
            {
              id: "computer:daemon",
              label: "Daemon service",
              required: true,
              status: "skipped" as const,
              blocking: true,
              message: "Daemon was not started because --no-start was passed",
            },
          ],
        },
      ],
    };
    expect(() => LocalComputerPreparationResultSchema.parse(concealing)).toThrow(
      "A ready Component cannot conceal non-ready required/blocking Checks: computer:daemon",
    );
    // The same blocking skipped child is honest once the Component stops claiming ready.
    expect(
      LocalComputerPreparationResultSchema.parse({
        ...concealing,
        components: [
          {
            ...concealing.components[0],
            status: "needs_attention",
            checks: [
              {
                id: "computer:daemon",
                label: "Daemon service",
                required: false,
                status: "skipped" as const,
                blocking: true,
                message: "Daemon was not started because --no-start was passed",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ localReady: false, status: "needs_attention" });
    // A non-blocking skipped child Check is tolerated by a ready Component and cannot block ready.
    expect(
      LocalComputerPreparationResultSchema.parse({
        ...concealing,
        localReady: true,
        readyCount: 1,
        status: "ready",
        components: [
          {
            ...concealing.components[0],
            checks: [
              {
                id: "computer:launcher",
                label: "Launcher service",
                required: false,
                status: "skipped" as const,
                blocking: false,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ localReady: true, status: "ready" });
  });

  it("rejects blocking ready claims and counts only required ready components", () => {
    const component = { id: "computer", label: "Computer", required: true, status: "ready" as const, blocking: false };
    const result = {
      status: "ready" as const,
      localReady: true,
      requiredCount: 1,
      readyCount: 1,
      components: [component],
    };
    expect(() =>
      LocalComputerPreparationResultSchema.parse({ ...result, components: [{ ...component, blocking: true }] }),
    ).toThrow("A ready Component cannot be blocking");
    expect(() =>
      LocalComputerPreparationResultSchema.parse({
        ...result,
        components: [{ ...component, checks: [{ ...component, id: "daemon", blocking: true }] }],
      }),
    ).toThrow("cannot conceal");
    const optionalReady = { ...result, components: [component, { ...component, id: "optional", required: false }] };
    expect(LocalComputerPreparationResultSchema.parse(optionalReady)).toEqual(optionalReady);
    expect(() => LocalComputerPreparationResultSchema.parse({ ...optionalReady, readyCount: 2 })).toThrow(
      "readyCount must match",
    );
    expect(() =>
      LocalComputerPreparationResultSchema.parse({ ...result, components: [], requiredCount: 0, readyCount: 0 }),
    ).toThrow();
  });
});
