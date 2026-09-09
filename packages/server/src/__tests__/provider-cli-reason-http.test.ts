import {
  agentImBindingHandoffPath,
  agentSetupPath,
  HTTP_PATHS,
  imBindingDiagnosticsPath,
  PROVIDER_CLI_REASON_V2_HEADER,
  PROVIDER_READINESS_V1_HEADER,
  projectAgentSetupComponents,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.js";
import type { AgentService, AgentSetupService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";
import type { ImBindingService } from "../services/im-bindings/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
const observedAt = "2026-09-01T10:00:00.000Z";
const authorization = { authorization: "Bearer access" };

const LegacyComputerImCliReadinessSchema = z
  .object({
    provider: z.enum(["feishu", "slack"]),
    status: z.enum(["checking", "install", "ready", "unavailable"]),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

const LegacyProviderCliHandoffProgressSchema = z
  .object({
    phase: z.enum(["preparing_cli", "checking_credentials", "needs_attention"]),
    reason: z
      .enum([
        "provider_unreachable",
        "rate_limited",
        "credential_rejected",
        "identity_mismatch",
        "scope_missing",
        "upgrade_required",
      ])
      .optional(),
  })
  .strict();

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

const listed = {
  computers: [
    {
      computerId,
      displayName: "Laptop",
      platform: "linux" as const,
      connectionStatus: "online" as const,
      imCliReadiness: [
        { provider: "feishu" as const, status: "unavailable" as const, observedAt, reason: "unsupported_platform" },
        { provider: "slack" as const, status: "ready" as const, observedAt },
      ],
      connectedAt: observedAt,
      lastSeenAt: observedAt,
      observedAt,
      createdAt: observedAt,
      agentIds: [agentId],
    },
  ],
};

const setupComputer = {
  kind: "bound" as const,
  computerId,
  displayName: "Laptop",
  platform: "linux" as const,
  connectionStatus: "online" as const,
  lastSeenAt: observedAt,
  imCliReadiness: [
    { provider: "feishu" as const, status: "unavailable" as const, observedAt, reason: "integrity_failed" as const },
    { provider: "slack" as const, status: "ready" as const, observedAt },
  ],
  observedAt,
};
const setupRuntime = { kind: "observed" as const, provider: "codex" as const, status: "ready" as const, observedAt };
const setupMessaging = {
  kind: "waiting-handoff" as const,
  provider: "feishu" as const,
  bindingId: imBindingId,
  credentialGeneration: 1,
  progress: { phase: "needs_attention" as const, reason: "unsupported_platform" as const },
};
const requiredImCliProviders = ["feishu", "slack"] as const;
const snapshot = {
  agent: {
    id: agentId,
    name: "code-reviewer",
    displayName: "Code Reviewer",
    runtimeProvider: "codex" as const,
    receiveMode: "all_message" as const,
    status: "active" as const,
    createdBy: { userId, displayName: "Admin" },
    computer: { computerId, displayName: "Laptop", platform: "linux" as const },
    createdAt: observedAt,
    updatedAt: observedAt,
  },
  stage: "needs-messaging" as const,
  computer: setupComputer,
  runtime: setupRuntime,
  messaging: setupMessaging,
  requiredImCliProviders,
  components: projectAgentSetupComponents({
    computer: setupComputer,
    runtime: setupRuntime,
    messaging: setupMessaging,
    requiredImCliProviders,
  }),
  blockers: [
    {
      code: "messaging-not-ready" as const,
      provider: "feishu" as const,
      bindingId: imBindingId,
      state: "waiting-handoff" as const,
    },
  ],
  actions: [{ kind: "refresh" as const }],
  observedAt,
};

const diagnostics = {
  imBindingId,
  provider: "feishu" as const,
  ready: false,
  agentRuntimeReadiness: "ready" as const,
  providerCliReadiness: "unavailable" as const,
  providerCliReason: "unsupported_platform" as const,
  credentialExecutionReadiness: "needs_attention" as const,
  credentialExecutionReason: "credential_rejected" as const,
  credentialGeneration: 1,
  credentialStatus: "valid" as const,
  requiredCapabilities: [] as string[],
  grantedCapabilities: [] as string[],
  missingCapabilities: [] as string[],
  reauthorizationRequired: false,
  slackAppId: null,
  slackIdentityClosure: null,
  connection: null,
  lastInboundAt: null,
  lastValidatedAt: null,
  lastRuntimeObservationAt: null,
  lastErrorCode: null,
};

const handoff = {
  bindingState: "active" as const,
  handoffReady: false as const,
  providerCli: { phase: "needs_attention" as const, reason: "version_incompatible" as const },
};

const credentialHandoff = {
  bindingState: "active" as const,
  handoffReady: false as const,
  providerCli: { phase: "needs_attention" as const, reason: "credential_rejected" as const },
};

describe("Provider CLI HTTP reason opt-in", () => {
  it("keeps Computer list v1 parsers valid unless reason v2 is requested", async () => {
    const app = createApp({
      authService: authService(),
      computerService: {
        listAccountComputers: vi.fn().mockResolvedValue(listed),
      } as unknown as ComputerService,
    });
    apps.push(app);

    const unmarked = await app.inject({
      method: "GET",
      url: HTTP_PATHS.accountComputers,
      headers: { ...authorization, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    expect(unmarked.json().computers[0].imCliReadiness[0].reason).toBeUndefined();
    expect(LegacyComputerImCliReadinessSchema.parse(unmarked.json().computers[0].imCliReadiness[0])).toMatchObject({
      provider: "feishu",
      status: "unavailable",
    });

    for (const value of ["1", "3", "v2"]) {
      const rejected = await app.inject({
        method: "GET",
        url: HTTP_PATHS.accountComputers,
        headers: {
          ...authorization,
          [PROVIDER_READINESS_V1_HEADER]: "1",
          [PROVIDER_CLI_REASON_V2_HEADER]: value,
        },
      });
      expect(rejected.json().computers[0].imCliReadiness[0].reason).toBeUndefined();
    }

    const v2 = await app.inject({
      method: "GET",
      url: HTTP_PATHS.accountComputers,
      headers: {
        ...authorization,
        [PROVIDER_READINESS_V1_HEADER]: "1",
        [PROVIDER_CLI_REASON_V2_HEADER]: "2",
      },
    });
    expect(v2.json().computers[0].imCliReadiness[0].reason).toBe("unsupported_platform");
    expect(() => LegacyComputerImCliReadinessSchema.parse(v2.json().computers[0].imCliReadiness[0])).toThrow();
  });

  it("strips Agent setup artifact reasons until reason v2", async () => {
    const app = createApp({
      authService: authService(),
      agentService: {} as unknown as AgentService,
      agentSetupService: {
        getSetupById: vi.fn().mockResolvedValue(snapshot),
        refreshPreparationById: vi.fn(),
      } as unknown as AgentSetupService,
    });
    apps.push(app);

    const unmarked = await app.inject({ method: "GET", url: agentSetupPath(agentId), headers: authorization });
    expect(unmarked.json().computer.imCliReadiness[0].reason).toBeUndefined();
    expect(unmarked.json().messaging.progress.reason).toBeUndefined();
    expect(LegacyComputerImCliReadinessSchema.parse(unmarked.json().computer.imCliReadiness[0])).toMatchObject({
      provider: "feishu",
      status: "unavailable",
    });
    expect(LegacyProviderCliHandoffProgressSchema.parse(unmarked.json().messaging.progress)).toEqual({
      phase: "needs_attention",
    });

    const v2 = await app.inject({
      method: "GET",
      url: agentSetupPath(agentId),
      headers: { ...authorization, [PROVIDER_CLI_REASON_V2_HEADER]: "2" },
    });
    expect(v2.json().computer.imCliReadiness[0].reason).toBe("integrity_failed");
    expect(v2.json().messaging.progress.reason).toBe("unsupported_platform");
  });

  it("keeps credential reasons on v1 handoff and gates artifact reasons plus diagnostics", async () => {
    const imBindings = {
      getForAgent: vi.fn(),
      getHandoffForAgent: vi
        .fn()
        .mockResolvedValueOnce(handoff)
        .mockResolvedValueOnce(handoff)
        .mockResolvedValue(credentialHandoff),
      getConfigForAgent: vi.fn(),
      disable: vi.fn(),
      unbindForAgent: vi.fn(),
      diagnostics: vi.fn().mockResolvedValue(diagnostics),
    };
    const app = createApp({
      authService: authService(),
      imBindingService: imBindings as unknown as ImBindingService,
    });
    apps.push(app);

    const unmarkedDiagnostics = await app.inject({
      method: "GET",
      url: imBindingDiagnosticsPath(imBindingId),
      headers: authorization,
    });
    expect(unmarkedDiagnostics.json().providerCliReason).toBeUndefined();
    expect(unmarkedDiagnostics.json().credentialExecutionReason).toBe("credential_rejected");

    const v2Diagnostics = await app.inject({
      method: "GET",
      url: imBindingDiagnosticsPath(imBindingId),
      headers: { ...authorization, [PROVIDER_CLI_REASON_V2_HEADER]: "2" },
    });
    expect(v2Diagnostics.json().providerCliReason).toBe("unsupported_platform");

    const unmarkedHandoff = await app.inject({
      method: "GET",
      url: agentImBindingHandoffPath(agentId),
      headers: authorization,
    });
    expect(unmarkedHandoff.json().providerCli.reason).toBeUndefined();
    expect(LegacyProviderCliHandoffProgressSchema.parse(unmarkedHandoff.json().providerCli)).toEqual({
      phase: "needs_attention",
    });

    const v2Handoff = await app.inject({
      method: "GET",
      url: agentImBindingHandoffPath(agentId),
      headers: { ...authorization, [PROVIDER_CLI_REASON_V2_HEADER]: "2" },
    });
    expect(v2Handoff.json().providerCli.reason).toBe("version_incompatible");
    expect(() => LegacyProviderCliHandoffProgressSchema.parse(v2Handoff.json().providerCli)).toThrow();

    const credential = await app.inject({
      method: "GET",
      url: agentImBindingHandoffPath(agentId),
      headers: authorization,
    });
    expect(credential.json().providerCli.reason).toBe("credential_rejected");
    expect(LegacyProviderCliHandoffProgressSchema.parse(credential.json().providerCli)).toEqual({
      phase: "needs_attention",
      reason: "credential_rejected",
    });
  });
});
