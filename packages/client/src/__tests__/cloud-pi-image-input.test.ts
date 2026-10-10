import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerCloudWorkerRequestSchema } from "@opentag/shared";
import { expect, it } from "vitest";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import { cloudTurnPiDocuments } from "../runner/cloud-turn-worker.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const PI_CLI = fileURLToPath(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC",
  "base64",
);

it.each([
  { model: "gemini-3.8-flash", images: true },
  { model: "glm-5.3", images: false },
  { model: "unknown-vision-model", images: false },
])(
  "carries native read images to the model only for verified $model through real Pi RPC",
  async ({ model, images }) => {
    const root = await mkdtemp(join(tmpdir(), "opentag-cloud-pi-image-"));
    const piHome = join(root, "pi");
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    await Promise.all([mkdir(piHome), mkdir(workspace), mkdir(sessions)]);
    await writeFile(join(workspace, "original.png"), PNG);
    const calls: Array<{ path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }> =
      [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      calls.push({ path: request.url, authorization: request.headers.authorization, body });
      const reading = calls.length === 1;
      const delta = reading
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-original",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "original.png" }) },
              },
            ],
          }
        : { role: "assistant", content: "fixture transport complete" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { delta, finish_reason: null },
        { delta: {}, finish_reason: reading ? "tool_calls" : "stop" },
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
    let runtime: Awaited<ReturnType<PiAgentRuntimeFactory["create"]>> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no port");
      const token = "fixture-execution-token-0123456789abcdef";
      // The existing wire request has no modality field. Parse it through the production schema.
      const request = RunnerCloudWorkerRequestSchema.parse({
        kind: "turn",
        executionDir: join(root, "execution"),
        delivery: cloudDeliveryFixture(),
        model: {
          model,
          baseUrl: `http://127.0.0.1:${address.port}/api/v1/cloud-model`,
          token,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          contextWindow: 258_000,
          maxTokens: 8_192,
        },
      });
      const documents = cloudTurnPiDocuments(request);
      await Promise.all([
        writeFile(join(piHome, "models.json"), documents.modelsJson),
        writeFile(join(piHome, "auth.json"), documents.authJson),
        writeFile(join(piHome, "settings.json"), documents.settingsJson),
      ]);
      const factory = new PiAgentRuntimeFactory({
        process: {
          command: process.execPath,
          args: [PI_CLI],
          env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: piHome },
          sessionDirectory: sessions,
        },
      });
      runtime = await factory.create({
        eventSink: () => undefined,
        systemPrompt: "Read the original image when requested.",
        workspace: { cwd: workspace },
        policy: {
          approvals: "never",
          fileSystem: "unrestricted",
          network: "enabled",
          tools: { mode: "provider-default" },
        },
        configuration: { model: `opentag/${model}` },
      });
      const result = await runtime.prompt({
        runId: "cloud-native-image-read",
        input: { items: [{ type: "text", text: "Read original.png." }] },
        signal: AbortSignal.timeout(25_000),
      });
      expect(result.status).toBe("completed");
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.path === "/api/v1/cloud-model/chat/completions")).toBe(true);
      expect(calls.every((call) => call.authorization === `Bearer ${token}` && call.body.model === model)).toBe(true);
      // The text prompt carries no eager image; the second request follows the real native read.
      expect(JSON.stringify(calls[0]?.body.messages)).not.toContain("image_url");
      const messages = calls[1]?.body.messages as Array<{ role: string; content: unknown }>;
      expect(messages.some((message) => message.role === "tool")).toBe(true);
      const parts = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])) as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const imageParts = parts.filter((part) => part.type === "image_url");
      expect(imageParts, JSON.stringify(messages)).toHaveLength(images ? 1 : 0);
      if (images) {
        expect(imageParts[0]?.image_url?.url).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
        expect(JSON.stringify(messages)).not.toContain("Current model does not support images");
      } else {
        expect(JSON.stringify(messages)).toContain("Current model does not support images");
      }
    } finally {
      await runtime?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  30_000,
);
