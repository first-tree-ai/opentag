import { describe, expect, it, vi } from "vitest";
import { reconcileDaemonService } from "../core/daemon/reconcile-service.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";

describe("daemon service reconciliation", () => {
  it("defers service installation until credentials exist", async () => {
    const manager = fakeManager("not-installed");
    await expect(
      reconcileDaemonService({ createManager: async () => manager, hasCredentials: async () => false }),
    ).resolves.toMatchObject({ reason: "credentials-missing", status: "deferred" });
    expect(manager.installAndStart).not.toHaveBeenCalled();
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("defers unsupported platforms without inspecting credentials", async () => {
    const manager = fakeManager("not-installed", { platform: "unsupported" });
    const hasCredentials = vi.fn(async () => true);
    await expect(reconcileDaemonService({ createManager: async () => manager, hasCredentials })).resolves.toMatchObject(
      { reason: "unsupported-platform", status: "deferred" },
    );
    expect(hasCredentials).not.toHaveBeenCalled();
  });

  it("restarts an active current service so rebuilt code takes over", async () => {
    const manager = fakeManager("active");
    await expect(
      reconcileDaemonService({ createManager: async () => manager, hasCredentials: async () => true }),
    ).resolves.toMatchObject({ action: "restarted", status: "ready" });
    expect(manager.restart).toHaveBeenCalledOnce();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it.each([
    ["a drifted service", "active", true],
    ["an active service with unverifiable configuration", "active", undefined],
    ["a missing service", "not-installed", false],
    ["an inactive service", "inactive", false],
  ] as const)("installs or repairs %s", async (_label, state, drifted) => {
    const manager = fakeManager(state, { drifted });
    await expect(
      reconcileDaemonService({ createManager: async () => manager, hasCredentials: async () => true }),
    ).resolves.toMatchObject({ action: "installed-or-repaired", status: "ready" });
    expect(manager.installAndStart).toHaveBeenCalledOnce();
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("fails specifically when the reconciled service is not active", async () => {
    const manager = fakeManager("active");
    manager.restart = vi.fn(async () => ({ ...(await manager.status()), state: "inactive" as const }));
    await expect(
      reconcileDaemonService({ createManager: async () => manager, hasCredentials: async () => true }),
    ).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
});

function fakeManager(
  state: "active" | "inactive" | "not-installed",
  overrides: { drifted?: boolean; platform?: "systemd" | "unsupported" } = {},
): DaemonServiceManager {
  const info = {
    currentHome: "/home/user/.opentag-dev",
    definitionPath: "/service/opentag-dev.service",
    drifted: Object.hasOwn(overrides, "drifted") ? overrides.drifted : false,
    logHint: "journal",
    platform: overrides.platform ?? ("systemd" as const),
    serviceId: "opentag-dev",
    state,
  };
  return {
    installAndStart: vi.fn(async () => ({ ...info, state: "active" as const })),
    preflight: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ ...info, state: "active" as const })),
    start: vi.fn(async () => ({ ...info, state: "active" as const })),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}
