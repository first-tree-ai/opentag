import { randomUUID } from "node:crypto";
import {
  FEISHU_REQUIRED_TENANT_SCOPES,
  type ImCliReadinessStatus,
  type IntegrationCredentialExecutionReason,
  type IntegrationCredentialExecutionStatus,
  type ProviderCliArtifactPublicReason,
  type ProviderReadinessStatus,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, computers, imBindings, slackInstallations, users } from "../db/schema/index.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImBindingProviderCli, type ImBindingReadinessInput } from "../services/im-bindings/im-binding-provider-cli.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

/*
 * Service-level coverage for the Provider CLI requirement/grant/readiness projection: which active
 * bindings demand a CLI artifact, whether a one-shot validation grant may be issued for one, and
 * how the handoff progresses from artifact preparation to credential validation.
 */

let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit?.reset());

const FIXED_NOW = new Date("2026-08-19T00:00:00.000Z");
// A single-key cipher writes the legacy v1 envelope, which the credential readers open without AAD.
const cipher = new ApplicationCipher(new Uint8Array(32).fill(11));

function first<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) throw new Error("The fixture row was not created");
  return row;
}

async function seedComputer() {
  const owner = first(
    await unit.database
      .insert(users)
      .values({ email: `pcli-${randomUUID()}@example.test`, displayName: "Provider CLI Owner" })
      .returning(),
  );
  const computer = first(
    await unit.database
      .insert(computers)
      .values({
        ownerAccountId: owner.id,
        currentInstallationId: randomUUID(),
        displayName: "pcli-computer",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      })
      .returning(),
  );
  return { computer, owner };
}

async function seedAgent(computerId: string, ownerId: string, status: "active" | "suspended" = "active") {
  return first(
    await unit.database
      .insert(agents)
      .values({
        createdByUserId: ownerId,
        computerId,
        name: `pcli-agent-${randomUUID().slice(0, 8)}`,
        displayName: "Provider CLI Agent",
        runtimeProvider: "codex",
        status,
      })
      .returning(),
  );
}

function feishuCredentialPayload(appId: string, appSecret: string, scopes: readonly string[]): string {
  return JSON.stringify({ appId, appSecret, grantedScopes: [...scopes].sort() });
}

function slackCredentialPayload(
  botId: string,
  botAccessToken: string,
  scopes: readonly string[],
  signingSecret = "signing-secret",
): string {
  return JSON.stringify({ botId, botAccessToken, signingSecret, grantedScopes: [...scopes].sort() });
}

async function seedFeishuBinding(input: {
  agentId: string;
  appId: string;
  botOpenId?: string;
  teamBrand?: string | null;
  generation?: number;
  scopes?: readonly string[];
  /** Distinct from `appId` to model a credential that no longer matches the binding identity. */
  credentialAppId?: string;
  encryptedCredential?: string;
}) {
  const scopes = input.scopes ?? FEISHU_REQUIRED_TENANT_SCOPES;
  return first(
    await unit.database
      .insert(imBindings)
      .values({
        agentId: input.agentId,
        provider: "feishu",
        status: "active",
        externalAppId: input.appId,
        externalBotId: input.botOpenId ?? `ou_${input.appId}`,
        externalTeamBrand: input.teamBrand ?? null,
        credentialSchemaVersion: 1,
        credentialGeneration: input.generation ?? 1,
        encryptedCredential:
          input.encryptedCredential ??
          cipher.encrypt(
            feishuCredentialPayload(input.credentialAppId ?? input.appId, `secret-${input.appId}`, scopes),
          ),
        grantedCapabilities: [...scopes],
        activatedAt: FIXED_NOW,
      })
      .returning(),
  );
}

