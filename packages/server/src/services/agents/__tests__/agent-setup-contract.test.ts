/**
 * F6 cross-layer preparation contract, Server boundary.
 *
 * Every scenario in the shared fixture (`scripts/fixtures/onboarding-preparation-contract.json`)
 * is reproduced against the real `AgentSetupService` on the embedded engine: a real bound Agent
 * and Computer row, and a real `ConnectionRegistry` whose TTL decides report freshness (the same
 * wiring the production composition root uses). Runtime-generated ids (Agent, Computer, Account,
 * binding) are normalized to the fixture's canonical ids, and the produced snapshot must equal the
 * fixture's canonical snapshot exactly — stage, required Provider order, blocking rows, components,
 * and actions included. The snapshot is never synthesized with the service itself: it is the
 * hand-authored fixture, and the Web suite projects the same bytes through the F5 page logic.
 *
 * `no-fresh-observation` (reports never arrived) and `expired-observation` (reports dropped by the
 * registry TTL) must produce one identical fail-closed waiting snapshot: the Server exposes no old
 * timestamp for an expired report, so the two facts are indistinguishable downstream and both stay
 * waiting — never checking.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRuntimeProvider,
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  type AgentSetupStage,
  type RuntimeImCliReadinessCollection,
  type RuntimeProviderReadinessCollection,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../../../admin/bootstrap.js";
import { computers, imBindings, slackInstallations } from "../../../db/schema/index.js";
import { ConnectionRegistry, type RuntimeConnectionEntry } from "../../../runtime/connection-registry.js";
import { ApplicationCipher } from "../../crypto.js";
import { FeishuSetupService } from "../../im-bindings/feishu/index.js";
import { ImBindingService } from "../../im-bindings/index.js";
import { AgentSetupService } from "../agent-setup-service.js";
import { AgentService } from "../index.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");

const FIXED_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const FIXED_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const FIXED_USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const FIXED_BINDING_ID = "22222222-2222-4222-8222-222222222222";

interface ObservationFact<Status extends string> {
  readonly status: Status;
  readonly observedAt: string;
  readonly expired?: boolean;
}

interface ServerFacts {
  readonly connection: "online" | "offline";
  readonly runtimeReport: ObservationFact<RuntimeProviderReadinessCollection[number]["status"]> | null;
  readonly feishuReport: ObservationFact<RuntimeImCliReadinessCollection[number]["status"]> | null;
  readonly slackReport: ObservationFact<RuntimeImCliReadinessCollection[number]["status"]> | null;
  readonly messaging: "not-configured" | "slack-waiting-handoff";
}

interface Scenario {
  readonly id: string;
  readonly runtimeProvider: AgentRuntimeProvider;
  readonly server: {
    readonly facts: ServerFacts;
    readonly expected: { readonly stage: AgentSetupStage; readonly blockingComponents: string[] };
  };
  readonly snapshot: AgentSetupSnapshot;
}

interface FixtureFile {
  readonly scenarios: Scenario[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../../../../../../scripts/fixtures/onboarding-preparation-contract.json"), "utf8"),
) as unknown as FixtureFile;

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

async function account(): Promise<{ userId: string }> {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
  return { userId: bootstrap.userId };
}

async function createComputer(userId: string, online: boolean): Promise<{ computerId: string }> {
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: randomUUID(),
      displayName: "Review Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.2",
      currentInstanceId: online ? randomUUID() : null,
      connectedAt: online ? NOW : null,
      lastSeenAt: online ? NOW : null,
    })
    .returning({ computerId: computers.id });
  if (!computer) throw new Error("Computer fixture was not created");
  return { computerId: computer.computerId };
}

async function boundAgent(
  userId: string,
  runtimeProvider: AgentRuntimeProvider,
  computerId: string,
): Promise<{ agentId: string }> {
  const agentService = new AgentService(unitDatabase.database, { now: () => NOW });
  const created = await agentService.createForAccount(userId, {
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider,
    computerId,
  });
  return { agentId: created.id };
}

async function activateSlackBinding(
  imBindingService: ImBindingService,
  agentId: string,
): Promise<{ imBindingId: string }> {
  const activated = await imBindingService.activateSlack(
    {
      intent: "create",
      agentId,
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      botUserId: "U_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-secret",
      signingSecret: "signing-secret",
      installedAt: NOW,
    },
    "B_BOT",
  );
  return { imBindingId: activated.imBindingId };
}

async function observeSlackConnection(agentId: string): Promise<void> {
  await unitDatabase.database
    .update(slackInstallations)
    .set({ observedConnectedAt: NOW, observedAt: NOW })
    .where(eq(slackInstallations.agentId, agentId));
}

function socketStub(): WebSocket {
  return { close: () => undefined, on: () => undefined } as unknown as WebSocket;
}

function entryFor(
  computerId: string,
  runtimeProvider: AgentRuntimeProvider,
  facts: ServerFacts,
): Pick<RuntimeConnectionEntry, "computerId" | "installationId" | "instanceId" | "lastHeartbeatAt" | "socket"> &
  Partial<RuntimeConnectionEntry> {
  const entry: Pick<
    RuntimeConnectionEntry,
    "computerId" | "installationId" | "instanceId" | "lastHeartbeatAt" | "socket"
  > &
    Partial<RuntimeConnectionEntry> = {
    computerId,
    installationId: randomUUID(),
    instanceId: randomUUID(),
    lastHeartbeatAt: NOW.getTime(),
    socket: socketStub(),
  };
  const runtime = facts.runtimeReport
    ? {
        provider: runtimeProvider,
        status: facts.runtimeReport.status,
        observedAt: new Date(facts.runtimeReport.observedAt).getTime(),
      }
    : undefined;
  if (runtime) {
    entry.providerReadinessProviders = [runtimeProvider];
    entry.providerReadiness = [{ provider: runtimeProvider, status: runtime.status }];
    entry.providerReadinessObservedAt = runtime.observedAt;
  }
  const cli = [
    facts.feishuReport
      ? {
          provider: "feishu" as const,
          status: facts.feishuReport.status,
          observedAt: new Date(facts.feishuReport.observedAt).getTime(),
        }
      : undefined,
    facts.slackReport
      ? {
          provider: "slack" as const,
          status: facts.slackReport.status,
          observedAt: new Date(facts.slackReport.observedAt).getTime(),
        }
      : undefined,
  ].filter(
    (
      item,
    ): item is {
      provider: "feishu" | "slack";
      status: RuntimeImCliReadinessCollection[number]["status"];
      observedAt: number;
    } => item !== undefined,
  );
  if (cli.length > 0) {
    entry.imCliReadiness = cli.map(({ provider, status }) => ({ provider, status }));
    entry.imCliReadinessObservedAt = Math.min(...cli.map((item) => item.observedAt));
  }
  return entry;
}

/**
 * Runs one fixture scenario against the real service and returns the produced snapshot together
 * with the actual runtime ids so the caller can normalize them onto the fixture's canonical ids.
 */
