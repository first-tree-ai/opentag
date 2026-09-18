import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES, RUNNER_WORKSPACE_PATH, type RunnerWorkspaceObject } from "@opentag/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRunnerWorkspaceRoutes } from "../api/runner-workspace.js";
import { type RunnerWorkspaceContext, RunnerWorkspaceService } from "../services/sandboxes/runner-workspace-service.js";
import type { WorkspaceObjectStore } from "../services/sandboxes/workspace-object-store.js";

function checksums(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("base64"),
  };
}

function fixture() {
  let object: RunnerWorkspaceObject = {
    generation: "1",
    metageneration: "1",
    ownerGeneration: 1,
    sealed: false,
    saved: true,
    ...checksums(Buffer.from("previous")),
  };
  const store: WorkspaceObjectStore = {
    head: async () => ({ ...object }),
    claim: async () => ({ ...object }),
    read: async () => {
      throw new Error("unused read");
    },
    write: async (_scope, previous, input) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      expect(checksums(bytes)).toEqual({ bytes: input.bytes, sha256: input.sha256, md5: input.md5 });
      object = {
        ...previous,
        ...checksums(bytes),
        generation: String(Number(previous.generation) + 1),
        saved: true,
        sealed: input.sealed,
      };
      return object;
    },
  };
  const scope = { sandboxId: "sandbox", sessionId: "session", environmentGeneration: 1, resourceName: "resource" };
  const context = {
    scope,
    row: {
      id: scope.sandboxId,
      sessionId: scope.sessionId,
      environmentGeneration: 1,
      currentResourceName: scope.resourceName,
      storageUri: "gs://fixture/workspace",
      lifecycle: "releasing",
    },
  } as RunnerWorkspaceContext;
  // Only identity lookup is stubbed: production route, streaming parser, upload lock, and store
  // input handling all execute. Allocation authentication has separate service/WS regressions.
  const service = new RunnerWorkspaceService({} as never, {
    store,
    tokens: {} as never,
    hub: {} as never,
    runnerService: {} as never,
  });
  vi.spyOn(service, "authenticate").mockResolvedValue(context);
  const app = Fastify({ logger: false });
  registerRunnerWorkspaceRoutes(app, service, { transferTimeoutMs: 100 });
  const headers = (bytes: Buffer, sealed = false) => ({
    "content-type": "application/octet-stream",
    "content-length": String(bytes.length),
    "x-opentag-storage-generation": object.generation,
    "x-opentag-storage-metageneration": object.metageneration,
    "x-opentag-workspace-sha256": checksums(bytes).sha256,
    "content-md5": checksums(bytes).md5,
    "x-opentag-workspace-sealed": String(sealed),
  });
  return { app, headers, object: () => object };
}

describe("Runner workspace streaming HTTP", () => {
  it("allows the active Turn checkpoint during release, then seals and rejects a stale write", async () => {
    const { app, headers, object } = fixture();
    try {
      const body = Buffer.from("last turn before release");
      const saved = await app.inject({
        method: "PUT",
        url: `${RUNNER_WORKSPACE_PATH}/archive`,
        headers: headers(body),
        payload: body,
      });
      expect(saved.statusCode).toBe(200);
      expect(object().sealed).toBe(false);
      const stale = headers(body);
      const sealed = await app.inject({
        method: "PUT",
        url: `${RUNNER_WORKSPACE_PATH}/archive`,
        headers: headers(body, true),
        payload: body,
      });
      expect(sealed.statusCode).toBe(200);
      expect(object().sealed).toBe(true);
      const rejected = await app.inject({
        method: "PUT",
        url: `${RUNNER_WORKSPACE_PATH}/archive`,
        headers: stale,
        payload: body,
      });
      expect(rejected.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("closes a stalled real HTTP upload and releases the per-Sandbox upload lock for a retry", async () => {
    const { app, headers, object } = fixture();
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const body = Buffer.from("unfinished upload");
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(`${origin}${RUNNER_WORKSPACE_PATH}/archive`, {
          method: "PUT",
          headers: headers(body),
        });
        request.on("error", () => resolve());
        request.on("response", (response) => {
          response.resume();
          reject(new Error(`Unexpected response ${response.statusCode}`));
        });
        request.flushHeaders();
        request.write(body.subarray(0, 1));
      });
      expect(object().generation).toBe("1");
      const retry = await fetch(`${origin}${RUNNER_WORKSPACE_PATH}/archive`, {
        method: "PUT",
        headers: headers(body),
        body,
      });
      expect(retry.status).toBe(200);
      await retry.arrayBuffer();
      expect(object().generation).toBe("2");
    } finally {
      await app.close();
    }
  });

  it("rejects oversized declared uploads before consuming the body", async () => {
    const { app, headers, object } = fixture();
    try {
      const rejected = await app.inject({
        method: "PUT",
        url: `${RUNNER_WORKSPACE_PATH}/archive`,
        headers: { ...headers(Buffer.from("x")), "content-length": String(RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES + 1) },
        payload: "x",
      });
      expect(rejected.statusCode).toBe(400);
      expect(object().generation).toBe("1");
    } finally {
      await app.close();
    }
  });
});
