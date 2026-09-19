import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCloudSessionWorkerRequest } from "@opentag/shared";
import { afterEach, expect, it } from "vitest";
import { cloudSessionCliEnvironment, cloudWorkerInput } from "../runner/cloud-worker-input.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessionRequest(): RunnerCloudSessionWorkerRequest {
  const delivery = cloudDeliveryFixture();
  return {
    kind: "session-message",
    executionDir: "/execution/current",
    sessionKind: "internal",
    message: {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: delivery.sessionId,
      agentId: delivery.agentId,
      placementGeneration: delivery.placementGeneration,
      content: { kind: "text", text: "Report progress to the parent." },
      runtime: delivery.runtime,
    },
    model: {
      model: "fixture-model",
      token: "fixture-token",
      baseUrl: "https://example.test/model",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
}

it("internal collaboration asks for an explicit Session reply without inheriting IM outbox instructions", () => {
  const request = sessionRequest();
  const input = cloudWorkerInput(request);
  const text = JSON.stringify(input);
  expect(text).toContain("Your final text is not returned automatically");
  expect(text).toContain("opentag session send");
  expect(text).not.toContain("Default provider outbox context");
  expect(input.items.at(-1)).toEqual({ type: "text", text: request.message.content.text });
});

it("visible callbacks retain their exact outbox and never infer it from message text", () => {
  const request = { ...sessionRequest(), sessionKind: "visible" as const };
  expect(() => cloudWorkerInput(request)).toThrow("outbox context");
  const input = cloudWorkerInput({
    ...request,
    outboxContext: {
      provider: "slack",
      channelId: "channel-fixture",
      sessionKind: "thread",
      threadTs: "1700000000.1234",
    },
  });
  const text = JSON.stringify(input);
  expect(text).toContain("channel-fixture");
  expect(text).toContain("1700000000.1234");
  expect(text).toContain("deliver it through the provider CLI");
});

it("materializes a scoped proof only in private execution scratch", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-session-proof-"));
  roots.push(scratch);
  const request = sessionRequest();
  expect(await cloudSessionCliEnvironment(request, scratch)).toEqual({});
  const proof = { proofId: randomUUID(), token: "fixture-proof-token-not-a-real-credential" };
  const environment = await cloudSessionCliEnvironment(
    { ...request, sessionCollaboration: { proof, serverUrl: "https://server.example.test" } },
    scratch,
  );
  const path = environment.OPENTAG_SESSION_PROOF_FILE as string;
  expect(path.startsWith(`${scratch}/`)).toBe(true);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(proof);
  expect(environment.OPENTAG_SESSION_SERVER_URL).toBe("https://server.example.test");
  await rm(scratch, { recursive: true });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