async function runScenario(scenario: Scenario): Promise<{
  snapshot: AgentSetupSnapshot;
  actual: { agentId: string; computerId: string; userId: string; bindingId?: string };
}> {
  // Every run starts from a clean embedded database: the admin bootstrap is a one-time insert.
  await unitDatabase.reset();
  const { userId } = await account();
  const facts = scenario.server.facts;
  const { computerId } = await createComputer(userId, facts.connection === "online");
  const { agentId } = await boundAgent(userId, scenario.runtimeProvider, computerId);

  const registry = new ConnectionRegistry();
  if (facts.connection === "online") {
    await registry.register(entryFor(computerId, scenario.runtimeProvider, facts), async () => undefined);
  }

  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(unitDatabase.database, cipher, {
    now: () => NOW,
    agentRuntimeReadiness: () => "ready",
    imCliReadiness: () => "ready",
    credentialExecutionReadiness: () => ({ status: "unconfirmed" }),
  });
  const feishuSetup = new FeishuSetupService({
    database: unitDatabase.database,
    cipher,
    instanceId: "77777777-7777-4777-8777-777777777777",
    imBindings: imBindingService,
    registrations: {
      start: () => {
        throw new Error("The scenario did not expect a Feishu registration");
      },
    },
    activation: { activateAtomicAttempt: vi.fn() },
  });

  let bindingId: string | undefined;
  if (facts.messaging === "slack-waiting-handoff") {
    const activated = await activateSlackBinding(imBindingService, agentId);
    bindingId = activated.imBindingId;
    await observeSlackConnection(agentId);
  }

  const agentService = new AgentService(unitDatabase.database, { now: () => NOW });
  const service = new AgentSetupService(unitDatabase.database, agentService, imBindingService, feishuSetup, {
    now: () => NOW,
    providerReadiness: registry,
  });
  const snapshot = await service.getSetupById(userId, agentId);
  return { snapshot, actual: { agentId, computerId, userId, ...(bindingId ? { bindingId } : {}) } };
}

