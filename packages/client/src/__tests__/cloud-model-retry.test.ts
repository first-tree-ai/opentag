import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudTurnPiDocuments } from "../runner/cloud-turn-worker.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function answer(): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "Completed." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function rejected(status = 429, retryAfter?: string): Response {
  return Response.json(
    {
      error: {
        code: status === 429 ? "rate_limit_exceeded" : "authentication_error",
        message: "Model request refused",
      },
    },
    { status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } },
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (check()) return;
    await setImmediate();
  }
  throw new Error("Pi did not reach the expected request boundary");
}

async function fixture(response: (attempt: number) => Response) {
  const root = await mkdtemp(join(tmpdir(), "cloud-model-retry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const documents = cloudTurnPiDocuments({
    delivery: cloudDeliveryFixture(),
    kind: "turn",
    executionDir: "/run/opentag-execution/test",
    model: {
      baseUrl: "https://model.invalid/v1",
      model: "model-a",
      token: "fixture-model-grant",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      contextWindow: 258_000,
      maxTokens: 8_192,
    },
  });
  await writeFile(join(root, "auth.json"), documents.authJson);
  await writeFile(join(root, "models.json"), documents.modelsJson);
  await writeFile(join(root, "settings.json"), documents.settingsJson);
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ retry: { enabled: true, maxRetries: 99, provider: { maxRetries: 99 } } }),
  );
  // Managed Pi already passes --no-approve, so restored project settings cannot reset its retry budget.
  const settings = SettingsManager.create(root, root, { projectTrusted: false });
  settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 0 } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("opentag", "model-a");
  if (!model) throw new Error("Cloud model fixture was not loaded by the pinned Pi");
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Reply briefly.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    resourceLoader,
    tools: [],
    thinkingLevel: "off",
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
  });
  cleanups.push(async () => {
    await session.abort();
    session.dispose();
  });
  const requests: number[] = [];
  const bodies: { messages: unknown[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input instanceof Request ? input.url : input)).toBe("https://model.invalid/v1/chat/completions");
      requests.push(Date.now());
      bodies.push(JSON.parse(String(init?.body)));
      return response(requests.length);
    }),
  );
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  return { session, requests, bodies, events };
}

async function exhaust(session: AgentSession, requests: readonly number[]): Promise<void> {
  const work = session.prompt("Complete this task once.");
  await until(() => requests.length > 0);
  await vi.runAllTimersAsync();
  await work;
}

describe("Cloud Pi makes one request per model or summary call", () => {
  it.each([400, 401, 402, 403, 408, 409, 429, 500, 502, 503, 504])(
    "does not retry HTTP %s, including a proxy-exhausted rate limit",
    async (status) => {
      const f = await fixture(() => rejected(status, "0"));
      await exhaust(f.session, f.requests);
      expect(f.requests).toHaveLength(1);
      expect(f.events).not.toContain("auto_retry_start");
      expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
    },
  );

  it("does not retry a statusless transport failure after dispatch", async () => {
    const f = await fixture(() => {
      throw new TypeError("fixture post-dispatch connection loss");
    });
    await exhaust(f.session, f.requests);
    expect(f.requests).toHaveLength(1);
    expect(f.events).not.toContain("auto_retry_start");
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
  });

  it("does not replay a model stream after output has started", async () => {
    const f = await fixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
                ),
              );
            },
            pull(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await exhaust(f.session, f.requests);
    expect(f.requests).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({
      stopReason: "error",
      content: [expect.objectContaining({ type: "text", text: "partial" })],
    });
  });

  it("does not reset the proxy budget through a summary retry", async () => {
    const f = await fixture((attempt) => (attempt === 1 ? answer() : rejected(429, "0")));
    await f.session.prompt("Complete this task once.");
    const summary = f.session.compact();
    const rejection = expect(summary).rejects.toThrow();
    await until(() => f.requests.length === 2);
    await vi.runAllTimersAsync();
    await rejection;
    expect(f.requests).toHaveLength(2);
    expect(f.events).not.toContain("summarization_retry_scheduled");
  });

  it("keeps successful native compaction enabled without request retries", async () => {
    const f = await fixture(() => answer());
    await f.session.prompt("Complete this task once.");
    expect((await f.session.compact()).summary).toContain("Completed.");
    expect(f.requests).toHaveLength(2);
    expect(f.events).not.toContain("summarization_retry_scheduled");
  });

  it("keeps one changed-context overflow recovery separate from identical-call retries", async () => {
    let recovered = false;
    const overflow = () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"partial","tool_calls":[{"index":0,"id":"never-run","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"never-read\\"}"}}]},"finish_reason":null}]}\n\n' +
          'data: {"error":{"code":"context_length_exceeded","message":"context_length_exceeded"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    const f = await fixture((attempt) => (attempt === 2 || recovered ? overflow() : answer()));
    f.session.subscribe((event) => {
      if (event.type === "compaction_end") recovered = true;
    });
    await f.session.prompt("Prepare the task.");
    const work = f.session.prompt("Continue the task.");
    await until(() => f.requests.length >= 2);
    await vi.runAllTimersAsync();
    await work;
    expect(f.events.filter((event) => event === "compaction_start")).toHaveLength(1);
    expect(f.events).not.toContain("auto_retry_start");
    expect(f.events).not.toContain("summarization_retry_scheduled");
    expect(f.events).not.toContain("tool_execution_start");
    expect(f.bodies.at(-1)?.messages).not.toEqual(f.bodies[1]?.messages);
    expect(f.requests.length).toBeLessThanOrEqual(5);
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
  });
});
