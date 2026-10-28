import { randomUUID } from "node:crypto";
import type { RuntimeImSteerRequest } from "@opentag/shared";
import { expect, it, vi } from "vitest";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { CloudImSteering } from "../services/sandboxes/cloud-im-steering.js";
import { CloudRuntimeFence } from "../services/sandboxes/cloud-runtime-fence.js";

it.each(["dispatched", "already_dispatched"] as const)(
  "keeps execution evidence correct when capacity rejects a %s steer",
  async (lastStatus) => {
    const sessionId = randomUUID();
    const record = new CloudRuntimeFence().attach({
      computerId: randomUUID(),
      installationId: randomUUID(),
      imInputVersion: 1,
      scope: {
        sandboxId: randomUUID(),
        sessionId,
        environmentGeneration: 1,
        resourceName: "projects/p/locations/r/instances/test",
      },
    });
    const requests = Array.from({ length: 1025 }, () => ({
      type: "im:steer" as const,
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      imMessageId: randomUUID(),
      sessionId,
      agentId: randomUUID(),
      placementGeneration: 1,
      rootDeliveryId: randomUUID(),
      expectedTurnId: randomUUID(),
      attention: "direct" as const,
      content: {
        kind: "text" as const,
        text: "synthetic input",
        providerRef: {
          provider: "feishu" as const,
          teamBrand: "feishu" as const,
          appId: "app",
          botOpenId: "bot",
          chatId: "chat",
          messageId: "source",
        },
      },
    }));
    const last = requests.at(-1);
    if (!last) throw new Error("missing request");
    const reserved = new Set<string>();
    const begin = vi.fn(async (request: RuntimeImSteerRequest) => {
      reserved.add(request.deliveryId);
      return request === last ? lastStatus : ("dispatched" as const);
    });
    const release = vi.fn(async (request: RuntimeImSteerRequest) => {
      reserved.delete(request.deliveryId);
      return "released" as const;
    });
    const context = {
      computerId: record.computerId,
      installationId: record.installationId,
      instanceId: record.instanceId,
      signal: new AbortController().signal,
    };
    const send = vi.fn(() => true);
    const steering = new CloudImSteering({
      database: {} as never,
      custody: { beginSteerDispatch: begin, releaseSteerDispatch: release } as unknown as RuntimeCustodyStore,
      connection: async () => ({ record, context, send }),
      current: () => true,
      validAllocation: async () => true,
      context: () => context,
      send,
    });
    const results = requests.map((request) => steering.request(request, () => {}).catch((error: unknown) => error));
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1024));
      expect(await results.at(-1)).toMatchObject({ message: "CLOUD_STEER_CAPACITY" });
      if (lastStatus === "dispatched") {
        expect(release).toHaveBeenCalledWith(last, expect.any(String), "retry");
        expect(reserved.has(last.deliveryId)).toBe(false);
      } else {
        expect(release).not.toHaveBeenCalled();
        expect(reserved.has(last.deliveryId)).toBe(true);
      }
    } finally {
      steering.detach(record.connectionId);
      await Promise.all(results);
    }
  },
);
