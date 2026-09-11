/**
 * The outside-world controls and the Computer legs of the in-memory Agent Setup model: connect
 * commands are issued, redeemed, or expire; a Computer is bound or repaired; and every control
 * refuses to move a state that has nothing for it to move.
 */

import { AgentSetupSnapshotSchema } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_ID, SETUP_COMPUTER_ID, SETUP_OTHER_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

async function blockedBindingId(adapter: ReturnType<typeof createMemorySetupAdapter>["adapter"]): Promise<string> {
  const snapshot = await adapter.readSnapshot(SETUP_AGENT_ID);
  if (snapshot.messaging.kind === "blocked" && snapshot.messaging.bindingId) return snapshot.messaging.bindingId;
  throw new Error("The snapshot does not carry a blocked binding");
}

describe("createMemorySetupAdapter Computer legs", () => {
  it("connects a new Computer through the issued command and lets the Agent bind it", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent({ computer: null }), computers: [] });
    const { connect, inventory } = memory.computerAdapter;
    expect(memory.inspect().computerConnectState).toBeUndefined();

    const issued = await connect.issue({ mode: "create" });
    expect(issued.expiresIn).toBe(15 * 60);
    expect(memory.inspect().computerConnectState).toBe("pending");
    expect(await connect.status(issued.connectCodeId)).toEqual({
      connectCodeId: issued.connectCodeId,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    });
    await expect(connect.status(crypto.randomUUID())).rejects.toThrow(/No Computer connect command/);

    memory.controls.completeComputerConnection();
    const status = await connect.status(issued.connectCodeId);
    expect(status.state).toBe("redeemed");
    expect(status.computerId).toEqual(expect.any(String));
    expect(status.redeemedAt).toEqual(expect.any(String));
    const { computers } = await connect.computers();
    expect(computers).toEqual([
      expect.objectContaining({ computerId: status.computerId, displayName: "Review Mac", connectionStatus: "online" }),
    ]);
    expect(await inventory.computers()).toEqual({ computers });
    // Connecting a Computer does not bind it: the Agent still has no Computer until the reader chooses.
    expect((await memory.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toEqual({ kind: "not-bound" });

    await inventory.bindComputer(SETUP_AGENT_ID, status.computerId ?? "missing");
    const bound = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(bound.agent.computer).toEqual({
      computerId: status.computerId,
      displayName: "Review Mac",
      platform: "darwin",
    });
    expect(bound.computer).toMatchObject({ kind: "bound", connectionStatus: "online" });
    expect(bound.stage).toBe("needs-messaging");
    expect(() => AgentSetupSnapshotSchema.parse(bound)).not.toThrow();
  });

  it("repairs the bound Computer in place and brings the Agent back online", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const offline = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(offline.stage).toBe("needs-computer");
    const before = (await memory.computerAdapter.connect.computers()).computers[0];
    expect(before).toMatchObject({
      computerId: SETUP_COMPUTER_ID,
      connectionStatus: "offline",
      agentIds: [SETUP_AGENT_ID],
    });

    const issued = await memory.computerAdapter.connect.issue({
      mode: "repair",
      target: { computerId: SETUP_COMPUTER_ID, displayName: "Review Mac" },
    });
    memory.controls.completeComputerConnection();

    const status = await memory.computerAdapter.connect.status(issued.connectCodeId);
    expect(status).toMatchObject({ state: "redeemed", computerId: SETUP_COMPUTER_ID });
    const { computers } = await memory.computerAdapter.connect.computers();
    expect(computers).toHaveLength(1);
    expect(computers[0]).toMatchObject({
      computerId: SETUP_COMPUTER_ID,
      connectionStatus: "online",
      lastSeenAt: null,
      createdAt: before?.createdAt,
      agentIds: [SETUP_AGENT_ID],
    });
    const repaired = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(repaired.computer).toMatchObject({ kind: "bound", connectionStatus: "online" });
    expect(repaired.stage).toBe("needs-messaging");
  });

  it("repairs a Computer the inventory no longer lists as a fresh darwin entry", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false, computers: [] });
    const target = { computerId: crypto.randomUUID(), displayName: "Spare Mac" };

    await memory.computerAdapter.connect.issue({ mode: "repair", target });
    memory.controls.completeComputerConnection();

    const { computers } = await memory.computerAdapter.connect.computers();
    expect(computers).toEqual([
      expect.objectContaining({ ...target, platform: "darwin", connectionStatus: "online", agentIds: [] }),
    ]);
    // The repaired identity is not the Agent's Computer, so the Agent stays offline.
    expect((await memory.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toMatchObject({ connectionStatus: "offline" });
  });

  it("expires an issued command and refuses to move a command that is not waiting", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
    expect(() => memory.controls.completeComputerConnection()).toThrow(/No Computer connect command is waiting/);
    expect(() => memory.controls.expireComputerConnection()).toThrow(/No Computer connect command is waiting/);

    const issued = await memory.computerAdapter.connect.issue({ mode: "create" });
    memory.controls.expireComputerConnection();

    expect(await memory.computerAdapter.connect.status(issued.connectCodeId)).toEqual({
      connectCodeId: issued.connectCodeId,
      state: "expired",
      computerId: null,
      redeemedAt: null,
    });
    expect(memory.inspect().computerConnectState).toBe("expired");
    expect(() => memory.controls.completeComputerConnection()).toThrow(/No Computer connect command is waiting/);
    expect(() => memory.controls.expireComputerConnection()).toThrow(/No Computer connect command is waiting/);
    expect((await memory.computerAdapter.connect.computers()).computers).toEqual([]);
  });

  it("binds only a Computer this Account lists, for the exact Agent", async () => {
    const spareId = crypto.randomUUID();
    const memory = createMemorySetupAdapter({
      agent: setupAgent({ requiresComputerRebind: true }),
      computers: [
        {
          computerId: spareId,
          displayName: "Spare Mac",
          platform: "linux",
          connectionStatus: "offline",
          connectedAt: null,
          lastSeenAt: "2026-09-01T10:00:00.000Z",
          observedAt: "2026-09-01T10:00:00.000Z",
          createdAt: "2026-09-01T10:00:00.000Z",
          agentIds: [],
        },
      ],
    });
    const { inventory } = memory.computerAdapter;

    await expect(inventory.bindComputer(SETUP_OTHER_AGENT_ID, spareId)).rejects.toThrow(/No such Agent/);
    await expect(inventory.bindComputer(SETUP_AGENT_ID, crypto.randomUUID())).rejects.toThrow(/No such Computer/);
    expect((await memory.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toMatchObject({ kind: "requires-rebind" });

    await inventory.bindComputer(SETUP_AGENT_ID, spareId);
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(snapshot.agent.requiresComputerRebind).toBe(false);
    expect(snapshot.agent.computer).toEqual({ computerId: spareId, displayName: "Spare Mac", platform: "linux" });
    // Binding an offline Computer leaves the Agent waiting on that Computer, not on a phantom online one.
    expect(snapshot.computer).toMatchObject({ kind: "bound", connectionStatus: "offline" });
    expect(snapshot.blockers).toEqual([{ code: "computer-offline", computerId: spareId }]);
  });

  it("tolerates an online toggle when there is no listed Computer to update", async () => {
    const unbound = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
    unbound.controls.setComputerOnline(false);
    expect((await unbound.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toEqual({ kind: "not-bound" });
    expect(unbound.getVersion()).toBe(1);

    const unlisted = createMemorySetupAdapter({ agent: setupAgent(), computers: [] });
    unlisted.controls.setComputerOnline(false);
    const snapshot = await unlisted.adapter.readSnapshot(SETUP_AGENT_ID);
    expect(snapshot.computer).toMatchObject({ kind: "bound", connectionStatus: "offline" });
    expect((await unlisted.computerAdapter.connect.computers()).computers).toEqual([]);

    unlisted.controls.setComputerOnline(true);
    expect((await unlisted.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toMatchObject({
      connectionStatus: "online",
    });
  });

  it("notifies subscribers once per change and lets them unsubscribe", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const seen: number[] = [];
    const unsubscribe = memory.subscribe(() => seen.push(memory.getVersion()));

    memory.controls.setRuntimeStatus("install");
    memory.controls.setObservationFailure("runtime");
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    memory.controls.runDoctor();
    expect(seen).toEqual([1, 2]);
    expect(memory.getVersion()).toBe(3);
  });
});

describe("createMemorySetupAdapter write guards", () => {
  it("answers only for the seeded Agent", async () => {
    const { adapter } = createMemorySetupAdapter({ agent: setupAgent() });

    await expect(adapter.refreshPreparation(SETUP_AGENT_ID)).resolves.toBeUndefined();
    await expect(adapter.refreshPreparation(SETUP_OTHER_AGENT_ID)).rejects.toThrow(/No such Agent/);
    await expect(adapter.startFeishuAttempt(SETUP_OTHER_AGENT_ID, "create", { kind: "unbound" })).rejects.toThrow(
      /No such Agent/,
    );
    await expect(adapter.startSlackInstall(SETUP_OTHER_AGENT_ID, "create", { kind: "unbound" })).rejects.toThrow(
      /No such Agent/,
    );
    await expect(adapter.unbindMessaging(SETUP_OTHER_AGENT_ID, "slack", crypto.randomUUID())).rejects.toThrow(
      /No such Agent/,
    );
  });

  it("refuses a second start while an authorization is already open", async () => {
    const feishu = createMemorySetupAdapter({ agent: setupAgent() });
    await feishu.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    await expect(feishu.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" })).rejects.toThrow(
      /started only from not-configured/,
    );

    const slack = createMemorySetupAdapter({ agent: setupAgent() });
    await slack.adapter.startSlackInstall(SETUP_AGENT_ID, "create", { kind: "unbound" });
    await expect(slack.adapter.startSlackInstall(SETUP_AGENT_ID, "create", { kind: "unbound" })).rejects.toThrow(
      /unbind before a fresh install/,
    );
  });

  it("rejects a maintained attempt that names a stale binding generation", async () => {
    const { adapter } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true },
    });
    const snapshot = await adapter.readSnapshot(SETUP_AGENT_ID);
    const bindingId = snapshot.messaging.kind === "ready" ? snapshot.messaging.bindingId : "missing";

    await expect(
      adapter.startFeishuAttempt(SETUP_AGENT_ID, "reauthorize", {
        kind: "bound",
        provider: "feishu",
        bindingId,
        credentialGeneration: 7,
      }),
    ).rejects.toThrow(/does not name the current Messaging binding generation/);
    await expect(
      adapter.startFeishuAttempt(SETUP_AGENT_ID, "replace", {
        kind: "bound",
        provider: "feishu",
        bindingId: crypto.randomUUID(),
        credentialGeneration: 1,
      }),
    ).rejects.toThrow(/does not name the current Messaging binding generation/);
    // A Slack reauthorization cannot ride on a Lark binding even when it names that binding exactly.
    await expect(
      adapter.startSlackInstall(SETUP_AGENT_ID, "reauthorize", {
        kind: "bound",
        provider: "feishu",
        bindingId,
        credentialGeneration: 1,
      }),
    ).rejects.toThrow(/Slack reauthorization requires the current Slack binding/);
    expect((await adapter.readSnapshot(SETUP_AGENT_ID)).messaging).toMatchObject({ kind: "ready", provider: "feishu" });
  });

  it("refuses an unbind or a handoff without a current binding", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });

    await expect(memory.adapter.unbindMessaging(SETUP_AGENT_ID, "slack", crypto.randomUUID())).rejects.toThrow(
      /unbind requires a current Messaging binding/,
    );
    expect(() => memory.controls.completeHandoff()).toThrow(/handoff requires a current Messaging binding/);

    const observed = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    expect(() => observed.controls.completeHandoff()).toThrow(/already observed/);
    const snapshot = await observed.adapter.readSnapshot(SETUP_AGENT_ID);
    const bindingId = snapshot.messaging.kind === "ready" ? snapshot.messaging.bindingId : "missing";
    await expect(observed.adapter.unbindMessaging(SETUP_AGENT_ID, "feishu", bindingId)).rejects.toThrow(
      /not the current binding/,
    );
  });
});