async function seedSlackInstallation(input: {
  agentId: string;
  appId: string;
  generation?: number;
  scopes?: readonly string[];
  botId?: string;
  botAccessToken?: string;
  teamId?: string;
  botUserId?: string;
  status?: "active" | "reauthorization_required";
  encryptedCredential?: string;
}) {
  const scopes = input.scopes ?? SLACK_REQUIRED_BOT_SCOPES;
  return first(
    await unit.database
      .insert(slackInstallations)
      .values({
        agentId: input.agentId,
        status: input.status ?? "active",
        externalAppId: input.appId,
        externalTeamId: input.teamId ?? `T_${input.appId}`,
        externalBotId: input.botUserId ?? `U_${input.appId}`,
        credentialSchemaVersion: 1,
        credentialGeneration: input.generation ?? 1,
        encryptedCredential:
          input.encryptedCredential ??
          cipher.encrypt(
            slackCredentialPayload(
              input.botId ?? `B_${input.appId}`,
              input.botAccessToken ?? `xoxb-${input.appId}`,
              scopes,
            ),
          ),
        grantedCapabilities: [...scopes],
        activatedAt: FIXED_NOW,
      })
      .returning(),
  );
}

async function seedSlackBinding(input: {
  agentId: string;
  appId: string;
  installationId: string;
  generation?: number;
}) {
  return first(
    await unit.database
      .insert(imBindings)
      .values({
        agentId: input.agentId,
        provider: "slack",
        status: "active",
        slackInstallationId: input.installationId,
        slackRouteKind: "default",
        externalAppId: input.appId,
        externalTeamId: `T_${input.appId}`,
        externalBotId: `U_${input.appId}`,
        credentialSchemaVersion: 1,
        credentialGeneration: input.generation ?? 1,
        grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
        activatedAt: FIXED_NOW,
      })
      .returning(),
  );
}

type ArtifactValue = ImCliReadinessStatus | { status: ImCliReadinessStatus; reason?: ProviderCliArtifactPublicReason };
type CredentialValue = { status: IntegrationCredentialExecutionStatus; reason?: IntegrationCredentialExecutionReason };

type ArtifactReader = (
  agentId: string,
  provider: "feishu" | "slack",
  integrationId: string,
  credentialGeneration: number,
) => Promise<ArtifactValue>;
type CredentialReader = (
  agentId: string,
  provider: "feishu" | "slack",
  integrationId: string,
  credentialGeneration: number,
) => Promise<CredentialValue>;
type WarnSpy = Pick<ServiceLogger, "warn"> & { warn: ReturnType<typeof vi.fn> };

function spyLogger(): WarnSpy {
  return { warn: vi.fn<(bindings: Record<string, unknown>, message: string) => void>() };
}

