import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeFactory, AgentRuntimePolicy } from "../agent-runtime/types.js";
import {
  type AgentRuntimeProviderRegistration,
  AgentRuntimeProviderRegistry,
} from "../runtime/agent-runtime-provider-registry.js";

const policy: AgentRuntimePolicy = {
  fileSystem: "workspace-write",
  network: "disabled",
  approvals: "never",
  tools: { mode: "allow-list", names: [] },
};

describe("AgentRuntimeProviderRegistry", () => {
  it("indexes immutable registrations and owns artifact identity, policy, and configuration validation", () => {
    const codex = registration(factory("codex"));
    const claude = registration(factory("claude-code"), "b".repeat(64));
    const providers = new AgentRuntimeProviderRegistry([codex, claude]);

    expect(providers.registration("codex")).toMatchObject({ factory: codex.factory, artifactIdentity: "a".repeat(64) });
    expect(Object.isFrozen(providers.registration("codex"))).toBe(true);
    expect(providers.artifactIdentity("claude-code")).toBe("b".repeat(64));
    expect(providers.registration("missing")).toBeUndefined();
    expect(providers.artifactIdentity("missing")).toBeUndefined();
    expect(providers.validate(snapshot())).toBe("provider_unavailable");
    expect(providers.validate({ ...snapshot(), execution: { ...snapshot().execution, networkAccess: true } })).toBe(
      "configuration_unsupported",
    );
    expect(
      providers.validateConfiguration({ ...snapshot(), execution: { ...snapshot().execution, networkAccess: true } }),
    ).toBe("configuration_unsupported");
    expect(providers.validateConfiguration({ ...snapshot(), provider: "missing" } as never)).toBe(
      "configuration_unsupported",
    );
    expect(providers.registration("codex")?.policy(snapshot())).toEqual(policy);
  });

  it("rejects duplicate, invalid provider IDs, and invalid-artifact registrations", () => {
    expect(
      () => new AgentRuntimeProviderRegistry([registration(factory("codex")), registration(factory("codex"))]),
    ).toThrow("duplicated");
    expect(() => new AgentRuntimeProviderRegistry([registration(factory(""))])).toThrow("invalid");
    expect(() => new AgentRuntimeProviderRegistry([registration(factory("Claude_Code"))])).toThrow("invalid");
    expect(() => new AgentRuntimeProviderRegistry([registration(factory("codex"), "bad")])).toThrow(
      "artifact identity",
    );
  });

  it("refreshes readiness, verifies the artifact, and revokes availability after failure", async () => {
    let ready = true;
    const probe = vi.fn(async () =>
      ready
        ? { ready: true as const, version: "fixture", issues: [] }
        : {
            ready: false as const,
            issues: [{ code: "artifact_missing" as const, message: "missing" }],
          },
    );
    const verifyArtifact = vi.fn(async () => undefined);
    const providers = new AgentRuntimeProviderRegistry([{ ...registration(factory("codex", probe)), verifyArtifact }]);

    await expect(providers.refresh("codex", new AbortController().signal)).resolves.toBe(true);
    expect(providers.isReady("codex")).toBe(true);
    expect(providers.validate(snapshot())).toBeUndefined();
    expect(verifyArtifact).toHaveBeenCalledOnce();
    await providers.ensureReady("codex");
    expect(probe).toHaveBeenCalledOnce();

    ready = false;
    await expect(providers.refresh("codex")).resolves.toBe(false);
    expect(providers.isReady("codex")).toBe(false);
    expect(providers.validate(snapshot())).toBe("provider_unavailable");
    await expect(providers.ensureReady("codex")).rejects.toThrow("artifact_missing: missing");
  });

  it("deduplicates the underlying probe while each waiter retains its own cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const probe = vi.fn(async (_request: Parameters<AgentRuntimeFactory["probe"]>[0]) => {
      await gate;
      return { ready: true as const, issues: [] };
    });
    const providers = new AgentRuntimeProviderRegistry([registration(factory("codex", probe))]);
    const ownerController = new AbortController();
    const owner = providers.ensureReady("codex", ownerController.signal);
    const joinedWithoutSignal = providers.ensureReady("codex");
    const joinedController = new AbortController();
    const joinedWithSignal = providers.ensureReady("codex", joinedController.signal);

    const preAborted = new AbortController();
    preAborted.abort(new Error("already stopped"));
    await expect(providers.ensureReady("codex", preAborted.signal)).rejects.toThrow("already stopped");

    const waiterAbort = new AbortController();
    const waiter = providers.ensureReady("codex", waiterAbort.signal);
    waiterAbort.abort(new Error("stop waiter"));
    await expect(waiter).rejects.toThrow("stop waiter");
    expect(probe).toHaveBeenCalledOnce();
    const underlyingSignal = probe.mock.calls[0]?.[0].signal;
    expect(underlyingSignal).toBeInstanceOf(AbortSignal);
    expect(underlyingSignal).not.toBe(ownerController.signal);
    expect(underlyingSignal?.aborted).toBe(false);

    ownerController.abort(new Error("stop owner"));
    await expect(owner).rejects.toThrow("stop owner");
    expect(probe).toHaveBeenCalledOnce();

    release();
    await Promise.all([joinedWithoutSignal, joinedWithSignal]);
    expect(providers.isReady("codex")).toBe(true);
  });

  it("fails closed for missing registrations, artifact verification errors, and caller abort", async () => {
    const empty = new AgentRuntimeProviderRegistry();
    await expect(empty.ensureReady("missing")).rejects.toThrow("not registered");
    await expect(empty.refresh("missing")).resolves.toBe(false);
    expect(empty.isReady("missing")).toBe(false);

    const verificationFailure = new AgentRuntimeProviderRegistry([
      {
        ...registration(factory("codex")),
        verifyArtifact: async () => {
          throw new Error("artifact replaced");
        },
      },
    ]);
    await expect(verificationFailure.refresh("codex")).resolves.toBe(false);
    expect(verificationFailure.isReady("codex")).toBe(false);

    let release!: () => void;
    let completions = 0;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const probe = vi.fn(async (_request: Parameters<AgentRuntimeFactory["probe"]>[0]) => {
      if (probe.mock.calls.length > 1) await gate;
      completions += 1;
      return { ready: true as const, issues: [] };
    });
    const aborting = new AgentRuntimeProviderRegistry([registration(factory("codex", probe))]);
    await expect(aborting.refresh("codex")).resolves.toBe(true);
    const controller = new AbortController();
    const refreshing = aborting.refresh("codex", controller.signal);
    controller.abort(new Error("stop registry probe"));
    await expect(refreshing).rejects.toThrow("stop registry probe");
    expect(aborting.isReady("codex")).toBe(true);
    expect(probe.mock.calls[1]?.[0].signal?.aborted).toBe(true);
    release();
    await vi.waitFor(() => expect(completions).toBe(2));

    const preAborted = new AbortController();
    preAborted.abort(new Error("stop ready lookup"));
    await expect(aborting.ensureReady("codex", preAborted.signal)).rejects.toThrow("stop ready lookup");

    const preAbortedRefresh = new AbortController();
    preAbortedRefresh.abort(new Error("stop before refresh"));
    await expect(aborting.refresh("codex", preAbortedRefresh.signal)).rejects.toThrow("stop before refresh");
    expect(probe).toHaveBeenCalledTimes(2);

    const synchronousController = new AbortController();
    const synchronousFailure = new Error("stop while probe starts");
    const synchronousProbe = vi.fn(async () => {
      synchronousController.abort(synchronousFailure);
      throw synchronousFailure;
    });
    const synchronous = new AgentRuntimeProviderRegistry([registration(factory("codex", synchronousProbe))]);
    await expect(synchronous.refresh("codex", synchronousController.signal)).rejects.toThrow("stop while probe starts");
    await vi.waitFor(() => expect(synchronousProbe).toHaveBeenCalledOnce());
  });
});

function factory(providerId: string, probe: AgentRuntimeFactory["probe"] = async () => ({ ready: true, issues: [] })) {
  return {
    manifest: { providerId, displayName: providerId, contractVersion: 1, bindingSchemaVersion: 1 },
    probe,
    create: async () => {
      throw new Error("not used");
    },
    resume: async () => {
      throw new Error("not used");
    },
  } satisfies AgentRuntimeFactory;
}

function registration(
  runtimeFactory: AgentRuntimeFactory,
  artifactIdentity = "a".repeat(64),
): AgentRuntimeProviderRegistration {
  return {
    artifactIdentity,
    factory: runtimeFactory,
    policy: () => policy,
    validate: (runtime) => (runtime.execution.networkAccess ? "configuration_unsupported" : undefined),
  };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}