describe("createMemorySetupAdapter authorization outcomes", () => {
  it("refuses the outside-world moves when nothing is waiting for them", () => {
    const { controls } = createMemorySetupAdapter({ agent: setupAgent() });

    expect(() => controls.scanFeishuCode()).toThrow(/No Lark attempt is waiting for a scan/);
    expect(() => controls.failFeishuAttempt()).toThrow(/No Lark attempt is open/);
    expect(() => controls.failSlackInstall()).toThrow(/No Slack install is open/);
    expect(() => controls.completeSlackInstall()).toThrow(/No Slack install is waiting/);
  });

  it("turns a failed first Lark attempt into a binding that must be unbound", async () => {
    const { adapter, controls } = createMemorySetupAdapter({ agent: setupAgent() });
    await adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });

    controls.failFeishuAttempt();

    const blocked = await adapter.readSnapshot(SETUP_AGENT_ID);
    expect(blocked.stage).toBe("needs-messaging");
    expect(blocked.messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      code: "authorization-failed",
      credentialGeneration: 0,
    });
    const bindingId = await blockedBindingId(adapter);
    expect(blocked.blockers).toEqual([
      { code: "messaging-not-ready", provider: "feishu", bindingId, state: "blocked" },
    ]);
    expect(blocked.actions).toEqual([{ kind: "unbind-messaging", provider: "feishu", bindingId }]);
    expect(() => AgentSetupSnapshotSchema.parse(blocked)).not.toThrow();
  });

  it("returns a failed Lark reauthorization to the binding it was maintaining", async () => {
    const { adapter, controls } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "provider-error" },
    });
    const bindingId = await blockedBindingId(adapter);
    await adapter.startFeishuAttempt(SETUP_AGENT_ID, "reauthorize", {
      kind: "bound",
      provider: "feishu",
      bindingId,
      credentialGeneration: 1,
    });
    expect((await adapter.readSnapshot(SETUP_AGENT_ID)).messaging).toMatchObject({ kind: "authorizing" });

    controls.failFeishuAttempt();

    expect((await adapter.readSnapshot(SETUP_AGENT_ID)).messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      bindingId,
      credentialGeneration: 1,
      code: "provider-error",
    });
  });

  it("turns a failed first Slack install into a binding that must be unbound", async () => {
    const { adapter, controls } = createMemorySetupAdapter({ agent: setupAgent() });
    await adapter.startSlackInstall(SETUP_AGENT_ID, "create", { kind: "unbound" });
    expect((await adapter.readSnapshot(SETUP_AGENT_ID)).actions).toEqual([{ kind: "refresh" }]);

    controls.failSlackInstall();

    const blocked = await adapter.readSnapshot(SETUP_AGENT_ID);
    expect(blocked.messaging).toMatchObject({
      kind: "blocked",
      provider: "slack",
      code: "authorization-failed",
      credentialGeneration: 0,
    });
    const bindingId = await blockedBindingId(adapter);
    expect(blocked.actions).toEqual([{ kind: "unbind-messaging", provider: "slack", bindingId }]);
    expect(() => AgentSetupSnapshotSchema.parse(blocked)).not.toThrow();
  });

  it("restores the Slack binding a failed reauthorization was maintaining", async () => {
    const { adapter, controls } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "reauthorization-required" },
    });
    const bindingId = await blockedBindingId(adapter);
    await adapter.startSlackInstall(SETUP_AGENT_ID, "reauthorize", {
      kind: "bound",
      provider: "slack",
      bindingId,
      credentialGeneration: 1,
    });

    controls.failSlackInstall();

    expect((await adapter.readSnapshot(SETUP_AGENT_ID)).messaging).toMatchObject({
      kind: "blocked",
      provider: "slack",
      bindingId,
      credentialGeneration: 1,
      code: "reauthorization-required",
    });
  });

  it("advances the credential generation when a Slack reauthorization completes", async () => {
    const { adapter, controls } = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "reauthorization-required" },
    });
    const bindingId = await blockedBindingId(adapter);
    await adapter.startSlackInstall(SETUP_AGENT_ID, "reauthorize", {
      kind: "bound",
      provider: "slack",
      bindingId,
      credentialGeneration: 1,
    });

    controls.completeSlackInstall();

    const ready = await adapter.readSnapshot(SETUP_AGENT_ID);
    expect(ready.stage).toBe("ready");
    expect(ready.messaging).toEqual({ kind: "ready", provider: "slack", bindingId, credentialGeneration: 2 });
    expect(ready.actions).toEqual([
      { kind: "reauthorize-messaging", provider: "slack", bindingId, credentialGeneration: 2 },
      { kind: "unbind-messaging", provider: "slack", bindingId },
    ]);
  });
});
