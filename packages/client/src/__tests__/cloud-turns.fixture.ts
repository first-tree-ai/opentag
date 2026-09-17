import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";

/** A minimal valid Cloud delivery payload for runner-side journal/turn tests. */
export function cloudDeliveryFixture(
  overrides: Partial<DirectImMessageDeliveryRequest> = {},
): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "app",
        botOpenId: "bot",
        chatId: "chat",
        messageId: "msg",
      },
    },
    runtime: {
      agentId,
      contextTreeRepository: null,
      instructions: { agent: "Agent.", platform: "Platform." },
      provider: "pi",
      model: "deepseek-v4.1-flash-expires-on-0910",
      revision: {
        agent: { id: randomUUID(), sequence: 1 },
        session: { id: randomUUID(), sequence: 1 },
      },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
    },
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}