function buildService(
  options: {
    artifactReadiness?: ArtifactReader;
    credentialReadiness?: CredentialReader;
    logger?: Pick<ServiceLogger, "warn">;
  } = {},
) {
  return new ImBindingProviderCli(unit.database, cipher, {
    artifactReadiness: options.artifactReadiness ?? (async (): Promise<ArtifactValue> => "ready"),
    credentialReadiness: options.credentialReadiness ?? (async (): Promise<CredentialValue> => ({ status: "ready" })),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/** Most cases only vary the status, so the readers keep the real four-argument signature. */
function artifactStatus(value: ArtifactValue): ArtifactReader {
  return async () => value;
}

function credentialStatus(value: CredentialValue): CredentialReader {
  return async () => value;
}

function feishuReadiness(overrides: Partial<ImBindingReadinessInput> = {}): ImBindingReadinessInput {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    provider: "feishu",
    status: "active",
    connectionLeaseExpiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    observedConnectedAt: FIXED_NOW,
    observedAt: FIXED_NOW,
    grantedCapabilities: [...FEISHU_REQUIRED_TENANT_SCOPES],
    credentialGeneration: 1,
    credentialStatus: "valid",
    ...overrides,
  };
}

function slackReadiness(overrides: Partial<ImBindingReadinessInput> = {}): ImBindingReadinessInput {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    provider: "slack",
    status: "active",
    connectionLeaseExpiresAt: null,
    observedConnectedAt: FIXED_NOW,
    observedAt: FIXED_NOW,
    grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
    credentialGeneration: 1,
    credentialStatus: "valid",
    ...overrides,
  };
}

const READY_RUNTIME: Promise<ProviderReadinessStatus> = Promise.resolve("ready");

describe("ImBindingProviderCli.listActiveRequirements", () => {
  it("reports the stored identity and generation for a Feishu and a Slack binding", async () => {
    const { computer, owner } = await seedComputer();
    const feishuAgent = await seedAgent(computer.id, owner.id);
    // A second Agent: one Agent owns at most one non-disabled binding.
    const brandlessAgent = await seedAgent(computer.id, owner.id);
    const slackAgent = await seedAgent(computer.id, owner.id);
    const feishu = await seedFeishuBinding({ agentId: feishuAgent.id, appId: "cli_lark", teamBrand: "lark" });
    const larkBrandless = await seedFeishuBinding({ agentId: brandlessAgent.id, appId: "cli_default_brand" });
    const installation = await seedSlackInstallation({
      agentId: slackAgent.id,
      appId: "A1",
      generation: 4,
      botId: "B1",
      botAccessToken: "xoxb-token",
      teamId: "T1",
      botUserId: "U1",
    });
    const slack = await seedSlackBinding({ agentId: slackAgent.id, appId: "A1", installationId: installation.id });

    const requirements = await buildService().listActiveRequirements(computer.id);

    expect(requirements).toHaveLength(3);
    expect(requirements).toEqual(
      expect.arrayContaining([
        {
          agentId: feishuAgent.id,
          credentialGeneration: 1,
          expectedIdentity: { provider: "feishu", appId: "cli_lark", botOpenId: "ou_cli_lark", teamBrand: "lark" },
          integrationId: feishu.id,
          provider: "feishu",
        },
        {
          agentId: brandlessAgent.id,
          credentialGeneration: 1,
          expectedIdentity: {
            provider: "feishu",
            appId: "cli_default_brand",
            botOpenId: "ou_cli_default_brand",
            teamBrand: "feishu",
          },
          integrationId: larkBrandless.id,
          provider: "feishu",
        },
        {
          agentId: slackAgent.id,
          // The installation owns the generation a Slack binding validates against.
          credentialGeneration: 4,
          expectedIdentity: { provider: "slack", teamId: "T1", botUserId: "U1", botId: "B1" },
          integrationId: slack.id,
          provider: "slack",
        },
      ]),
    );
  });

  it("omits a binding whose stored identity is blank rather than absent", async () => {
    // The active-binding shape only forbids NULL identities; an empty string is still an unusable
    // identity and must not be handed to a Client as an expectation.
    const { computer, owner } = await seedComputer();
    const feishuAgent = await seedAgent(computer.id, owner.id);
    const slackAgent = await seedAgent(computer.id, owner.id);
    await seedFeishuBinding({ agentId: feishuAgent.id, appId: "" });
    const installation = await seedSlackInstallation({ agentId: slackAgent.id, appId: "A_blank", teamId: "" });
    await seedSlackBinding({ agentId: slackAgent.id, appId: "A_blank", installationId: installation.id });

    await expect(buildService().listActiveRequirements(computer.id)).resolves.toEqual([]);
  });

  it("omits a Slack binding whose installation credential no longer opens, and logs why", async () => {
    const { computer, owner } = await seedComputer();
    const agent = await seedAgent(computer.id, owner.id);
    const installation = await seedSlackInstallation({
      agentId: agent.id,
      appId: "A_broken",
      encryptedCredential: "not-a-ciphertext",
    });
    await seedSlackBinding({ agentId: agent.id, appId: "A_broken", installationId: installation.id });
    const logger = spyLogger();

    await expect(buildService({ logger }).listActiveRequirements(computer.id)).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED", slackInstallationId: installation.id }),
      expect.any(String),
    );
  });

  it("filters on the exact Computer, an active Agent, and an active binding", async () => {
    const { computer, owner } = await seedComputer();
    const other = await seedComputer();
    const activeAgent = await seedAgent(computer.id, owner.id);
    const suspendedAgent = await seedAgent(computer.id, owner.id, "suspended");
    const foreignAgent = await seedAgent(other.computer.id, other.owner.id);
    const expected = await seedFeishuBinding({ agentId: activeAgent.id, appId: "cli_kept" });
    await seedFeishuBinding({ agentId: suspendedAgent.id, appId: "cli_suspended_agent" });
    await seedFeishuBinding({ agentId: foreignAgent.id, appId: "cli_other_computer" });

    const requirements = await buildService().listActiveRequirements(computer.id);

    expect(requirements.map((requirement) => requirement.integrationId)).toEqual([expected.id]);
  });
});

