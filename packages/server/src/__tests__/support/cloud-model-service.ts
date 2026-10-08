import { afterEach, vi } from "vitest";
import type { CloudModelConfig } from "../../cloud-model-config.js";
import { CloudCallStore } from "../../services/cloud-call-store.js";
import { CloudModelService } from "../../services/cloud-model-service.js";

export const cloudTestOwner = {
  accountId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
};
const services: CloudModelService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

/** Transport-only fixtures inject a ledger; accounting suites use the real embedded database. */
export function createTestCloudModelService(
  config: Extract<CloudModelConfig, { enabled: true }>,
  fetchImpl?: typeof fetch,
) {
  const calls = new CloudCallStore({ query: vi.fn(async () => ({ rows: [] })) });
  const service = new CloudModelService(config, { calls, fetchImpl });
  services.push(service);
  return service;
}
