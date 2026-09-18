import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerWorkspaceObject } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CloudWorkspace } from "../runner/cloud-workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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
  const requests: { method: string; url: string; token: string | null }[] = [];
  const upload = async (headers: Headers, init: RequestInit): Promise<Response> => {
    if (failure === "before") return new Response(null, { status: 503 });
    const chunks: Uint8Array[] = [];
    for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const uploaded = Buffer.concat(chunks);
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
    object = {
      ...object,
      ...digest(bytes),
      generation: String(++sequence),
      metageneration: "1",
      saved: true,
      sealed: headers.get("x-opentag-workspace-sealed") === "true",
    };
    if (failure === "after") throw new Error("connection lost after commit");
    return Response.json(object);
  };
  const download = (url: URL) => {
    if (url.searchParams.get("generation") !== object.generation) return new Response(null, { status: 412 });
    const body = failure === "corrupt-read" ? Buffer.from("corrupted") : bytes;
    return new Response(new Uint8Array(body));
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization");
    const generation = Number(token?.replace("Bearer fixture-", ""));
    requests.push({ method: init?.method ?? "GET", url: url.toString(), token });
    if (!Number.isSafeInteger(generation) || generation < object.ownerGeneration)
      return new Response(null, { status: 403 });
    if (url.pathname.endsWith("/claim")) {
      if (generation > object.ownerGeneration) {
        object = {
          ...object,
          ownerGeneration: generation,
          metageneration: String(Number(object.metageneration) + 1),
          sealed: false,
        };
      }
      return Response.json(object);
    }
    if (init?.method !== "PUT") return download(url);
    return upload(headers, init);
  };
  return {
    fetchImpl,
    requests,
    object: () => ({ ...object }),
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

async function client(fixture: ReturnType<typeof storageFixture>, generation = 1) {
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
    }),
  };
}

describe("Cloud workspace transfer", () => {
  it("classifies unsaveable hard links as terminal without overwriting the saved object", async () => {
    const store = storageFixture();
    const runner = await client(store);
    await runner.client.initialize();
    const previous = store.object();
    await writeFile(join(runner.workspace, "work"), "unsaved work");
    await link(join(runner.workspace, "work"), join(runner.workspace, "hard-link"));
    await expect(runner.client.save()).rejects.toMatchObject({ code: "save_failed", retryable: false });
    expect(runner.client.terminalFailure).toBe(true);
    expect(runner.client.pendingSave).toBe(true);
    const requests = store.requests.length;
    await expect(runner.client.save(true)).rejects.toMatchObject({ retryable: false });
    expect(store.requests).toHaveLength(requests);
    expect(store.object()).toEqual(previous);
    expect(await readFile(join(runner.workspace, "work"), "utf8")).toBe("unsaved work");
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
    expect(store.object().generation).not.toBe(saved.generation);
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