function normalizeIds(
  snapshot: AgentSetupSnapshot,
  actual: { agentId: string; computerId: string; userId: string; bindingId?: string },
): unknown {
  const serialized = JSON.stringify(snapshot);
  const replaced = serialized
    .replaceAll(actual.agentId, FIXED_AGENT_ID)
    .replaceAll(actual.computerId, FIXED_COMPUTER_ID)
    .replaceAll(actual.userId, FIXED_USER_ID)
    .replaceAll(actual.bindingId ?? "no-such-binding-id", FIXED_BINDING_ID);
  return JSON.parse(replaced) as unknown;
}

function expectContractValid(snapshot: AgentSetupSnapshot): void {
  expect(AgentSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
}

describe("F6 shared preparation matrix, Server boundary", () => {
  it.each(fixture.scenarios.map((scenario) => [scenario.id, scenario] as const))(
    "scenario %s: the real AgentSetupService emits exactly the fixture's canonical snapshot",
    async (_id, scenario) => {
      const { snapshot, actual } = await runScenario(scenario);

      expectContractValid(snapshot);
      expect(snapshot.agent.runtimeProvider).toBe(scenario.runtimeProvider);
      expect(snapshot.stage).toBe(scenario.server.expected.stage);
      expect(snapshot.requiredImCliProviders).toEqual(["feishu", "slack"]);

      // Blocking rows: the same ids the fixture pins as the stage-cursor owners.
      const blockingIds = snapshot.components
        .filter((component) => component.blocking)
        .map((component) => (component.kind === "im-cli" ? `im-cli:${component.provider}` : component.kind));
      expect(blockingIds).toEqual(scenario.server.expected.blockingComponents);

      // The full canonical equality: only runtime-generated ids are normalized; everything else —
      // order, statuses, blocking, timestamps, providers, actions — must match the fixture exactly.
      expect(normalizeIds(snapshot, actual)).toEqual(scenario.snapshot);
    },
  );

  it("treats a never-arrived report and an expired report as one fail-closed waiting projection", async () => {
    const missing = fixture.scenarios.find((scenario) => scenario.id === "no-fresh-observation");
    const expired = fixture.scenarios.find((scenario) => scenario.id === "expired-observation");
    if (!missing || !expired) throw new Error("missing freshness scenarios");

    const neverArrived = await runScenario(missing);
    const droppedByTtl = await runScenario(expired);
    expectContractValid(neverArrived.snapshot);
    expectContractValid(droppedByTtl.snapshot);

    // The registry dropped the expired reports before projection: no old timestamp survives, so
    // both facts expose the same waiting state with no expiry evidence downstream.
    expect(normalizeIds(droppedByTtl.snapshot, droppedByTtl.actual)).toEqual(
      normalizeIds(neverArrived.snapshot, neverArrived.actual),
    );
    const waiting = neverArrived.snapshot.components.filter(
      (component) => (component.kind === "runtime" || component.kind === "im-cli") && component.status === "waiting",
    );
    expect(waiting).toHaveLength(3);
    for (const component of waiting) {
      expect(component.observedAt).toBeNull();
      expect(component.blocking).toBe(component.kind === "runtime");
    }
  });

  it("pins both Runtime identities through real bound Agents", async () => {
    const codex = fixture.scenarios.find((scenario) => scenario.id === "success-codex");
    const claude = fixture.scenarios.find((scenario) => scenario.id === "success-claude-code");
    if (!codex || !claude) throw new Error("missing identity scenarios");
    const codexRun = await runScenario(codex);
    const claudeRun = await runScenario(claude);
    expect(codexRun.snapshot.runtime.provider).toBe("codex");
    expect(claudeRun.snapshot.runtime.provider).toBe("claude-code");
    const codexRuntime = codexRun.snapshot.components.find((component) => component.kind === "runtime");
    const claudeRuntime = claudeRun.snapshot.components.find((component) => component.kind === "runtime");
    if (codexRuntime?.kind !== "runtime" || claudeRuntime?.kind !== "runtime") {
      throw new Error("runtime component missing");
    }
    expect(codexRuntime.provider).toBe("codex");
    expect(claudeRuntime.provider).toBe("claude-code");
  });

  it("exposes no start-messaging action until required legs are freshly ready (Server stage is the gate)", async () => {
    const gated = fixture.scenarios.filter((scenario) =>
      [
        "runtime-missing-codex",
        "runtime-signin-codex",
        "runtime-config-claude-code",
        "lark-cli-failure",
        "slack-cli-failure",
        "manual-repair-slack",
        "checking-ownership",
        "no-fresh-observation",
        "expired-observation",
        "daemon-skipped",
      ].includes(scenario.id),
    );
    for (const scenario of gated) {
      const { snapshot } = await runScenario(scenario);
      expectContractValid(snapshot);
      expect(snapshot.actions).not.toContainEqual(expect.objectContaining({ kind: "start-messaging" }));
    }
    for (const scenario of fixture.scenarios.filter((candidate) =>
      ["success-codex", "success-claude-code", "warning-non-blocking"].includes(candidate.id),
    )) {
      const { snapshot } = await runScenario(scenario);
      expectContractValid(snapshot);
      expect(snapshot.stage).toBe("needs-messaging");
      expect(snapshot.actions).toEqual([
        { kind: "start-messaging", provider: "slack" },
        { kind: "start-messaging", provider: "feishu" },
      ]);
    }
  });

  it("keeps an underway Messaging handoff authoritative over a later unselected-Provider report", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "messaging-underway-slack");
    if (!scenario) throw new Error("missing messaging-underway-slack scenario");
    const { snapshot, actual } = await runScenario(scenario);
    expectContractValid(snapshot);
    expect(normalizeIds(snapshot, actual)).toEqual(scenario.snapshot);
    if (snapshot.messaging.kind !== "waiting-handoff" || snapshot.messaging.provider !== "slack") {
      throw new Error("messaging fixture did not produce a Slack handoff");
    }
    const feishu = snapshot.components.find(
      (component) => component.kind === "im-cli" && component.provider === "feishu",
    );
    if (feishu?.kind !== "im-cli") throw new Error("feishu component missing");
    // The unselected Provider's leg is still present with its report status, but it never blocks
    // the underway Messaging state: canonical blocking only ever consults it before Messaging starts.
    expect(feishu.status).toBe("waiting");
    expect(feishu.blocking).toBe(false);
    expect(snapshot.blockers).toEqual([
      {
        code: "messaging-not-ready",
        provider: "slack",
        bindingId: expect.any(String),
        state: "waiting-handoff",
      },
    ]);
  });
});

describe("F6 Server messaging binding fixtures are only used where the fixture says so", () => {
  it("creates no Messaging binding outside the messaging-underway scenario", async () => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === "success-codex");
    if (!scenario) throw new Error("missing success-codex scenario");
    const { snapshot } = await runScenario(scenario);
    expect(snapshot.messaging).toEqual({ kind: "not-configured" });
    const [binding] = await unitDatabase.database.select({ id: imBindings.id }).from(imBindings).limit(1);
    expect(binding).toBeUndefined();
  });
});
