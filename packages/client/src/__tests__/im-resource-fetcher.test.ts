import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImResourceFetcher } from "../runtime/im-resource-fetcher.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

describe("ImResourceFetcher", () => {
  it("isolates the same provider resource across concurrent deliveries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-im-resource-"));
    homes.push(workspace);
    const openImResource = vi.fn(async () => new Response("resource-body"));
    const fetcher = new ImResourceFetcher({
      computerId: randomUUID(),
      instanceId: randomUUID(),
      api: { openImResource },
      tokenProvider: { getAccessTokenLease: async () => ({ accessToken: "token" }) as never },
    });
    const first = request();
    const second = { ...request(), imMessageId: first.imMessageId, content: first.content };

    const [firstResult, secondResult] = await Promise.all([
      fetcher.fetchForTurn(first, workspace),
      fetcher.fetchForTurn(second, workspace),
    ]);
    const firstPath = firstResult?.split(": ").at(-1);
    const secondPath = secondResult?.split(": ").at(-1);

    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(firstPath).not.toBe(secondPath);
    expect(await readFile(firstPath as string, "utf8")).toBe("resource-body");
    expect(await readFile(secondPath as string, "utf8")).toBe("resource-body");
    expect(openImResource).toHaveBeenCalledTimes(2);
  });
});

function request(): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  const imMessageId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId,
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "with resource",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
      resources: [
        {
          imMessageId,
          ordinal: 0,
          kind: "file",
          filename: "report.txt",
          availability: "available",
        },
      ],
    },
    runtime: {
      revision: {
        agent: { sequence: 1, id: agentId },
        session: { sequence: 1, id: "session-1" },
      },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
  };
}
