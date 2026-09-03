/**
 * The in-memory Agent Setup model: every read must be a snapshot the real Server could legally
 * have sent, and every write must move the model through the canonical transitions — a Provider
 * can be started only from not-configured, a current binding is reauthorized or replaced in place,
 * and a different Provider is reached only by unbinding first.
 */

import {
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  type ImBindingMessagingExpectation,
} from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_ID, SETUP_COMPUTER_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

function messagingExpectation(snapshot: AgentSetupSnapshot): ImBindingMessagingExpectation {
  const messaging = snapshot.messaging;
  if (messaging.kind === "not-configured") return { kind: "unbound" };
  if (
    (messaging.kind === "ready" || messaging.kind === "waiting-handoff" || messaging.kind === "blocked") &&
    messaging.bindingId &&
    messaging.credentialGeneration !== undefined
  ) {
    return {
      kind: "bound",
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      credentialGeneration: messaging.credentialGeneration,
    };
  }
  throw new Error("The snapshot does not expose a configured Messaging expectation");
}

async function currentMessagingExpectation(
  adapter: AgentSetupAdapter,
  agentId: string,
): Promise<ImBindingMessagingExpectation> {
  return messagingExpectation(await adapter.readSnapshot(agentId));
}

describe("createMemorySetupAdapter", () => {
  it.each([
    ["computer", "needs-computer"],
    ["runtime", "needs-runtime"],
    ["messaging", "needs-messaging"],
  ] as const)("models a persistent %s observation failure as a structured blocker", async (resource, stage) => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({ agent, observationFailure: resource });

    const snapshot = await adapter.readSnapshot(agent.id);
    expect(snapshot.stage).toBe(stage);
    expect(snapshot.blockers).toEqual([{ code: "resource-observation-failed", resource }]);
    expect(snapshot.actions).toEqual([{ kind: "refresh" }]);
  });

  it("derives each stage with its canonical blockers and actions", async () => {
    const unbound = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
    const unboundSnapshot = AgentSetupSnapshotSchema.parse(await unbound.adapter.readSnapshot(SETUP_AGENT_ID));
    expect(unboundSnapshot.stage).toBe("needs-computer");
    expect(unboundSnapshot.computer).toEqual({ kind: "not-bound" });
    expect(unboundSnapshot.runtime).toEqual({ kind: "unavailable", provider: "codex", reason: "computer-not-bound" });
    expect(unboundSnapshot.blockers).toEqual([{ code: "computer-not-bound" }]);
    expect(unboundSnapshot.actions).toEqual([{ kind: "bind-computer" }]);

    const rebind = createMemorySetupAdapter({
      agent: setupAgent({ requiresComputerRebind: true }),
    });
    const rebindSnapshot = await rebind.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(rebindSnapshot.stage).toBe("needs-computer");
    expect(rebindSnapshot.computer).toMatchObject({ kind: "requires-rebind", computerId: SETUP_COMPUTER_ID });
    expect(rebindSnapshot.blockers).toEqual([{ code: "computer-rebind-required" }]);
    expect(rebindSnapshot.actions).toEqual([{ kind: "bind-computer" }]);

    const offline = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const offlineSnapshot = await offline.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(offlineSnapshot.stage).toBe("needs-computer");
    expect(offlineSnapshot.computer).toMatchObject({ kind: "bound", connectionStatus: "offline" });
    expect(offlineSnapshot.runtime).toEqual({ kind: "unavailable", provider: "codex", reason: "computer-offline" });
    expect(offlineSnapshot.blockers).toEqual([{ code: "computer-offline", computerId: SETUP_COMPUTER_ID }]);
    expect(offlineSnapshot.actions).toEqual([
      { kind: "refresh" },
      { kind: "repair-computer", computerId: SETUP_COMPUTER_ID },
    ]);

    const installing = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    const installingSnapshot = await installing.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(installingSnapshot.stage).toBe("needs-runtime");
    expect(installingSnapshot.blockers).toEqual([{ code: "runtime-not-ready", provider: "codex", status: "install" }]);
    expect(installingSnapshot.actions).toEqual([{ kind: "refresh" }]);

    const unconfigured = createMemorySetupAdapter({ agent: setupAgent() });
    const unconfiguredSnapshot = await unconfigured.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(unconfiguredSnapshot.stage).toBe("needs-messaging");
    expect(unconfiguredSnapshot.messaging).toEqual({ kind: "not-configured" });
    expect(unconfiguredSnapshot.blockers).toEqual([{ code: "messaging-not-configured" }]);
    expect(unconfiguredSnapshot.actions).toEqual([
      { kind: "start-messaging", provider: "slack" },
      { kind: "start-messaging", provider: "feishu" },
    ]);
  });

  it("models a missing runtime report as waiting, never as checking", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({ agent, runtimeMissing: true });

    const snapshot = await adapter.readSnapshot(agent.id);
    expect(snapshot.stage).toBe("needs-runtime");
    expect(snapshot.runtime).toEqual({ kind: "waiting", provider: "codex" });
    expect(snapshot.blockers).toEqual([{ code: "runtime-not-ready", provider: "codex", status: "waiting" }]);
    expect(snapshot.actions).toEqual([{ kind: "refresh" }]);
    expect(snapshot.components).toContainEqual({
      kind: "runtime",
      status: "waiting",
      blocking: true,
      provider: "codex",
      observedAt: null,
    });
  });

  it("keeps absent CLI reports absent instead of synthesizing checking", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({ agent, imCliReadiness: {} });

    const snapshot = await adapter.readSnapshot(agent.id);
    expect(snapshot.stage).toBe("needs-provider-clis");
    expect(snapshot.computer).toMatchObject({ kind: "bound", imCliReadiness: [] });
    expect(snapshot.messaging).toEqual({ kind: "not-configured" });
    expect(snapshot.requiredImCliProviders).toEqual(["feishu", "slack"]);
    expect(snapshot.blockers).toEqual([
      { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
      { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
    ]);
    expect(snapshot.actions).toEqual([{ kind: "refresh" }]);
    expect(snapshot.actions).not.toContainEqual(expect.objectContaining({ kind: "start-messaging" }));
    expect(snapshot.components).toContainEqual({
      kind: "im-cli",
      provider: "feishu",
      status: "waiting",
      observedAt: null,
      blocking: true,
    });
  });

  it("preserves partial CLI reports while the unnamed Provider stays waiting", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({ agent, imCliReadiness: { slack: "install" } });

    const snapshot = await adapter.readSnapshot(agent.id);
    expect(snapshot.stage).toBe("needs-provider-clis");
    expect(snapshot.computer).toMatchObject({
      imCliReadiness: [{ provider: "slack", status: "install", observedAt: expect.any(String) }],
    });
    expect(snapshot.blockers).toEqual([
      { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
      { code: "provider-cli-not-ready", provider: "slack", status: "install" },
    ]);
    expect(snapshot.actions).toEqual([{ kind: "refresh" }]);
  });

  it("moves Feishu from a fresh start to ready through the canonical transitions", async () => {
    const agent = setupAgent();
    const { adapter, controls } = createMemorySetupAdapter({ agent });

    await adapter.startFeishuAttempt(agent.id, "create", { kind: "unbound" });
    const authorizing = await adapter.readSnapshot(agent.id);
    expect(authorizing.messaging).toMatchObject({ kind: "authorizing", provider: "feishu", qrUrl: expect.any(String) });
    expect(authorizing.stage).toBe("needs-messaging");
    expect(authorizing.blockers).toEqual([{ code: "messaging-not-ready", provider: "feishu", state: "authorizing" }]);
    const attemptId =
      authorizing.messaging.kind === "authorizing" && authorizing.messaging.provider === "feishu"
        ? authorizing.messaging.attemptId
        : undefined;
    expect(attemptId).toBeDefined();
    expect(authorizing.actions).toEqual([{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId }]);

    controls.scanFeishuCode();
    const handoff = await adapter.readSnapshot(agent.id);
    expect(handoff.messaging).toMatchObject({ kind: "waiting-handoff", provider: "feishu" });
    const handoffBindingId = handoff.messaging.kind === "waiting-handoff" ? handoff.messaging.bindingId : undefined;
    expect(handoff.blockers).toEqual([
      { code: "messaging-not-ready", provider: "feishu", bindingId: handoffBindingId, state: "waiting-handoff" },
    ]);
    expect(handoff.actions).toEqual([
      { kind: "refresh" },
      { kind: "unbind-messaging", provider: "feishu", bindingId: handoffBindingId },
    ]);

    controls.completeHandoff();
    const ready = await adapter.readSnapshot(agent.id);
    expect(ready.stage).toBe("ready");
    expect(ready.messaging).toMatchObject({ kind: "ready", provider: "feishu" });
    expect(ready.blockers).toEqual([]);
    const bindingId = ready.messaging.kind === "ready" ? ready.messaging.bindingId : undefined;
    const credentialGeneration = ready.messaging.kind === "ready" ? ready.messaging.credentialGeneration : undefined;
    expect(ready.actions).toEqual([
      { kind: "reauthorize-messaging", provider: "feishu", bindingId, credentialGeneration },
      { kind: "replace-messaging", provider: "feishu", bindingId, credentialGeneration },
      { kind: "unbind-messaging", provider: "feishu", bindingId },
    ]);
  });

  it("matches production by requiring exact unbind after a first attempt is canceled", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({ agent });

    await adapter.startFeishuAttempt(agent.id, "create", { kind: "unbound" });
    const authorizing = await adapter.readSnapshot(agent.id);
    const attemptId =
      authorizing.messaging.kind === "authorizing" && authorizing.messaging.provider === "feishu"
        ? authorizing.messaging.attemptId
        : "missing";
    await adapter.cancelFeishuAttempt(attemptId);

    const blocked = await adapter.readSnapshot(agent.id);
    expect(blocked.messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      code: "authorization-failed",
    });
    const bindingId = blocked.messaging.kind === "blocked" ? blocked.messaging.bindingId : "missing";
    expect(blocked.actions).toEqual([{ kind: "unbind-messaging", provider: "feishu", bindingId }]);

    await adapter.unbindMessaging(agent.id, "feishu", bindingId ?? "missing");
    const cleared = await adapter.readSnapshot(agent.id);
    expect(cleared.messaging).toEqual({ kind: "not-configured" });
  });

  it("restores the exact prior binding when a maintained attempt fails or is canceled", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({
      agent,
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "reauthorization-required" },
    });
    const before = await adapter.readSnapshot(agent.id);
    expect(before.messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      code: "reauthorization-required",
    });
    const bindingId = before.messaging.kind === "blocked" ? before.messaging.bindingId : undefined;

    await adapter.startFeishuAttempt(agent.id, "reauthorize", await currentMessagingExpectation(adapter, agent.id));
    const attempt = await adapter.readSnapshot(agent.id);
    expect(attempt.messaging).toMatchObject({ kind: "authorizing", provider: "feishu" });
    const attemptId =
      attempt.messaging.kind === "authorizing" && attempt.messaging.provider === "feishu"
        ? attempt.messaging.attemptId
        : "missing";

    await adapter.cancelFeishuAttempt(attemptId);
    const restored = await adapter.readSnapshot(agent.id);
    expect(restored.messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      bindingId,
      code: "reauthorization-required",
    });
  });

  it("clears a blocked binding once its reauthorization succeeds", async () => {
    const agent = setupAgent();
    const { adapter, controls } = createMemorySetupAdapter({
      agent,
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "reauthorization-required" },
    });
    const before = await adapter.readSnapshot(agent.id);
    const bindingId = before.messaging.kind === "blocked" ? before.messaging.bindingId : "missing";

    await adapter.startFeishuAttempt(agent.id, "reauthorize", await currentMessagingExpectation(adapter, agent.id));
    controls.scanFeishuCode();
    const after = await adapter.readSnapshot(agent.id);
    expect(after.messaging).toMatchObject({ kind: "ready", provider: "feishu", bindingId });
    expect(after.stage).toBe("ready");
  });

  it("matches production by requiring an explicit unbind after terminal authorization failure", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({
      agent,
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "authorization-failed" },
    });

    const snapshot = await adapter.readSnapshot(agent.id);
    const bindingId = snapshot.messaging.kind === "blocked" ? snapshot.messaging.bindingId : "missing";
    expect(snapshot.actions).toEqual([{ kind: "unbind-messaging", provider: "feishu", bindingId }]);
  });

  it("refuses a direct cross-Provider install until the current binding is unbound", async () => {
    const agent = setupAgent();
    const { adapter, controls } = createMemorySetupAdapter({
      agent,
      messaging: { kind: "bound", provider: "feishu", reachable: true },
    });
    const boundFeishu = await adapter.readSnapshot(agent.id);
    const bindingId = boundFeishu.messaging.kind === "ready" ? boundFeishu.messaging.bindingId : "missing";

    await expect(adapter.startSlackInstall(agent.id, "create", { kind: "unbound" })).rejects.toThrow(/unbound/);
    await expect(adapter.startFeishuAttempt(agent.id, "create", { kind: "unbound" })).rejects.toThrow(/unbound/);

    await adapter.unbindMessaging(agent.id, "feishu", bindingId);
    const cleared = await adapter.readSnapshot(agent.id);
    expect(cleared.messaging).toEqual({ kind: "not-configured" });
    expect(cleared.actions).toEqual([
      { kind: "start-messaging", provider: "slack" },
      { kind: "start-messaging", provider: "feishu" },
    ]);

    const url = await adapter.startSlackInstall(agent.id, "create", { kind: "unbound" });
    expect(url).toContain("https://slack.com/");
    const installing = await adapter.readSnapshot(agent.id);
    expect(installing.messaging).toMatchObject({ kind: "authorizing", provider: "slack" });

    controls.completeSlackInstall();
    const handoff = await adapter.readSnapshot(agent.id);
    expect(handoff.messaging).toMatchObject({ kind: "waiting-handoff", provider: "slack" });

    controls.completeHandoff();
    const ready = await adapter.readSnapshot(agent.id);
    expect(ready.messaging).toMatchObject({ kind: "ready", provider: "slack" });
    expect(ready.stage).toBe("ready");
  });

  it("rejects writes that do not name the current attempt or binding", async () => {
    const agent = setupAgent();
    const { adapter } = createMemorySetupAdapter({
      agent,
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });

    await expect(adapter.unbindMessaging(agent.id, "slack", crypto.randomUUID())).rejects.toThrow(
      /not the current binding/,
    );
    await expect(adapter.cancelFeishuAttempt(crypto.randomUUID())).rejects.toThrow(/No open Lark attempt/);
    const expected = await currentMessagingExpectation(adapter, agent.id);
    await expect(adapter.startFeishuAttempt(agent.id, "reauthorize", expected)).rejects.toThrow(/current Lark binding/);
    await expect(adapter.startSlackInstall(agent.id, "reauthorize", expected)).resolves.toContain("https://slack.com/");

    const other = createMemorySetupAdapter({ agent });
    await expect(other.adapter.readSnapshot(crypto.randomUUID())).rejects.toThrow(/No such Agent/);
  });

  it("moves the Computer and runtime legs with the controls", async () => {
    const agent = setupAgent();
    const { adapter, controls } = createMemorySetupAdapter({ agent, messaging: { kind: "not-configured" } });

    controls.setComputerOnline(false);
    expect((await adapter.readSnapshot(agent.id)).stage).toBe("needs-computer");
    expect((await adapter.readSnapshot(agent.id)).blockers).toEqual([
      { code: "computer-offline", computerId: SETUP_COMPUTER_ID },
    ]);

    controls.setComputerOnline(true);
    controls.setRuntimeStatus("sign-in");
    const signingIn = await adapter.readSnapshot(agent.id);
    expect(signingIn.stage).toBe("needs-runtime");
    expect(signingIn.runtime).toMatchObject({ kind: "observed", provider: "codex", status: "sign-in" });

    controls.setRuntimeStatus("ready");
    expect((await adapter.readSnapshot(agent.id)).stage).toBe("needs-messaging");
  });

  it("never emits a snapshot the schema would reject, across the whole matrix", async () => {
    const seeds = [
      { agent: setupAgent({ computer: null }) },
      { agent: setupAgent({ requiresComputerRebind: true }) },
      { agent: setupAgent(), computerOnline: false },
      { agent: setupAgent(), runtimeStatus: "checking" },
      { agent: setupAgent(), runtimeMissing: true },
      { agent: setupAgent(), runtimeStatus: "unavailable" },
      { agent: setupAgent(), imCliReadiness: {} },
      { agent: setupAgent(), imCliReadiness: { slack: "install" } },
      { agent: setupAgent(), imCliReadiness: { feishu: "checking", slack: "unavailable" } },
      { agent: setupAgent(), computerOnline: false, imCliReadiness: {} },
      { agent: setupAgent() },
      { agent: setupAgent(), messaging: { kind: "bound", provider: "slack" } },
      { agent: setupAgent(), messaging: { kind: "bound", provider: "slack", reachable: true } },
      {
        agent: setupAgent(),
        messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "provider-error" },
      },
      {
        agent: setupAgent(),
        messaging: { kind: "bound", provider: "slack", attention: "unbind-required" },
      },
    ] as const;
    for (const seed of seeds) {
      const { adapter } = createMemorySetupAdapter(seed);
      const snapshot = await adapter.readSnapshot(seed.agent.id);
      expect(() => AgentSetupSnapshotSchema.parse(snapshot), snapshot.stage).not.toThrow();
    }
  });
});