describe("ImBindingProviderCli.issueValidationGrant", () => {
  async function feishuFixture(
    options: {
      generation?: number;
      credentialAppId?: string;
      encryptedCredential?: string;
      teamBrand?: string | null;
      appId?: string;
    } = {},
  ) {
    const { computer, owner } = await seedComputer();
    const agent = await seedAgent(computer.id, owner.id);
    const appId = options.appId ?? "cli_A";
    const binding = await seedFeishuBinding({
      agentId: agent.id,
      appId,
      ...(options.generation === undefined ? {} : { generation: options.generation }),
      ...(options.credentialAppId === undefined ? {} : { credentialAppId: options.credentialAppId }),
      ...(options.encryptedCredential === undefined ? {} : { encryptedCredential: options.encryptedCredential }),
      ...(options.teamBrand === undefined ? {} : { teamBrand: options.teamBrand }),
    });
    return {
      computer,
      owner,
      agent,
      binding,
      input: {
        agentId: agent.id,
        computerId: computer.id,
        installationId: computer.currentInstallationId,
        credentialGeneration: binding.credentialGeneration,
        integrationId: binding.id,
        provider: "feishu" as const,
      },
    };
  }

  async function slackFixture() {
    const { computer, owner } = await seedComputer();
    const agent = await seedAgent(computer.id, owner.id);
    const installation = await seedSlackInstallation({
      agentId: agent.id,
      appId: "A1",
      generation: 7,
      botId: "B1",
      botAccessToken: "xoxb-granted",
      teamId: "T1",
      botUserId: "U1",
    });
    const binding = await seedSlackBinding({ agentId: agent.id, appId: "A1", installationId: installation.id });
    return {
      computer,
      owner,
      agent,
      installation,
      binding,
      input: {
        agentId: agent.id,
        computerId: computer.id,
        installationId: computer.currentInstallationId,
        credentialGeneration: installation.credentialGeneration,
        integrationId: binding.id,
        provider: "slack" as const,
      },
    };
  }

  it("hands over the Feishu App secret with its expected identity and brand", async () => {
    const fixture = await feishuFixture({ appId: "cli_A", teamBrand: "lark" });

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toEqual({
      expectedIdentity: { provider: "feishu", appId: "cli_A", botOpenId: "ou_cli_A", teamBrand: "lark" },
      grant: { provider: "feishu", appId: "cli_A", appSecret: "secret-cli_A", teamBrand: "lark" },
    });
  });

  it("normalizes an unset Feishu brand to feishu", async () => {
    const fixture = await feishuFixture({ appId: "cli_B" });

    const result = await buildService().issueValidationGrant(fixture.input);

    expect(result?.grant).toEqual({
      provider: "feishu",
      appId: "cli_B",
      appSecret: "secret-cli_B",
      teamBrand: "feishu",
    });
  });

  it("refuses a Feishu grant for a stale credential generation", async () => {
    const fixture = await feishuFixture({ generation: 3 });

    await expect(
      buildService().issueValidationGrant({ ...fixture.input, credentialGeneration: 2 }),
    ).resolves.toBeUndefined();
  });

  it("refuses a Feishu grant when the stored credential names another App", async () => {
    const fixture = await feishuFixture({ appId: "cli_bound", credentialAppId: "cli_other" });

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toBeUndefined();
  });

  it("refuses a Feishu grant when the stored credential cannot be opened", async () => {
    const fixture = await feishuFixture({ encryptedCredential: "not-a-ciphertext" });

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toBeUndefined();
  });

  it("hands over the Slack bot token with its installation identity", async () => {
    const fixture = await slackFixture();

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toEqual({
      expectedIdentity: { provider: "slack", teamId: "T1", botUserId: "U1", botId: "B1" },
      grant: { provider: "slack", botAccessToken: "xoxb-granted" },
    });
  });

  it("refuses a Slack grant for a stale generation or an installation that is not active", async () => {
    const fixture = await slackFixture();

    await expect(
      buildService().issueValidationGrant({ ...fixture.input, credentialGeneration: 6 }),
    ).resolves.toBeUndefined();

    // The binding itself stays active; only the installation left the active state.
    await unit.database
      .update(slackInstallations)
      .set({ status: "reauthorization_required" })
      .where(eq(slackInstallations.id, fixture.installation.id));

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toBeUndefined();
  });

  it("refuses a Slack grant when the bot token lacks a required scope", async () => {
    const { computer, owner } = await seedComputer();
    const agent = await seedAgent(computer.id, owner.id);
    const installation = await seedSlackInstallation({
      agentId: agent.id,
      appId: "A_scope",
      scopes: ["chat:write"],
    });
    const binding = await seedSlackBinding({ agentId: agent.id, appId: "A_scope", installationId: installation.id });

    await expect(
      buildService().issueValidationGrant({
        agentId: agent.id,
        computerId: computer.id,
        installationId: computer.currentInstallationId,
        credentialGeneration: installation.credentialGeneration,
        integrationId: binding.id,
        provider: "slack",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a Slack grant when the installation credential cannot be opened", async () => {
    const { computer, owner } = await seedComputer();
    const agent = await seedAgent(computer.id, owner.id);
    const installation = await seedSlackInstallation({
      agentId: agent.id,
      appId: "A_broken",
      encryptedCredential: "not-a-ciphertext",
    });
    const binding = await seedSlackBinding({ agentId: agent.id, appId: "A_broken", installationId: installation.id });

    await expect(
      buildService().issueValidationGrant({
        agentId: agent.id,
        computerId: computer.id,
        installationId: computer.currentInstallationId,
        credentialGeneration: installation.credentialGeneration,
        integrationId: binding.id,
        provider: "slack",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a grant for an unknown binding, a suspended Agent, or a mismatched fence", async () => {
    const fixture = await feishuFixture();
    const service = buildService();

    await expect(
      service.issueValidationGrant({ ...fixture.input, integrationId: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(service.issueValidationGrant({ ...fixture.input, computerId: randomUUID() })).resolves.toBeUndefined();
    await expect(
      service.issueValidationGrant({ ...fixture.input, installationId: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(service.issueValidationGrant({ ...fixture.input, provider: "slack" })).resolves.toBeUndefined();

    await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agent.id));
    await expect(service.issueValidationGrant(fixture.input)).resolves.toBeUndefined();
  });

  it("refuses a grant when the binding itself is not active", async () => {
    const fixture = await feishuFixture();
    await unit.database.update(imBindings).set({ status: "error" }).where(eq(imBindings.id, fixture.binding.id));

    await expect(buildService().issueValidationGrant(fixture.input)).resolves.toBeUndefined();
  });
});

describe("ImBindingProviderCli.readiness", () => {
  it("normalizes a bare artifact status string and an artifact object to the same readiness", async () => {
    const asString = await buildService({ artifactReadiness: artifactStatus("checking") }).readiness(
      feishuReadiness(),
      READY_RUNTIME,
      FIXED_NOW,
    );
    const asObject = await buildService({ artifactReadiness: artifactStatus({ status: "checking" }) }).readiness(
      feishuReadiness(),
      READY_RUNTIME,
      FIXED_NOW,
    );

    expect(asString).toEqual(asObject);
    expect(asString.providerCliReadiness).toBe("checking");
  });

  it("asks both readers for the exact binding and credential generation it was given", async () => {
    const seen: unknown[] = [];
    const input = feishuReadiness({ agentId: "agent-1", id: "integration-1", credentialGeneration: 9 });
    await buildService({
      artifactReadiness: async (agentId, provider, integrationId, generation) => {
        seen.push([agentId, provider, integrationId, generation]);
        return "ready";
      },
      credentialReadiness: async (agentId, provider, integrationId, generation) => {
        seen.push([agentId, provider, integrationId, generation]);
        return { status: "ready" };
      },
    }).readiness(input, READY_RUNTIME, FIXED_NOW);

    expect(seen).toEqual([
      ["agent-1", "feishu", "integration-1", 9],
      ["agent-1", "feishu", "integration-1", 9],
    ]);
  });

  it("publishes an allowlisted artifact failure reason and keeps an unlisted one private", async () => {
    const publicFailure = await buildService({
      artifactReadiness: artifactStatus({ status: "unavailable", reason: "integrity_failed" }),
    }).readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(publicFailure.providerCliReason).toBe("integrity_failed");
    expect(publicFailure.handoff).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "needs_attention", reason: "integrity_failed" },
    });

    const privateFailure = await buildService({
      artifactReadiness: artifactStatus({
        status: "unavailable",
        reason: "disk_is_full" as ProviderCliArtifactPublicReason,
      }),
    }).readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(privateFailure).not.toHaveProperty("providerCliReason");
    expect(privateFailure.providerCliReadiness).toBe("unavailable");
    expect(privateFailure.handoff).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "needs_attention" },
    });
  });

  it("reports an unavailable artifact without a reason as needs_attention with no reason", async () => {
    // Both the bare status and the object without a reason reach the same empty handoff reason.
    for (const artifact of ["unavailable", { status: "unavailable" }] as const) {
      const userView = await buildService({ artifactReadiness: artifactStatus(artifact) }).readiness(
        feishuReadiness(),
        READY_RUNTIME,
        FIXED_NOW,
      );

      expect(userView).not.toHaveProperty("providerCliReason");
      expect(userView.providerCliReadiness).toBe("unavailable");
      expect(userView.handoff).toEqual({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "needs_attention" },
      });
    }
  });

  it("reports preparing_cli while the artifact is still being installed", async () => {
    for (const status of ["checking", "install"] as const) {
      const readiness = await buildService({ artifactReadiness: artifactStatus(status) }).readiness(
        feishuReadiness(),
        READY_RUNTIME,
        FIXED_NOW,
      );

      expect(readiness.providerCliReadiness).toBe(status);
      expect(readiness.handoff).toEqual({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "preparing_cli" },
      });
    }
  });

  it("reports checking_credentials once the CLI is ready but execution is unconfirmed", async () => {
    for (const status of ["unconfirmed", "checking", "retrying"] as const) {
      const readiness = await buildService({ credentialReadiness: credentialStatus({ status }) }).readiness(
        feishuReadiness(),
        READY_RUNTIME,
        FIXED_NOW,
      );

      expect(readiness.credentialExecutionReadiness).toBe(status);
      expect(readiness.handoff).toEqual({
        bindingState: "active",
        handoffReady: false,
        providerCli: { phase: "checking_credentials" },
      });
    }
  });

  it("reports needs_attention with the credential reason and mirrors it on the readiness", async () => {
    const withReason = await buildService({
      credentialReadiness: credentialStatus({ status: "needs_attention", reason: "credential_rejected" }),
    }).readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(withReason.credentialExecutionReason).toBe("credential_rejected");
    expect(withReason.handoff).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "needs_attention", reason: "credential_rejected" },
    });

    const withoutReason = await buildService({
      credentialReadiness: credentialStatus({ status: "needs_attention" }),
    }).readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(withoutReason).not.toHaveProperty("credentialExecutionReason");
    expect(withoutReason.handoff).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "needs_attention" },
    });
  });

  it("treats an upgrade_required credential reason as needs_attention even before the status settles", async () => {
    const readiness = await buildService({
      credentialReadiness: credentialStatus({ status: "checking", reason: "upgrade_required" }),
    }).readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(readiness.handoff).toEqual({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "needs_attention", reason: "upgrade_required" },
    });
  });

  it("declares the handoff ready only when connection, runtime, artifact, and credential all are", async () => {
    const readiness = await buildService().readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);

    expect(readiness).toEqual({
      handoff: { bindingState: "active", handoffReady: true },
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "ready",
      credentialExecutionReadiness: "ready",
      reauthorizationRequired: false,
      connection: { state: "connected", observedAt: FIXED_NOW.toISOString() },
    });
  });

  it("keeps a binding that is not active out of the handoff and out of the CLI phases", async () => {
    const readiness = await buildService({ artifactReadiness: artifactStatus("install") }).readiness(
      feishuReadiness({ status: "provisioning" }),
      READY_RUNTIME,
      FIXED_NOW,
    );

    expect(readiness.reauthorizationRequired).toBe(false);
    expect(readiness.providerCliReadiness).toBe("install");
    expect(readiness.handoff).toEqual({ bindingState: "provisioning", handoffReady: false });
  });

  it("observes a Feishu connection only from a live lease with a recorded connection", async () => {
    const service = buildService();

    const connected = await service.readiness(feishuReadiness(), READY_RUNTIME, FIXED_NOW);
    expect(connected.connection).toEqual({ state: "connected", observedAt: FIXED_NOW.toISOString() });

    const expiredLease = await service.readiness(
      feishuReadiness({ connectionLeaseExpiresAt: new Date(FIXED_NOW.getTime() - 1) }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(expiredLease.connection).toEqual({ state: "disconnected", observedAt: FIXED_NOW.toISOString() });
    expect(expiredLease.handoff).toEqual({ bindingState: "active", handoffReady: false });

    const neverConnected = await service.readiness(
      feishuReadiness({ observedConnectedAt: null }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(neverConnected.connection).toEqual({ state: "disconnected", observedAt: FIXED_NOW.toISOString() });

    const neverObserved = await service.readiness(feishuReadiness({ observedAt: null }), READY_RUNTIME, FIXED_NOW);
    expect(neverObserved.connection).toBeNull();
    expect(neverObserved.handoff).toEqual({ bindingState: "active", handoffReady: false });
  });

  it("derives Slack connection readiness from the recorded connection instead of a lease", async () => {
    const service = buildService();

    expect((await service.readiness(slackReadiness(), READY_RUNTIME, FIXED_NOW)).handoff).toEqual({
      bindingState: "active",
      handoffReady: true,
    });
    const disconnected = await service.readiness(
      slackReadiness({ observedConnectedAt: null }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(disconnected.connection).toBeNull();
    expect(disconnected.handoff).toEqual({ bindingState: "active", handoffReady: false });
  });

  it("demands reauthorization for an explicit state, a missing scope, or an invalid credential", async () => {
    const service = buildService();

    const explicit = await service.readiness(
      feishuReadiness({ status: "reauthorization_required" }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(explicit.reauthorizationRequired).toBe(true);
    expect(explicit.handoff).toEqual({ bindingState: "reauthorization_required", handoffReady: false });

    const missingFeishuScope = await service.readiness(
      feishuReadiness({ grantedCapabilities: ["im:message"] }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(missingFeishuScope.reauthorizationRequired).toBe(true);
    expect(missingFeishuScope.handoff.bindingState).toBe("reauthorization_required");

    const missingSlackScope = await service.readiness(
      slackReadiness({ grantedCapabilities: ["chat:write"] }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(missingSlackScope.reauthorizationRequired).toBe(true);

    const invalidCredential = await service.readiness(
      feishuReadiness({ credentialStatus: "invalid" }),
      READY_RUNTIME,
      FIXED_NOW,
    );
    expect(invalidCredential.reauthorizationRequired).toBe(true);

    const inactive = await service.readiness(feishuReadiness({ status: "error" }), READY_RUNTIME, FIXED_NOW);
    expect(inactive.reauthorizationRequired).toBe(false);
    expect(inactive.handoff).toEqual({ bindingState: "error", handoffReady: false });
  });
});
