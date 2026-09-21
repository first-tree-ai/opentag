import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveRuntimeSnapshot, RunnerCloudTurnWorkerRequest } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntimeBinding,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { type CloudTurnPiFactory, runCloudTurnWorker } from "../runner/cloud-turn-worker.js";
import { createWorkspaceArchive, restoreWorkspaceArchive } from "../runner/workspace-archive.js";
import { RUNTIME_PROXY_PROVIDER_CA_KEY, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspaceFiles(directory: string): Promise<Buffer[]> {
  const files: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await workspaceFiles(path)));
    else if (entry.isFile()) files.push(await readFile(path));
  }
  return files;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cloud-context-continuity-"));
  roots.push(root);
  const requests: (CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest)[] = [];
  const opened: { home: string; token: string; historyDirectory: string }[] = [];
  const createPiFactory = (input: {
    environment: Record<string, string>;
    sessionDirectory: string;
  }): CloudTurnPiFactory => {
    const open = async (request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest) => {
      requests.push(request);
      const home = input.environment.PI_CODING_AGENT_DIR;
      if (!home) throw new Error("Missing temporary Pi home");
      const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      opened.push({ home, token: auth.opentag.key, historyDirectory: input.sessionDirectory });
      const binding: AgentRuntimeBinding =
        "binding" in request
          ? request.binding
          : { providerId: "pi", schemaVersion: 1, payload: { sessionId: randomUUID() } };
      await request.eventSink({ type: "binding_changed", binding });
      return {
        close: async () => undefined,
        prompt: async (prompt: { runId: string }) => ({
          runId: prompt.runId,
          status: "completed" as const,
          output: [{ type: "text" as const, text: "done" }],
        }),
      };
    };
    return { create: open, resume: open };
  };
  const turn = async (workspace: string, sessionId: string, snapshot: EffectiveRuntimeSnapshot, token: string) => {
    const executionDir = join(root, "mount", randomUUID());
    await mkdir(executionDir, { recursive: true });
    await writeFile(join(executionDir, "ca.pem"), "-----BEGIN CERTIFICATE-----fixture-----END CERTIFICATE-----\n");
    await writeFile(
      join(executionDir, "environment.json"),
      JSON.stringify({
        executionId: randomUUID(),
        environment: {
          [RUNTIME_PROXY_PROVIDER_URL_KEY]: "http://127.0.0.1:18080",
          [RUNTIME_PROXY_PROVIDER_CA_KEY]: join(executionDir, "ca.pem"),
        },
      }),
    );
    const request: RunnerCloudTurnWorkerRequest = {
      kind: "turn",
      executionDir,
      delivery: cloudDeliveryFixture({ sessionId, agentId: snapshot.agentId, runtime: snapshot }),
      model: {
        token,
        model: snapshot.model ?? "fixture-model",
        baseUrl: "https://server.example.test/api/v1/cloud-model",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };
    const result = await runCloudTurnWorker(request, {
      workspace,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      createPiFactory,
    });
    expect(result.outcome).toBe("completed");
  };
  return { root, turn, opened, requests };
}

describe("Cloud public configuration and private continuity", () => {
  it("restores history and work through a real archive, then applies fresh instructions and credentials", async () => {
    const { root, turn, opened, requests } = await fixture();
    const workspace = join(root, "workspace");
    const sessionId = randomUUID();
    const original = cloudDeliveryFixture().runtime;
    await turn(workspace, sessionId, original, "fixture-first-turn-token");
    await writeFile(join(workspace, "unfinished.txt"), "private unfinished work");
    const history = join(workspace, ".opentag/pi-session/sessions", "fixture.jsonl");
    await writeFile(history, '{"role":"user","content":"keep this history"}\n');
    const archive = join(root, "state.tar.gz");
    const info = await createWorkspaceArchive(workspace, archive);
    await rm(workspace, { recursive: true });
    await restoreWorkspaceArchive(archive, workspace, info);
    // Inspect the actual restored bytes, not only the binding metadata: platform-created
    // credentials must not have entered the archive through any auxiliary directory.
    for (const bytes of await workspaceFiles(workspace)) {
      expect(bytes.includes(Buffer.from("fixture-first-turn-token"))).toBe(false);
    }
    const updated: EffectiveRuntimeSnapshot = {
      ...original,
      model: "fixture-new-model",
      instructions: { platform: "OpenTag Agent slug: renamed-agent", agent: "New shared instruction" },
      revision: {
        agent: { id: randomUUID(), sequence: 2 },
        session: { id: randomUUID(), sequence: 2 },
      },
    };
    await turn(workspace, sessionId, updated, "fixture-second-turn-token");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toHaveProperty("binding");
    expect(requests[1]?.configuration?.model).toBe("opentag/fixture-new-model");
    expect(requests[1]?.systemPrompt).toContain("renamed-agent");
    expect(requests[1]?.systemPrompt).toContain("New shared instruction");
    expect(requests[1]?.systemPrompt).not.toContain("\nAgent.\n");
    expect(await readFile(history, "utf8")).toContain("keep this history");
    expect(await readFile(join(workspace, "unfinished.txt"), "utf8")).toBe("private unfinished work");
    expect(opened.map((value) => value.token)).toEqual(["fixture-first-turn-token", "fixture-second-turn-token"]);
    expect(opened[0]?.home).not.toBe(opened[1]?.home);
    for (const { home } of opened)
      await expect(readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(workspace, ".opentag/pi-session/pi-binding.json"), "utf8")).not.toContain("token");
  });

  it("shares current Agent instructions across Sessions while keeping their Pi bindings and work private", async () => {
    const { root, turn, requests } = await fixture();
    const snapshot = cloudDeliveryFixture().runtime;
    const first = join(root, "a");
    const second = join(root, "b");
    await turn(first, randomUUID(), snapshot, "fixture-a-turn-token");
    await writeFile(join(first, "only-a.txt"), "private to A");
    await turn(second, randomUUID(), snapshot, "fixture-b-turn-token");
    expect(requests.every((request) => !("binding" in request))).toBe(true);
    expect(requests[0]?.systemPrompt).toBe(requests[1]?.systemPrompt);
    const readBinding = (workspace: string) => readFile(join(workspace, ".opentag/pi-session/pi-binding.json"), "utf8");
    expect(await readBinding(first)).not.toBe(await readBinding(second));
    await expect(readFile(join(second, "only-a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
