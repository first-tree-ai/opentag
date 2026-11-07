import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as retryDelay } from "node:timers/promises";
import type { RunnerWorkspaceObject } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspace, type CloudWorkspaceOptions } from "../runner/cloud-workspace.js";
import * as workspaceArchive from "../runner/workspace-archive.js";
import { WORKSPACE_MAX_BYTES } from "../runner/workspace-archive.js";

const roots: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("base64"),
  };
}

/** A byte-stream HTTP protocol fixture; real GCS behavior has separate adapter/live acceptance. */
function storageFixture() {
  let bytes = Buffer.alloc(0);
  let writeId: string | null = null;
  let sequence = 9_007_199_254_740_993n;
  let object: RunnerWorkspaceObject = {
    generation: String(sequence),
    metageneration: "1",
    ownerGeneration: 1,
    saved: false,
    sealed: false,
    ...digest(bytes),
  };
  let failure: "none" | "before" | "after" | "corrupt-read" = "none";
  let failures: (number | "network" | "after")[] = [];
  const uploads: { bytes: Buffer; headers: Headers }[] = [];
  const requests: { method: string; url: string; token: string | null }[] = [];
  const upload = async (headers: Headers, init: RequestInit): Promise<Response> => {
    if (failure === "before") return new Response(null, { status: 503 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const uploaded = Buffer.concat(chunks);
    uploads.push({ bytes: uploaded, headers });
    const next = failures.shift();
    if (next === "network") throw new TypeError("fetch failed");
    if (typeof next === "number") return new Response(null, { status: next });
    if (
      headers.get("x-opentag-storage-generation") !== object.generation ||
      headers.get("x-opentag-storage-metageneration") !== object.metageneration ||
      object.sealed
    )
      return new Response(null, { status: 412 });
    expect(headers.get("content-length")).toBe(String(uploaded.length));
    expect(headers.get("content-md5")).toBe(digest(uploaded).md5);
    expect(headers.get("x-opentag-workspace-sha256")).toBe(digest(uploaded).sha256);
    bytes = uploaded;
    writeId = headers.get("x-opentag-workspace-write-id");
    object = {
      ...object,
      ...digest(bytes),
      generation: String(++sequence),
      metageneration: "1",
      saved: true,
      sealed: headers.get("x-opentag-workspace-sealed") === "true",
    };
    if (failure === "after" || next === "after") throw new Error("connection lost after commit");
    return Response.json(object);
  };
  const download = (url: URL) => {
    if (url.searchParams.get("generation") !== object.generation) return new Response(null, { status: 412 });
    const body = failure === "corrupt-read" ? Buffer.from("corrupted") : bytes;
    return new Response(new Uint8Array(body));
  };
  const claim = (generation: number, body: unknown) => {
    const options = JSON.parse(String(body));
    if (options.upload) {
      const unchanged =
        options.upload.generation === object.generation && options.upload.metageneration === object.metageneration;
      const committed = options.upload.id === writeId && object.metageneration === "1";
      return new Response(JSON.stringify(object), {
        status: generation === object.ownerGeneration && (unchanged || committed) ? 200 : 409,
      });
    }
    if (generation > object.ownerGeneration || (options.fence && !object.sealed)) {
      object = {
        ...object,
        ownerGeneration: generation,
        metageneration: String(Number(object.metageneration) + 1),
        sealed: false,
      };
    }
    return Response.json(object);
  };
  const seal = (body: unknown) => {
    const pins = JSON.parse(String(body));
    if (failure === "before") return new Response(null, { status: 503 });
    if (pins.generation !== object.generation || pins.metageneration !== object.metageneration || object.sealed) {
      return new Response(null, { status: 409 });
    }
    object = { ...object, sealed: true, metageneration: String(BigInt(object.metageneration) + 1n) };
    if (failure === "after") throw new Error("connection lost after seal commit");
    return Response.json(object);
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization");
    const generation = Number(token?.replace("Bearer fixture-", ""));
    requests.push({ method: init?.method ?? "GET", url: url.toString(), token });
    if (!Number.isSafeInteger(generation) || generation < object.ownerGeneration)
      return new Response(null, { status: 403 });
    if (url.pathname.endsWith("/claim")) return claim(generation, init?.body);
    if (url.pathname.endsWith("/seal")) return seal(init?.body);
    if (init?.method !== "PUT") return download(url);
    return upload(headers, init);
  };
  return {
    fetchImpl,
    requests,
    uploads,
    failUploads: (...values: typeof failures) => {
      failures = values;
    },
    object: () => ({ ...object }),
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

async function client(
  fixture: ReturnType<typeof storageFixture>,
  generation = 1,
  options: Partial<CloudWorkspaceOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ot-e5-client-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "private");
  return {
    root,
    workspace,
    stateDirectory,
    client: new CloudWorkspace({
      workspace,
      stateDirectory,
      backendUrl: "wss://server.example.com/api/v1/sandbox-runners/ws",
      token: () => `fixture-${generation}`,
      environmentGeneration: () => generation,
      fetchImpl: fixture.fetchImpl,
      ...options,
    }),
  };
}

function invalidUploadResponse(kind: string, object: RunnerWorkspaceObject): Response {
  if (kind === "json") return new Response("not JSON");
  if (kind === "missing-body") return new Response(null);
  if (kind === "oversized-json") return Response.json({ value: "x".repeat(17 * 1024) });
  return Response.json(kind === "schema" ? {} : object);
}

describe("Cloud workspace transfer", () => {
  it("restores and seals unchanged bytes without packing or uploading them again", async () => {
    const store = storageFixture();
    const pack = vi.spyOn(workspaceArchive, "createWorkspaceArchive");
    const fingerprint = vi.spyOn(workspaceArchive, "fingerprintWorkspace");
    const first = await client(store);
    await first.client.initialize();
    expect(pack).toHaveBeenCalledTimes(1);
    await writeFile(join(first.workspace, "unpublished-work"), "keep unpublished bytes");
    await first.client.save();
    const saved = store.object();
    expect(pack).toHaveBeenCalledTimes(2);
    const second = await client(store);
    await second.client.initialize();
    expect(store.object()).toEqual({ ...saved, metageneration: "2" });
    expect(pack).toHaveBeenCalledTimes(2);
    expect(store.uploads).toHaveLength(2);
    await second.client.save(true);
    expect(store.object()).toEqual({ ...saved, metageneration: "3", sealed: true });
    expect(pack).toHaveBeenCalledTimes(2);
    expect(fingerprint).toHaveBeenCalledTimes(4);
    const third = await client(store, 2);
    await third.client.initialize();
    expect(await readFile(join(third.workspace, "unpublished-work"), "utf8")).toBe("keep unpublished bytes");
    expect(store.object().generation).toBe(saved.generation);
  });

  it("lightly seals a clean checkpoint while preserving its exact durable archive", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    await writeFile(join(runner.workspace, "work"), "checkpoint");
    await runner.client.save();
    const saved = store.object();
    await runner.client.save(true);
    expect(store.object()).toEqual({ ...saved, sealed: true, metageneration: "2" });
    expect(store.uploads).toHaveLength(2);
  });

  it("saves real non-Turn changes even when file length and mtime are unchanged", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const file = join(runner.workspace, "background-write");
    const stamp = new Date(1_700_000_000_000);
    await writeFile(file, "before");
    await utimes(file, stamp, stamp);
    await runner.client.save();
    const saved = store.object();
    await writeFile(file, "after!");
    await utimes(file, stamp, stamp);
    await runner.client.save(true);
    expect(store.object().generation).not.toBe(saved.generation);
    expect(store.uploads).toHaveLength(3);
    const restored = await client(store, 2);
    await restored.client.initialize();
    expect(await readFile(join(restored.workspace, "background-write"), "utf8")).toBe("after!");
  });

  it("reconciles a lost metadata seal response without another mutation", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const saved = store.object();
    store.fail("after");
    await runner.client.save(true);
    expect(runner.client.sealed).toBe(true);
    expect(runner.client.pendingSave).toBe(false);
    expect(store.object()).toEqual({ ...saved, sealed: true, metageneration: "2" });
    expect(store.requests.filter((r) => r.url.endsWith("/seal"))).toHaveLength(1);
    expect(store.uploads).toHaveLength(1);
  });

  it("retains local state after a failed metadata seal and retries with the original pins", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const saved = store.object();
    store.fail("before");
    await expect(runner.client.save(true)).rejects.toMatchObject({ code: "save_failed" });
    expect(runner.client.pendingSave).toBe(true);
    expect(runner.client.sealed).toBe(false);
    expect(store.object()).toEqual(saved);
    store.fail("none");
    await runner.client.save(true);
    expect(store.object()).toEqual({ ...saved, sealed: true, metageneration: "2" });
    expect(store.uploads).toHaveLength(1);
  });

  it("never seals stale clean bytes after a same-allocation claim or newer upload", async () => {
    const store = storageFixture();
    const old = await client(store);
    await old.client.initialize();
    const current = await client(store);
    await current.client.initialize();
    const claimed = store.object();
    await expect(old.client.save(true)).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(claimed);
    await writeFile(join(current.workspace, "new"), "newer process bytes");
    await current.client.save();
    const saved = store.object();
    await expect(old.client.save(true)).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(saved);
    const restored = await client(store, 2);
    await restored.client.initialize();
    expect(await readFile(join(restored.workspace, "new"), "utf8")).toBe("newer process bytes");
  });

  it("cannot adopt the new process's metadata fence when an earlier upload response is lost", async () => {
    const store = storageFixture();
    const replacement = await client(store);
    let loseResponse = false;
    const old = await client(store, 1, {
      fetchImpl: async (input, init) => {
        const response = await store.fetchImpl(input, init);
        if (loseResponse && init?.method === "PUT") {
          loseResponse = false;
          await replacement.client.initialize();
          throw new Error("lost committed upload response");
        }
        return response;
      },
    });
    await old.client.initialize();
    await writeFile(join(old.workspace, "progress"), "committed by old process");
    loseResponse = true;
    await expect(old.client.save()).rejects.toMatchObject({ code: "save_failed", retryable: false });
    const claimed = store.object();
    expect(claimed.metageneration).toBe("2");
    expect(await readFile(join(replacement.workspace, "progress"), "utf8")).toBe("committed by old process");
    await expect(old.client.save()).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(claimed);
    await writeFile(join(replacement.workspace, "progress"), "new process continues");
    await replacement.client.save();
    const next = await client(store, 2);
    await next.client.initialize();
    expect(await readFile(join(next.workspace, "progress"), "utf8")).toBe("new process continues");
  });

  it("rejects readback of a different upload even when its archive bytes are identical", async () => {
    const store = storageFixture();
    const replacement = await client(store);
    let loseResponse = false;
    const old = await client(store, 1, {
      fetchImpl: async (input, init) => {
        const response = await store.fetchImpl(input, init);
        if (loseResponse && init?.method === "PUT") {
          loseResponse = false;
          await replacement.client.initialize();
          await replacement.client.save();
          throw new Error("lost upload response while a different process saved identical bytes");
        }
        return response;
      },
    });
    await old.client.initialize();
    const before = store.object();
    loseResponse = true;
    await expect(old.client.save()).rejects.toMatchObject({ code: "save_failed", retryable: false });
    const current = store.object();
    expect(current.sha256).toBe(before.sha256);
    expect(current.metageneration).toBe("1");
    expect(current.generation).not.toBe(before.generation);
    await expect(old.client.save()).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(current);
  });

  it("restores a completed upload after its response times out without rebasing the old process", async () => {
    const store = storageFixture();
    let loseResponse = false;
    const old = await client(store, 1, {
      timeoutMs: 20,
      fetchImpl: async (input, init) => {
        const response = await store.fetchImpl(input, init);
        if (loseResponse && init?.method === "PUT") {
          loseResponse = false;
          return new Promise<never>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return response;
      },
    });
    await old.client.initialize();
    await writeFile(join(old.workspace, "progress"), "durable despite timed out response");
    loseResponse = true;
    await expect(old.client.save()).rejects.toMatchObject({ code: "save_failed" });
    expect(old.client.pendingSave).toBe(true);
    const committed = store.object();
    const replacement = await client(store);
    await replacement.client.initialize();
    expect(store.object()).toEqual({ ...committed, metageneration: "2" });
    expect(await readFile(join(replacement.workspace, "progress"), "utf8")).toBe("durable despite timed out response");
    await expect(old.client.save()).rejects.toThrow("save_failed");
    expect(await readFile(join(old.workspace, "progress"), "utf8")).toBe("durable despite timed out response");
  });

  it("bounds a stalled metadata seal and keeps its durable baseline retryable", async () => {
    const store = storageFixture();
    let stalled = false;
    let seals = 0;
    const runner = await client(store, 1, {
      timeoutMs: 20,
      fetchImpl: async (input, init) => {
        if (stalled && String(input).endsWith("/seal")) {
          seals += 1;
          return new Promise<never>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return store.fetchImpl(input, init);
      },
    });
    await runner.client.initialize();
    const saved = store.object();
    stalled = true;
    await expect(runner.client.save(true)).rejects.toThrow();
    expect(seals).toBe(1);
    expect(runner.client.pendingSave).toBe(true);
    expect(runner.client.sealed).toBe(false);
    expect(store.object()).toEqual(saved);
    stalled = false;
    await runner.client.save(true);
    expect(runner.client.sealed).toBe(true);
    const replacement = await client(store, 2);
    await replacement.client.initialize();
    expect(await readdir(replacement.workspace)).toEqual([]);
  });

  it("retains confirmed upload pins when local archive cleanup fails, then saves and restores again", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    await writeFile(join(runner.workspace, "progress"), "confirmed durable work");
    const originalRm = fsPromises.rm;
    let failCleanup = true;
    vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (failCleanup && String(path).startsWith(join(runner.stateDirectory, "workspace-"))) {
        failCleanup = false;
        throw new Error("local cleanup failed after upload");
      }
      return originalRm(path, options);
    });
    await expect(runner.client.save()).rejects.toMatchObject({ code: "save_failed" });
    expect(runner.client.pendingSave).toBe(true);
    const committed = store.object();
    await runner.client.initialize();
    expect(runner.client.pendingSave).toBe(false);
    expect(store.object().generation).not.toBe(committed.generation);
    const replacement = await client(store, 2);
    await replacement.client.initialize();
    expect(await readFile(join(replacement.workspace, "progress"), "utf8")).toBe("confirmed durable work");
  });

  it("retries identical archive bytes and original CAS preconditions with bounded backoff", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const baseline = store.object();
    await writeFile(join(runner.workspace, "progress"), "keep this exact archive");
    store.uploads.length = 0;
    vi.mocked(retryDelay).mockClear();
    store.failUploads("network", 503);
    await runner.client.save();
    expect(store.uploads).toHaveLength(3);
    const [first] = store.uploads;
    for (const upload of store.uploads) {
      expect(upload.bytes).toEqual(first?.bytes);
      expect(upload.headers.get("x-opentag-storage-generation")).toBe(baseline.generation);
      expect(upload.headers.get("x-opentag-storage-metageneration")).toBe(baseline.metageneration);
      expect(upload.headers.get("x-opentag-workspace-write-id")).toBe(
        first?.headers.get("x-opentag-workspace-write-id"),
      );
    }
    expect(vi.mocked(retryDelay).mock.calls.map(([delay]) => delay)).toEqual([1000, 2000]);
    expect(runner.client.pendingSave).toBe(false);
  });

  it.each([408, 429, 500, 502, 504])(
    "retries a transient HTTP %s only after readback confirms the base",
    async (status) => {
      const store = storageFixture();
      const runner = await client(store);
      await runner.client.initialize();
      const start = store.requests.length;
      store.failUploads(status);
      await runner.client.save();
      expect(store.requests.slice(start).map((request) => request.method)).toEqual(["PUT", "POST", "PUT"]);
    },
  );

  it.each([400, 401, 403, 409, 412, 413, 422])("does not retry or claim after HTTP %s", async (status) => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const start = store.requests.length;
    const baseline = store.object();
    store.failUploads(status);
    await expect(runner.client.save()).rejects.toMatchObject({ retryable: false, httpStatus: status });
    expect(store.requests.slice(start).map((request) => request.method)).toEqual(["PUT"]);
    expect(store.object()).toEqual(baseline);
    expect(runner.client.pendingSave).toBe(true);
  });

  it("stops after three failed uploads while retaining local progress and the previous archive", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const baseline = store.object();
    await writeFile(join(runner.workspace, "progress"), "unsaved progress");
    const start = store.requests.length;
    store.failUploads(503, 503, 503);
    await expect(runner.client.save()).rejects.toMatchObject({ retryable: true, httpStatus: 503 });
    expect(store.requests.slice(start).map((request) => request.method)).toEqual([
      "PUT",
      "POST",
      "PUT",
      "POST",
      "PUT",
      "POST",
    ]);
    expect(store.object()).toEqual(baseline);
    expect(runner.client.pendingSave).toBe(true);
    expect(await readFile(join(runner.workspace, "progress"), "utf8")).toBe("unsaved progress");
    await runner.client.initialize();
    expect(runner.client.pendingSave).toBe(false);
  });

  it("accepts a committed upload with a lost response without uploading it again", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    await writeFile(join(runner.workspace, "progress"), "changed bytes require an upload");
    const start = store.requests.length;
    store.failUploads("after");
    await runner.client.save(true);
    expect(store.requests.slice(start).map((request) => request.method)).toEqual(["PUT", "POST"]);
    expect(runner.client.sealed).toBe(true);
    expect(retryDelay).not.toHaveBeenCalled();
  });

  it("never adopts an unrelated write discovered during transient-error readback", async () => {
    const store = storageFixture();
    const newer = await client(store);
    let intercept = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (intercept && init?.method === "PUT") {
        await newer.client.initialize();
        await writeFile(join(newer.workspace, "progress"), "newer process");
        await newer.client.save();
        return new Response(null, { status: 503 });
      }
      return store.fetchImpl(input, init);
    };
    const old = await client(store, 1, { fetchImpl });
    await old.client.initialize();
    await writeFile(join(old.workspace, "progress"), "old process");
    intercept = true;
    await expect(old.client.save()).rejects.toMatchObject({ retryable: false });
    expect(retryDelay).not.toHaveBeenCalled();
    const restored = await client(store, 2);
    await restored.client.initialize();
    expect(await readFile(join(restored.workspace, "progress"), "utf8")).toBe("newer process");
    expect(await readFile(join(old.workspace, "progress"), "utf8")).toBe("old process");
  });

  it("bounds upload and verification with one deadline", async () => {
    const store = storageFixture();
    let hang = false;
    const runner = await client(store, 1, {
      timeoutMs: 30,
      fetchImpl: async (input, init) => {
        if (hang)
          return new Promise<never>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        return store.fetchImpl(input, init);
      },
    });
    await runner.client.initialize();
    hang = true;
    await expect(runner.client.save()).rejects.toMatchObject({ code: "save_failed" });
    expect(retryDelay).not.toHaveBeenCalled();
    expect(runner.client.pendingSave).toBe(true);
  });

  it("does not retry when readback itself is unavailable", async () => {
    const store = storageFixture();
    let fail = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) =>
      fail ? new Response(null, { status: 503 }) : store.fetchImpl(input, init),
    );
    const runner = await client(store, 1, { fetchImpl });
    await runner.client.initialize();
    const baseline = store.object();
    fetchImpl.mockClear();
    fail = true;
    await expect(runner.client.save()).rejects.toMatchObject({ httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(retryDelay).not.toHaveBeenCalled();
    expect(store.object()).toEqual(baseline);
  });

  it("refuses a changed allocation before sending old workspace bytes", async () => {
    const store = storageFixture();
    let generation = 1;
    const runner = await client(store, 1, { environmentGeneration: () => generation });
    await runner.client.initialize();
    const baseline = store.object();
    const count = store.requests.length;
    generation = 2;
    await expect(runner.client.save()).rejects.toMatchObject({ code: "scope_unavailable", retryable: false });
    expect(store.requests).toHaveLength(count);
    expect(store.object()).toEqual(baseline);
  });

  it.each(["json", "schema", "unchanged-object", "missing-body", "oversized-json"])(
    "verifies but does not retry an invalid upload response (%s)",
    async (kind) => {
      const store = storageFixture();
      let invalid = false;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        if (invalid && init?.method === "PUT") return invalidUploadResponse(kind, store.object());
        return store.fetchImpl(input, init);
      });
      const runner = await client(store, 1, { fetchImpl });
      await runner.client.initialize();
      fetchImpl.mockClear();
      invalid = true;
      await expect(runner.client.save()).rejects.toMatchObject({ retryable: false });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(retryDelay).not.toHaveBeenCalled();
    },
  );

  it("retries a broken response stream after checking the original base", async () => {
    const store = storageFixture();
    let broken = false;
    const runner = await client(store, 1, {
      fetchImpl: async (input, init) => {
        if (broken && init?.method === "PUT") {
          broken = false;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection lost"));
              },
            }),
          );
        }
        return store.fetchImpl(input, init);
      },
    });
    await runner.client.initialize();
    broken = true;
    await runner.client.save();
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(runner.client.pendingSave).toBe(false);
  });

  it("classifies unsaveable hard links as terminal without overwriting the saved object", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const previous = store.object();
    await writeFile(join(runner.workspace, "work"), "unsaved work");
    await link(join(runner.workspace, "work"), join(runner.workspace, "hard-link"));
    await expect(runner.client.save()).rejects.toMatchObject({
      code: "save_failed",
      retryable: false,
      archiveErrorCode: "unsafe-entry",
      message: "Cloud workspace save_failed (unsafe-entry)",
      cause: { code: "unsafe-entry" },
    });
    expect(runner.client.terminalFailure).toBe(true);
    expect(runner.client.pendingSave).toBe(true);
    const requests = store.requests.length;
    await expect(runner.client.save(true)).rejects.toMatchObject({
      retryable: false,
      archiveErrorCode: "unsafe-entry",
    });
    expect(store.requests).toHaveLength(requests);
    expect(store.object()).toEqual(previous);
    expect(await readFile(join(runner.workspace, "work"), "utf8")).toBe("unsaved work");
  });

  it("archives Context Tree caches without a write session, so an oversized cache hits the ceiling", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const baseline = store.object();
    const cache = join(runner.workspace, ".opentag/context-tree/home/.context-tree/repositories");
    await mkdir(cache, { recursive: true });
    const path = join(cache, "oversized.pack");
    const file = await open(path, "wx");
    try {
      await file.truncate(WORKSPACE_MAX_BYTES + 1);
    } finally {
      await file.close();
    }
    await expect(runner.client.save()).rejects.toMatchObject({
      retryable: false,
      archiveErrorCode: "workspace-too-large",
      message: "Cloud workspace save_failed (workspace-too-large)",
    });
    expect(store.object()).toEqual(baseline);
    expect(runner.client.pendingSave).toBe(true);
    expect(runner.client.terminalFailure).toBe(true);
  });

  it("rolls back unsaved pre-prompt dirt to the last saved baseline and clears terminalFailure", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    await writeFile(join(runner.workspace, "baseline.txt"), "committed baseline");
    await runner.client.save();
    await writeFile(join(runner.workspace, "dirty.txt"), "pre-prompt temp");
    await link(join(runner.workspace, "dirty.txt"), join(runner.workspace, "hard-link"));
    await expect(runner.client.save()).rejects.toMatchObject({
      retryable: false,
      archiveErrorCode: "unsafe-entry",
    });
    expect(runner.client.terminalFailure).toBe(true);
    expect(runner.client.pendingSave).toBe(true);

    await runner.client.rollback();
    expect(runner.client.terminalFailure).toBe(false);
    expect(runner.client.pendingSave).toBe(false);
    expect(await readdir(runner.workspace)).toEqual(["baseline.txt"]);
    expect(await readFile(join(runner.workspace, "baseline.txt"), "utf8")).toBe("committed baseline");
  });

  it("never wipes the workspace or overwrites the saved baseline when a pre-prompt rollback fails before recovery", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    await writeFile(join(runner.workspace, "baseline.txt"), "committed baseline");
    await utimes(join(runner.workspace, "baseline.txt"), new Date(0), new Date(0));
    await runner.client.save();
    const savedBaseline = store.object();

    await writeFile(join(runner.workspace, "dirty.txt"), "pre-prompt dirt");
    store.fail("before");
    await expect(runner.client.save()).rejects.toThrow("save_failed");
    expect(runner.client.pendingSave).toBe(true);

    store.fail("corrupt-read");
    await expect(runner.client.rollback()).rejects.toThrow("restore_failed");
    // The failed rollback staged in a sibling directory: local files are not wiped, and
    // pendingSave is cleared so recovery re-restores the baseline instead of uploading dirt/empty.
    expect(runner.client.initialized).toBe(false);
    expect(runner.client.pendingSave).toBe(false);
    expect((await readdir(runner.workspace)).sort()).toEqual(["baseline.txt", "dirty.txt"]);
    expect(store.object()).toEqual(savedBaseline);

    store.fail("none");
    await runner.client.initialize();
    expect(runner.client.initialized).toBe(true);
    expect(runner.client.pendingSave).toBe(false);
    expect(await readdir(runner.workspace)).toEqual(["baseline.txt"]);
    expect(await readFile(join(runner.workspace, "baseline.txt"), "utf8")).toBe("committed baseline");
    expect(store.object().generation).toBe(savedBaseline.generation);
    expect(BigInt(store.object().metageneration)).toBeGreaterThan(BigInt(savedBaseline.metageneration));

    const replacement = await client(store, 2);
    await replacement.client.initialize();
    expect(await readdir(replacement.workspace)).toEqual(["baseline.txt"]);
    expect(await readFile(join(replacement.workspace, "baseline.txt"), "utf8")).toBe("committed baseline");
  });

  it("recovers files and Pi binding/history into a replacement and excludes trusted parent state", async () => {
    const store = storageFixture();
    const first = await client(store);
    await first.client.initialize();
    await mkdir(join(first.workspace, ".opentag/pi-session"), { recursive: true });
    await mkdir(join(first.workspace, ".git"));
    await writeFile(join(first.workspace, ".git/HEAD"), "ref: refs/heads/work\n");
    await writeFile(join(first.workspace, ".opentag/pi-session/pi-binding.json"), '{"sessionId":"same-pi-session"}');
    await writeFile(join(first.workspace, ".opentag/pi-session/history.jsonl"), '{"text":"previous turn"}\n');
    await writeFile(join(first.stateDirectory, "private-material"), "must remain outside the archive");
    await first.client.save(true);
    const saved = store.object();
    expect(saved.sealed).toBe(true);
    await rm(first.root, { recursive: true, force: true });

    const second = await client(store, 2);
    await second.client.initialize();
    expect(await readFile(join(second.workspace, ".git/HEAD"), "utf8")).toContain("refs/heads/work");
    expect(await readFile(join(second.workspace, ".opentag/pi-session/pi-binding.json"), "utf8")).toContain(
      "same-pi-session",
    );
    expect(await readFile(join(second.workspace, ".opentag/pi-session/history.jsonl"), "utf8")).toContain(
      "previous turn",
    );
    expect(await readdir(second.workspace)).toEqual([".git", ".opentag"]);
    expect(store.object().generation).toBe(saved.generation);
    expect(store.object().metageneration).not.toBe(saved.metageneration);
    expect(store.object().ownerGeneration).toBe(2);
    expect(store.object().sealed).toBe(false);
    expect(
      store.requests.every((request) =>
        request.url.startsWith("https://server.example.com/api/v1/sandbox-runner/workspace/"),
      ),
    ).toBe(true);
  });

  it("retains dirty local state on a failed save and retries it without re-extracting", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const previous = store.object();
    await writeFile(join(runner.workspace, "progress"), "unsaved turn");
    store.fail("before");
    await expect(runner.client.save()).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(previous);
    expect(runner.client.pendingSave).toBe(true);
    expect(await readFile(join(runner.workspace, "progress"), "utf8")).toBe("unsaved turn");
    store.fail("none");
    await runner.client.initialize();
    expect(runner.client.pendingSave).toBe(false);
    const next = await client(store, 2);
    await next.client.initialize();
    expect(await readFile(join(next.workspace, "progress"), "utf8")).toBe("unsaved turn");
  });

  it("verifies a lost upload response but never accepts an unchanged object as a fresh commit", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    store.fail("after");
    await runner.client.save();
    expect(runner.client.pendingSave).toBe(false);
    store.fail("before");
    await expect(runner.client.save()).rejects.toThrow("save_failed");
    expect(runner.client.pendingSave).toBe(true);
  });

  it("refuses corrupt restoration and preserves an unattested existing workspace", async () => {
    const store = storageFixture();
    const first = await client(store);
    await first.client.initialize();
    store.fail("corrupt-read");
    const second = await client(store, 2);
    await expect(second.client.initialize()).rejects.toThrow("restore_failed");
    expect(await readdir(second.workspace)).toEqual([]);
    expect(second.client.initialized).toBe(false);
    store.fail("none");
    await writeFile(join(second.workspace, "local-copy"), "keep");
    await expect(second.client.initialize()).rejects.toThrow("restore_failed");
    expect(await readFile(join(second.workspace, "local-copy"), "utf8")).toBe("keep");
  });

  it("keeps a sealed allocation nonexecuting and refuses writes after sealing", async () => {
    const store = storageFixture();
    const first = await client(store);
    await first.client.initialize();
    await first.client.save(true);
    const fresh = await client(store);
    await fresh.client.initialize();
    expect(fresh.client.sealed).toBe(true);
    expect(fresh.client.initialized).toBe(false);
    await fresh.client.save(true);
    await expect(fresh.client.save()).rejects.toThrow("save_failed");
  });

  it("retries the initial readiness save without restoring over local progress", async () => {
    const store = storageFixture();
    const runner = await client(store);
    store.fail("before");
    await expect(runner.client.initialize()).rejects.toThrow("restore_failed");
    expect(runner.client.initialized).toBe(true);
    expect(runner.client.pendingSave).toBe(true);
    await writeFile(join(runner.workspace, "progress"), "preserve local bytes");
    store.fail("none");
    await runner.client.initialize();
    expect(runner.client.pendingSave).toBe(false);
    const replacement = await client(store, 2);
    await replacement.client.initialize();
    expect(await readFile(join(replacement.workspace, "progress"), "utf8")).toBe("preserve local bytes");
  });

  it("never rebases stale local bytes onto a newer process's saved object", async () => {
    const store = storageFixture();
    const old = await client(store);
    await old.client.initialize();
    await writeFile(join(old.workspace, "progress"), "stale process");
    const current = await client(store);
    await current.client.initialize();
    await writeFile(join(current.workspace, "progress"), "current process");
    await current.client.save();
    const saved = store.object();
    await expect(old.client.save()).rejects.toThrow("save_failed");
    await expect(old.client.initialize()).rejects.toThrow("save_failed");
    expect(store.object()).toEqual(saved);
    expect(await readFile(join(old.workspace, "progress"), "utf8")).toBe("stale process");
    const next = await client(store, 2);
    await next.client.initialize();
    expect(await readFile(join(next.workspace, "progress"), "utf8")).toBe("current process");
  });
});
