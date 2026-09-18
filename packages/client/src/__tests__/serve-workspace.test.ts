import { describe, expect, it, vi } from "vitest";
import type { CloudTurnRunner } from "../runner/cloud-turns.js";
import type { CloudWorkspace } from "../runner/cloud-workspace.js";
import type { NativeSandbox } from "../runner/native-sandbox.js";
import { ServeWorkspace, type WorkspaceNativeState } from "../runner/serve-workspace.js";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events: string[] = [];
  const state: WorkspaceNativeState = {
    present: true,
    stopping: false,
    fatal: false,
    probe: { nodeVersion: "v24.20.0", piVersion: "test", runnerVersion: "0.0.5" },
  };
  const workspace = {
    initialized: false,
    pendingSave: false,
    sealed: false,
    initialize: vi.fn(async () => {
      events.push("restore");
      workspace.initialized = true;
      workspace.pendingSave = false;
    }),
    save: vi.fn(async (seal = false) => {
      events.push(seal ? "seal" : "save");
      workspace.sealed = seal;
    }),
  };
  const sandbox = {
    destroy: vi.fn(async () => {
      events.push("destroy");
    }),
    launch: vi.fn(async () => {
      events.push("launch");
    }),
    probe: vi.fn(async () => {
      events.push("probe");
      return state.probe;
    }),
  };
  const turns = {
    waitForActive: vi.fn(async (): Promise<void> => undefined),
    drainForRelease: vi.fn(async () => {
      events.push("reports-acked");
    }),
  };
  const controller = new ServeWorkspace({
    workspace: workspace as unknown as CloudWorkspace,
    sandbox: sandbox as unknown as NativeSandbox,
    state: () => state,
    turns: turns as unknown as CloudTurnRunner,
  });
  return { controller, events, workspace, sandbox, turns, state };
}

describe("Runner workspace occupation", () => {
  it("keeps writers stopped and readiness false until restoration completes", async () => {
    const f = fixture();
    const entered = deferred();
    const finish = deferred();
    f.workspace.initialize.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      f.workspace.initialized = true;
    });
    const preparing = f.controller.prepare();
    await entered.promise;
    expect(f.state.present).toBe(false);
    expect(f.controller.ready).toBe(false);
    expect(f.sandbox.launch).not.toHaveBeenCalled();
    finish.resolve();
    expect(await preparing).toBe(true);
    expect(f.controller.ready).toBe(true);
    const calls = f.sandbox.destroy.mock.calls.length;
    await f.controller.prepare();
    expect(f.sandbox.destroy).toHaveBeenCalledTimes(calls);
  });

  it("keeps unsaved files quiescent after a failed save and retries before reopening execution", async () => {
    const f = fixture();
    await f.controller.prepare();
    f.events.length = 0;
    f.workspace.save.mockImplementationOnce(async () => {
      f.workspace.pendingSave = true;
      throw new Error("storage unavailable");
    });
    await expect(f.controller.checkpoint()).rejects.toThrow("storage unavailable");
    expect(f.controller.ready).toBe(false);
    expect(f.state.present).toBe(false);
    expect(f.state.fatal).toBe(false);
    expect(f.events).toEqual(["destroy"]);
    expect(await f.controller.prepare()).toBe(true);
    expect(f.events).toEqual(["destroy", "restore", "launch", "probe"]);
  });

  it("waits for result acknowledgment before sealing and never relaunches a sealed allocation", async () => {
    const f = fixture();
    await f.controller.prepare();
    f.events.length = 0;
    const entered = deferred();
    const ack = deferred();
    f.turns.drainForRelease.mockImplementationOnce(async () => {
      entered.resolve();
      await ack.promise;
      f.events.push("reports-acked");
    });
    const sealing = f.controller.seal();
    await entered.promise;
    expect(f.controller.ready).toBe(false);
    expect(f.workspace.save).not.toHaveBeenCalled();
    ack.resolve();
    await sealing;
    expect(f.events).toEqual(["reports-acked", "destroy", "seal"]);
    expect(f.state.present).toBe(false);
    expect(await f.controller.prepare()).toBe(false);
    expect(f.controller.ready).toBe(false);
  });

  it("does not deadlock reconnect behind an active Turn's checkpoint", async () => {
    const f = fixture();
    await f.controller.prepare();
    const entered = deferred();
    const upload = deferred();
    const turnDone = deferred();
    f.workspace.save.mockImplementationOnce(async () => {
      entered.resolve();
      await upload.promise;
    });
    const checkpoint = f.controller.checkpoint().then(() => turnDone.resolve());
    await entered.promise;
    f.turns.waitForActive.mockImplementationOnce(() => turnDone.promise);
    const reconnect = f.controller.prepare();
    upload.resolve();
    await checkpoint;
    expect(await reconnect).toBe(true);
  });

  it("treats failure to stop native writers as fatal and never archives their live directory", async () => {
    const f = fixture();
    f.sandbox.destroy.mockRejectedValueOnce(new Error("native delete failed"));
    await expect(f.controller.prepare()).rejects.toThrow("native delete failed");
    expect(f.state.fatal).toBe(true);
    expect(f.workspace.initialize).not.toHaveBeenCalled();
    expect(f.workspace.save).not.toHaveBeenCalled();
  });
});
