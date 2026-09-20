import { createHash } from "node:crypto";
import { RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  GcsWorkspaceObjectStore,
  type WorkspaceObject,
  type WorkspaceObjectScope,
  WorkspaceObjectStoreError,
  type WorkspaceObjectWriteInput,
} from "../services/sandboxes/workspace-object-store.js";

const TOKEN = "unit-gcs-access-token";
const BUCKET = "opentag-test-workspaces";
const SANDBOX = "2b63a21e-f6c7-4474-91ea-4dabf0566a24";
const SESSION = "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b";
const PREFIX = `workspaces/prod/${SANDBOX}`;
const STORAGE_URI = `gs://${BUCKET}/${PREFIX}`;
const OBJECT = `${PREFIX}/state.tar.gz`;
const META_URL = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}`;
const UPLOAD_URL_PREFIX = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart`;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_MD5 = "1B2M2Y8AsgTpgAmY7PhCfg==";

const SCOPE: WorkspaceObjectScope = {
  storageUri: STORAGE_URI,
  sandboxId: SANDBOX,
  sessionId: SESSION,
  environmentGeneration: 1,
};

function must<T>(value: T | undefined | null, label = "value"): T {
  if (value === undefined || value === null) throw new Error(`test: expected ${label}`);
  return value;
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function md5b64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

async function* chunksOf(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
  }
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function metadataMap(state: {
  owner: number;
  saved: boolean;
  sealed: boolean;
  sha256: string;
}): Record<string, string> {
  return {
    schema: "1",
    sandbox: SANDBOX,
    session: SESSION,
    owner: String(state.owner),
    saved: state.saved ? "true" : "false",
    sealed: state.sealed ? "true" : "false",
    sha256: state.sha256,
  };
}

interface StoredFakeObject {
  content: Uint8Array;
  generation: string;
  metageneration: string;
  metadata: Record<string, string>;
}

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | undefined;
  redirect: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  hasSignal: boolean;
  signal: AbortSignal | undefined;
  body: Uint8Array | undefined;
}

type Interceptor = (ctx: { call: RecordedCall; proceed: () => Promise<Response> }) => Promise<Response | undefined>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chunkedStream(bytes: Uint8Array, chunkSize = 5): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Byte-exact multipart/related parser mirroring the adapter framing (and thereby asserting it). */
function parseMultipart(
  body: Uint8Array,
  boundary: string,
): { metadataJson: Record<string, unknown>; content: Uint8Array } {
  const buf = Buffer.from(body);
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, "utf8");
  const separator = Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  if (!buf.subarray(0, head.length).equals(head)) throw new Error("test: multipart preamble mismatch");
  const sepIndex = buf.indexOf(separator, head.length);
  if (sepIndex < 0) throw new Error("test: multipart separator missing");
  if (!buf.subarray(buf.length - tail.length).equals(tail)) throw new Error("test: multipart epilogue mismatch");
  const metadataJson = JSON.parse(buf.subarray(head.length, sepIndex).toString("utf8")) as Record<string, unknown>;
  return { metadataJson, content: buf.subarray(sepIndex + separator.length, buf.length - tail.length) };
}

function multipartBoundary(call: RecordedCall): string {
  const contentType = must(call.contentType, "multipart content-type");
  return must(/^multipart\/related; boundary=(.+)$/.exec(contentType)?.[1], "multipart boundary");
}

function createFakeGcs() {
  let stored: StoredFakeObject | undefined;
  let generationCounter = 1000;
  const calls: RecordedCall[] = [];
  let interceptor: Interceptor | undefined;

  function resourceJson(): Record<string, unknown> {
    const current = must(stored, "stored object");
    return {
      kind: "storage#object",
      bucket: BUCKET,
      name: OBJECT,
      generation: current.generation,
      metageneration: current.metageneration,
      size: String(current.content.byteLength),
      md5Hash: md5b64(current.content),
      contentType: "application/octet-stream",
      updated: "2026-09-18T00:00:00.000Z",
      metadata: { ...current.metadata },
    };
  }

  async function handleUpload(call: RecordedCall): Promise<Response> {
    const params = new URL(call.url).searchParams;
    const ifGenerationMatch = params.get("ifGenerationMatch");
    const ifMetagenerationMatch = params.get("ifMetagenerationMatch");
    const { metadataJson, content } = parseMultipart(must(call.body, "upload body"), multipartBoundary(call));
    if (metadataJson.md5Hash !== md5b64(content)) return jsonResponse(400, { error: "md5 mismatch" });
    // Preconditions are evaluated at commit time, after the full body arrived.
    if (ifGenerationMatch === "0") {
      if (stored) return jsonResponse(412, { error: "precondition failed" });
    } else if (!stored || stored.generation !== ifGenerationMatch || stored.metageneration !== ifMetagenerationMatch) {
      return jsonResponse(412, { error: "precondition failed" });
    }
    const metadata = metadataJson.metadata;
    if (!metadata || typeof metadata !== "object") throw new Error("test: upload carried no metadata");
    generationCounter += 1;
    stored = {
      content,
      generation: String(generationCounter),
      metageneration: "1",
      metadata: { ...(metadata as Record<string, string>) },
    };
    return jsonResponse(200, resourceJson());
  }

  function handlePatch(call: RecordedCall): Response {
    if (!stored) return jsonResponse(404, { error: "not found" });
    const params = new URL(call.url).searchParams;
    if (
      stored.generation !== params.get("ifGenerationMatch") ||
      stored.metageneration !== params.get("ifMetagenerationMatch")
    ) {
      return jsonResponse(412, { error: "precondition failed" });
    }
    const patch = JSON.parse(Buffer.from(must(call.body, "patch body")).toString("utf8")) as {
      metadata?: Record<string, string>;
    };
    stored = {
      ...stored,
      metageneration: String(Number(stored.metageneration) + 1),
      metadata: { ...stored.metadata, ...(patch.metadata ?? {}) },
    };
    return jsonResponse(200, resourceJson());
  }

  function handleMetadataGet(): Response {
    return stored ? jsonResponse(200, resourceJson()) : jsonResponse(404, { error: "not found" });
  }

  function handleMediaGet(call: RecordedCall): Response {
    const generation = new URL(call.url).searchParams.get("generation");
    if (!stored || stored.generation !== generation) return jsonResponse(404, { error: "not found" });
    return new Response(chunkedStream(stored.content), {
      status: 200,
      headers: { "content-length": String(stored.content.byteLength) },
    });
  }

  async function defaultHandler(call: RecordedCall): Promise<Response> {
    if (call.method === "POST" && call.url.startsWith(UPLOAD_URL_PREFIX)) return handleUpload(call);
    if (call.method === "PATCH" && call.url.startsWith(`${META_URL}?`)) return handlePatch(call);
    if (call.method === "GET" && call.url === META_URL) return handleMetadataGet();
    if (call.method === "GET" && call.url.startsWith(`${META_URL}?alt=media`)) return handleMediaGet(call);
    throw new Error(`test: unexpected request ${call.method} ${call.url}`);
  }

  const fetchImpl = async (
    input: unknown,
    init?: {
      method?: string;
      body?: string | ReadableStream<Uint8Array>;
      headers?: Record<string, string>;
      redirect?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> => {
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url: String(input),
      authorization: init?.headers?.authorization,
      redirect: init?.redirect,
      contentType: init?.headers?.["content-type"],
      contentLength: init?.headers?.["content-length"],
      hasSignal: init?.signal instanceof AbortSignal,
      signal: init?.signal,
      body: undefined,
    };
    if (init?.body !== undefined) {
      // Mirrors undici: a request-body stream error rejects the fetch with that same error.
      call.body =
        typeof init.body === "string"
          ? Buffer.from(init.body, "utf8")
          : await streamToBytes(init.body as ReadableStream<Uint8Array>);
    }
    calls.push(call);
    if (interceptor) {
      const response = await interceptor({ call, proceed: () => defaultHandler(call) });
      if (response !== undefined) return response;
    }
    return defaultHandler(call);
  };

  return {
    calls,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    setInterceptor(next: Interceptor | undefined): void {
      interceptor = next;
    },
    plant(
      content: Uint8Array,
      meta: { owner: number; saved: boolean; sealed: boolean; sha256?: string },
    ): StoredFakeObject {
      generationCounter += 1;
      stored = {
        content,
        generation: String(generationCounter),
        metageneration: "1",
        metadata: metadataMap({
          owner: meta.owner,
          saved: meta.saved,
          sealed: meta.sealed,
          sha256: meta.sha256 ?? sha256hex(content),
        }),
      };
      return stored;
    },
    stored(): StoredFakeObject | undefined {
      return stored;
    },
    clearStored(): void {
      stored = undefined;
    },
    resourceJson,
    callsNamed(method: string): RecordedCall[] {
      return calls.filter((call) => call.method === method);
    },
  };
}

type FakeGcs = ReturnType<typeof createFakeGcs>;

function createStore(fake: FakeGcs, timeoutMs = 5_000): GcsWorkspaceObjectStore {
  return new GcsWorkspaceObjectStore({ tokenProvider: async () => TOKEN, fetchImpl: fake.fetchImpl, timeoutMs });
}

function archiveInput(content: Uint8Array, sealed = false) {
  return {
    body: chunksOf(content, 11),
    bytes: content.byteLength,
    sha256: sha256hex(content),
    md5: md5b64(content),
    sealed,
  };
}

function previousOf(object: StoredFakeObject): WorkspaceObject {
  return {
    generation: object.generation,
    metageneration: object.metageneration,
    ownerGeneration: Number(object.metadata.owner),
    saved: object.metadata.saved === "true",
    sealed: object.metadata.sealed === "true",
    bytes: object.content.byteLength,
    sha256: must(object.metadata.sha256),
    md5: md5b64(object.content),
  };
}

describe("workspace object store URI and scope validation", () => {
  it("rejects malformed storage URIs and scopes without any network call", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const invalidUris = [
      "https://bucket/workspaces/prod/x",
      "gs://bucket",
      "gs://bucket/",
      `gs://bucket/${PREFIX}?version=1`,
      `gs://bucket/${PREFIX}#frag`,
      `gs://user:pass@bucket/${PREFIX}`,
      "gs://bucket/workspaces/prod/other-sandbox",
      `gs://bucket//prod/${SANDBOX}`,
      `gs://Bucket/${PREFIX}`,
      `gs://bucket/workspaces/../${SANDBOX}`,
      `gs://bucket/${PREFIX}/extra`,
    ];
    for (const storageUri of invalidUris) {
      const error = await store.head({ ...SCOPE, storageUri }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_uri");
    }
    for (const bad of [
      { ...SCOPE, sandboxId: "not an id!" },
      { ...SCOPE, sessionId: "" },
      { ...SCOPE, environmentGeneration: 0 },
      { ...SCOPE, environmentGeneration: 1.5 },
      { ...SCOPE, environmentGeneration: Number.MAX_SAFE_INTEGER },
    ]) {
      const error = await store.head(bad).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_scope");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("maps the fixed storage URI to the exact state.tar.gz object URL", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    expect(await store.head(SCOPE)).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    const call = must(fake.calls[0]);
    expect(call.method).toBe("GET");
    expect(call.url).toBe(META_URL);
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.redirect).toBe("error");
    expect(call.hasSignal).toBe(true);
    expect(call.url.startsWith("https://storage.googleapis.com/")).toBe(true);
  });
});

describe("workspace object store head", () => {
  it("returns undefined when the object is absent, without seeding", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    expect(await store.head(SCOPE)).toBeUndefined();
    expect(fake.callsNamed("POST")).toHaveLength(0);
    expect(fake.callsNamed("PATCH")).toHaveLength(0);
  });

  it("returns the validated snapshot of the latest object", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 4, saved: true, sealed: false });
    const store = createStore(fake);
    const object = await store.head({ ...SCOPE, environmentGeneration: 4 });
    expect(object).toEqual({
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 4,
      saved: true,
      sealed: false,
      bytes: content.byteLength,
      sha256: sha256hex(content),
      md5: md5b64(content),
    });
  });

  it("rejects corrupt metadata and foreign identities strictly", async () => {
    const metadataOf = (resource: Record<string, unknown>): Record<string, unknown> =>
      resource.metadata as Record<string, unknown>;
    const metaSet = (patch: Record<string, unknown>) => (resource: Record<string, unknown>) => {
      Object.assign(metadataOf(resource), patch);
    };
    const metaDelete = (key: string) => (resource: Record<string, unknown>) => {
      delete metadataOf(resource)[key];
    };
    const cases: Array<{ mutate: (resource: Record<string, unknown>) => void; code: string }> = [
      { mutate: metaSet({ schema: "2" }), code: "corrupt" },
      { mutate: metaSet({ extra: "x" }), code: "corrupt" },
      { mutate: metaDelete("sha256"), code: "corrupt" },
      { mutate: metaSet({ sandbox: "other" }), code: "owner_mismatch" },
      { mutate: metaSet({ session: "other" }), code: "owner_mismatch" },
      { mutate: metaSet({ owner: "0" }), code: "corrupt" },
      { mutate: metaSet({ owner: "1.5" }), code: "corrupt" },
      { mutate: metaSet({ saved: "yes" }), code: "corrupt" },
      { mutate: metaSet({ sealed: "no" }), code: "corrupt" },
      { mutate: metaSet({ sha256: "z".repeat(64) }), code: "corrupt" },
      {
        mutate: (resource) => {
          resource.generation = "0";
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.generation = "12x";
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.size = String(RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES + 1);
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.size = "12x";
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.md5Hash = "not-base64!!";
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.name = `${PREFIX}/other.tar.gz`;
        },
        code: "corrupt",
      },
      {
        mutate: (resource) => {
          resource.bucket = "someone-else";
        },
        code: "corrupt",
      },
    ];
    for (const { mutate, code } of cases) {
      const fake = createFakeGcs();
      fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
      fake.setInterceptor(async ({ call, proceed }) => {
        if (call.method === "GET" && call.url === META_URL) {
          await proceed();
          const resource = structuredClone(fake.resourceJson());
          mutate(resource);
          return jsonResponse(200, resource);
        }
        return undefined;
      });
      const store = createStore(fake);
      const error = await store.head(SCOPE).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe(code);
    }
  });
});

describe("workspace object store claim", () => {
  it("never recreates a missing archive for a Runner claim, including generation one", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    await expect(store.claim(SCOPE)).rejects.toMatchObject({ code: "missing" });
    expect(fake.callsNamed("POST")).toHaveLength(0);
  });
  it("seeds an empty object for the first generation with ifGenerationMatch=0", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const seed = await store.claim(SCOPE, { initialize: true });
    expect(seed).toEqual({
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 1,
      saved: false,
      sealed: false,
      bytes: 0,
      sha256: EMPTY_SHA256,
      md5: EMPTY_MD5,
    });
    const post = must(fake.callsNamed("POST")[0]);
    expect(post.url).toBe(`${UPLOAD_URL_PREFIX}&ifGenerationMatch=0`);
    expect(post.contentLength).toBe(String(must(post.body).byteLength));
    const { metadataJson, content } = parseMultipart(must(post.body), multipartBoundary(post));
    expect(metadataJson).toEqual({
      name: OBJECT,
      contentType: "application/octet-stream",
      md5Hash: EMPTY_MD5,
      metadata: metadataMap({ owner: 1, saved: false, sealed: false, sha256: EMPTY_SHA256 }),
    });
    expect(content.byteLength).toBe(0);
  });

  it("converges on a simultaneous create by re-reading after a 412", async () => {
    const fake = createFakeGcs();
    let raced = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "POST" && !raced) {
        raced = true;
        // A concurrent creator wins: the seed commit lands, our insert sees the 412.
        fake.plant(new Uint8Array(), { owner: 1, saved: false, sealed: false, sha256: EMPTY_SHA256 });
        return jsonResponse(412, { error: "precondition failed" });
      }
      return undefined;
    });
    const store = createStore(fake);
    const seed = await store.claim(SCOPE, { initialize: true });
    expect(seed.ownerGeneration).toBe(1);
    expect(seed.saved).toBe(false);
    expect(seed.generation).toBe("1001");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    expect(fake.callsNamed("GET")).toHaveLength(2);
  });

  it("fails hard when the archive is missing past the first generation", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 3 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
    expect((error as WorkspaceObjectStoreError).code).toBe("missing");
    expect(fake.calls).toHaveLength(1);
    expect(fake.callsNamed("POST")).toHaveLength(0);
  });

  it("returns the current object unchanged for the same owner, keeping the seal", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("sealed-archive");
    fake.plant(content, { owner: 2, saved: true, sealed: true });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(object.sealed).toBe(true);
    expect(object.saved).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.callsNamed("PATCH")).toHaveLength(0);
  });

  it("advances ownership with a conditional PATCH, keeping content, saved and checksums", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("restored-archive");
    const planted = fake.plant(content, { owner: 1, saved: true, sealed: true });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(object.sealed).toBe(false);
    expect(object.saved).toBe(true);
    expect(object.bytes).toBe(content.byteLength);
    expect(object.sha256).toBe(sha256hex(content));
    expect(object.md5).toBe(md5b64(content));
    expect(object.generation).toBe(planted.generation);
    expect(object.metageneration).toBe("2");
    const patch = must(fake.callsNamed("PATCH")[0]);
    expect(patch.url).toBe(`${META_URL}?ifGenerationMatch=${planted.generation}&ifMetagenerationMatch=1`);
    expect(JSON.parse(Buffer.from(must(patch.body)).toString("utf8"))).toEqual({
      metadata: metadataMap({ owner: 2, saved: true, sealed: false, sha256: sha256hex(content) }),
    });
    // The claim touched metadata only: the archive bytes are untouched and no upload happened.
    expect(must(fake.stored()).content).toEqual(content);
    expect(fake.callsNamed("POST")).toHaveLength(0);
  });

  it("rejects a claim from an older generation without any PATCH", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 3, saved: true, sealed: false });
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("stale");
    expect(fake.calls).toHaveLength(1);
    expect(fake.callsNamed("PATCH")).toHaveLength(0);
  });

  it("retries a claim that loses a metadata race against an overwrite", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    let raced = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "PATCH" && !raced) {
        raced = true;
        // A racing overwrite lands first: the generation changes, our PATCH precondition fails.
        fake.plant(Buffer.from("archive-v2-by-old-owner"), { owner: 1, saved: true, sealed: false });
        return jsonResponse(412, { error: "precondition failed" });
      }
      return undefined;
    });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(object.bytes).toBe(Buffer.from("archive-v2-by-old-owner").byteLength);
    expect(fake.callsNamed("PATCH")).toHaveLength(2);
    expect(fake.callsNamed("GET")).toHaveLength(2);
  });

  it("returns the racing winner's snapshot when the re-read already shows our owner", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    let raced = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "PATCH" && !raced) {
        raced = true;
        const stored = must(fake.stored());
        stored.metadata = { ...stored.metadata, owner: "2", sealed: "false" };
        stored.metageneration = "2";
        return jsonResponse(412, { error: "precondition failed" });
      }
      return undefined;
    });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(fake.callsNamed("PATCH")).toHaveLength(1);
  });

  it("rejects the claim when the re-read shows a newer owner, never regressing", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    let raced = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "PATCH" && !raced) {
        raced = true;
        const stored = must(fake.stored());
        stored.metadata = { ...stored.metadata, owner: "7" };
        stored.metageneration = "5";
        return jsonResponse(412, { error: "precondition failed" });
      }
      return undefined;
    });
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("stale");
    expect(must(fake.stored()).metadata.owner).toBe("7");
  });

  it("converges when a PATCH result is unknown but committed", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    let raced = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "PATCH" && !raced) {
        raced = true;
        await proceed(); // The PATCH commits, then the connection drops before the response.
        throw timeoutError();
      }
      return undefined;
    });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(fake.callsNamed("PATCH")).toHaveLength(1);
    expect(fake.callsNamed("GET")).toHaveLength(2);
  });

  it("converges when the seed insert commits but answers 5xx", async () => {
    const fake = createFakeGcs();
    let cut = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST" && !cut) {
        cut = true;
        await proceed(); // The seed committed, then the response was lost behind a 503.
        return jsonResponse(503, { error: "backend error" });
      }
      return undefined;
    });
    const store = createStore(fake);
    const seed = await store.claim(SCOPE, { initialize: true });
    expect(seed.ownerGeneration).toBe(1);
    expect(seed.saved).toBe(false);
    expect(seed.bytes).toBe(0);
    expect(fake.callsNamed("POST")).toHaveLength(1);
    expect(fake.callsNamed("GET")).toHaveLength(2);
  });

  it("bounds claim retries against persistent conflicts", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(async ({ call }) =>
      call.method === "PATCH" ? jsonResponse(412, { error: "busy" }) : undefined,
    );
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("conflict");
    expect(fake.callsNamed("PATCH")).toHaveLength(5);
    expect(fake.callsNamed("GET")).toHaveLength(5);
    expect(must(fake.stored()).metadata.owner).toBe("1");
  });
});

describe("workspace object store write", () => {
  it("uploads a conditional multipart body with exact framing and checksums", async () => {
    const fake = createFakeGcs();
    const previousContent = Buffer.from("archive-v1");
    const planted = fake.plant(previousContent, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = await store.head(SCOPE);
    const content = Buffer.from("workspace-archive-v2".repeat(64));
    const input = archiveInput(content);
    const result = await store.write(SCOPE, must(previous), input);
    expect(result.saved).toBe(true);
    expect(result.sealed).toBe(false);
    expect(result.bytes).toBe(content.byteLength);
    expect(result.sha256).toBe(sha256hex(content));
    expect(result.md5).toBe(md5b64(content));
    expect(result.ownerGeneration).toBe(1);
    expect(result.generation).not.toBe(planted.generation);

    const post = must(fake.callsNamed("POST")[0]);
    expect(post.url).toBe(
      `${UPLOAD_URL_PREFIX}&ifGenerationMatch=${planted.generation}&ifMetagenerationMatch=${planted.metageneration}`,
    );
    expect(post.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.redirect).toBe("error");
    expect(post.contentLength).toBe(String(must(post.body).byteLength));
    const { metadataJson, content: streamed } = parseMultipart(must(post.body), multipartBoundary(post));
    expect(metadataJson).toEqual({
      name: OBJECT,
      contentType: "application/octet-stream",
      md5Hash: md5b64(content),
      metadata: metadataMap({ owner: 1, saved: true, sealed: false, sha256: sha256hex(content) }),
    });
    expect(Buffer.from(streamed).equals(content)).toBe(true);
    // Atomic overwrite: the old generation is gone from the fake's single latest slot.
    expect(must(fake.stored()).generation).toBe(result.generation);
  });

  it("seals through the same latest object with no extra objects", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("final-archive");
    fake.plant(content, { owner: 1, saved: false, sealed: false });
    const store = createStore(fake);
    const previous = await store.head(SCOPE);
    const result = await store.write(SCOPE, must(previous), archiveInput(content, true));
    expect(result.sealed).toBe(true);
    expect(result.saved).toBe(true);
    const stored = must(fake.stored());
    expect(stored.metadata.sealed).toBe("true");
    expect(fake.callsNamed("POST")).toHaveLength(1);
  });

  it("refuses a write after the snapshot was sealed, without any request", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const previous: WorkspaceObject = {
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 1,
      saved: true,
      sealed: true,
      bytes: 3,
      sha256: sha256hex(Buffer.from("abc")),
      md5: md5b64(Buffer.from("abc")),
    };
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("new"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("sealed");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses writes under a foreign owner and malformed inputs without any request", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const content = Buffer.from("payload");
    const previous: WorkspaceObject = {
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 2,
      saved: true,
      sealed: false,
      bytes: content.byteLength,
      sha256: sha256hex(content),
      md5: md5b64(content),
    };
    const stale = await store.write(SCOPE, previous, archiveInput(content)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((stale as WorkspaceObjectStoreError).code).toBe("stale");

    const owned = { ...previous, ownerGeneration: 1 };
    const badInputs: Array<Record<string, unknown>> = [
      { bytes: 0 },
      { bytes: RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES + 1 },
      { bytes: -5 },
      { sha256: "not-a-digest" },
      { md5: "not-base64!!" },
      { body: {} },
    ];
    for (const patch of badInputs) {
      const input = { ...archiveInput(content), ...patch } as unknown as WorkspaceObjectWriteInput;
      const error = await store.write(SCOPE, owned, input).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_input");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("fails when the object is missing or the snapshot moved before the upload", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const content = Buffer.from("payload");
    const planted = fake.plant(content, { owner: 1, saved: true, sealed: false });
    const previous = previousOf(planted);

    fake.clearStored();
    const missing = await store.write(SCOPE, previous, archiveInput(content)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((missing as WorkspaceObjectStoreError).code).toBe("missing");
    expect(fake.callsNamed("POST")).toHaveLength(0);

    fake.plant(Buffer.from("overwritten"), { owner: 1, saved: true, sealed: false });
    const conflict = await store.write(SCOPE, previous, archiveInput(content)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((conflict as WorkspaceObjectStoreError).code).toBe("conflict");
    expect(fake.callsNamed("POST")).toHaveLength(0);
  });

  it("fences a delayed old-owner upload after the new owner's metadata claim, with no new archive", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const oldPrevious = await store.head({ ...SCOPE, environmentGeneration: 1 });
    // New allocation restores (claim only, no save): ownership advances to generation 2.
    const claimed = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(claimed.ownerGeneration).toBe(2);
    expect(fake.callsNamed("POST")).toHaveLength(0);
    // The old executor's delayed write never reaches an upload: the snapshot owner moved on.
    const error = await store
      .write({ ...SCOPE, environmentGeneration: 1 }, must(oldPrevious), archiveInput(Buffer.from("old-payload")))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((error as WorkspaceObjectStoreError).code).toBe("stale");
    expect(fake.callsNamed("POST")).toHaveLength(0);
    expect(must(fake.stored()).content).toEqual(content);
  });

  it("fences an in-flight old upload that commits after the new owner's PATCH", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const oldPrevious = await store.head({ ...SCOPE, environmentGeneration: 1 });
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST") {
        // The old executor passed the pre-check, then the new owner's claim PATCH landed before
        // this upload committed: the metageneration precondition now fails at commit time.
        const stored = must(fake.stored());
        stored.metadata = { ...stored.metadata, owner: "2", sealed: "false" };
        stored.metageneration = "2";
        return proceed();
      }
      return undefined;
    });
    const error = await store
      .write({ ...SCOPE, environmentGeneration: 1 }, must(oldPrevious), archiveInput(Buffer.from("old-payload")))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((error as WorkspaceObjectStoreError).code).toBe("conflict");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    const stored = must(fake.stored());
    expect(stored.content).toEqual(content);
    expect(stored.metadata.owner).toBe("2");
  });

  it("verifies an unknown upload result by read-back and succeeds only on exact match", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v2".repeat(32));
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let dropped = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST" && !dropped) {
        dropped = true;
        await proceed(); // Committed, but the response never arrived.
        throw timeoutError();
      }
      return undefined;
    });
    const input = archiveInput(content, true);
    const result = await store.write(SCOPE, previous, input);
    expect(result.saved).toBe(true);
    expect(result.sealed).toBe(true);
    expect(result.bytes).toBe(content.byteLength);
    expect(result.sha256).toBe(sha256hex(content));
    expect(result.md5).toBe(md5b64(content));
    expect(result.generation).not.toBe(previous.generation);
    expect(fake.callsNamed("POST")).toHaveLength(1);
  });

  it("rejects an unknown upload result that did not commit, without retrying unconditionally", async () => {
    const fake = createFakeGcs();
    const original = Buffer.from("archive-v1");
    const planted = fake.plant(original, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let dropped = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "POST" && !dropped) {
        dropped = true;
        throw timeoutError(); // Never committed.
      }
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    const stored = must(fake.stored());
    expect(stored.generation).toBe(planted.generation);
    expect(stored.content).toEqual(original);
  });

  it("rejects an unknown upload result when the read-back shows different content", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let dropped = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST" && !dropped) {
        dropped = true;
        await proceed();
        // Another writer replaced the committed object before our verification read.
        fake.plant(Buffer.from("foreign-content"), { owner: 1, saved: true, sealed: false });
        throw timeoutError();
      }
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
  });

  it("verifies a 5xx upload by read-back, succeeding only on the exact object under a new generation", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v2".repeat(32));
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let cut = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST" && !cut) {
        cut = true;
        await proceed(); // Committed, then the response was lost behind a 503.
        return jsonResponse(503, { error: "backend error" });
      }
      return undefined;
    });
    const input = archiveInput(content, true);
    const result = await store.write(SCOPE, previous, input);
    expect(result.saved).toBe(true);
    expect(result.sealed).toBe(true);
    expect(result.bytes).toBe(content.byteLength);
    expect(result.sha256).toBe(sha256hex(content));
    expect(result.md5).toBe(md5b64(content));
    expect(result.generation).not.toBe(previous.generation);
    expect(fake.callsNamed("POST")).toHaveLength(1);
  });

  it("rejects a 5xx upload that never committed, without retrying stale bytes", async () => {
    const fake = createFakeGcs();
    const original = Buffer.from("archive-v1");
    const planted = fake.plant(original, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let cut = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "POST" && !cut) {
        cut = true;
        return jsonResponse(503, { error: "backend error" }); // Never committed.
      }
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    const stored = must(fake.stored());
    expect(stored.generation).toBe(planted.generation);
    expect(stored.content).toEqual(original);
  });

  it("rejects a 5xx upload when the read-back shows unrelated content", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let cut = false;
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method === "POST" && !cut) {
        cut = true;
        await proceed();
        // Another writer replaced the committed object before our verification read.
        fake.plant(Buffer.from("foreign-content"), { owner: 1, saved: true, sealed: false });
        return jsonResponse(503, { error: "backend error" });
      }
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
  });

  it("rejects sources that violate the declared length, and the upload cannot commit", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    const planted = fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));

    async function* tooLong(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("12345678");
      yield Buffer.from("extra");
    }
    const longError = await store
      .write(SCOPE, previous, { ...archiveInput(Buffer.from("12345678")), body: tooLong() })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((longError as WorkspaceObjectStoreError).code).toBe("invalid_input");

    async function* tooShort(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("1234");
    }
    const shortError = await store
      .write(SCOPE, previous, { ...archiveInput(Buffer.from("12345678")), body: tooShort() })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((shortError as WorkspaceObjectStoreError).code).toBe("invalid_input");
    const stored = must(fake.stored());
    expect(stored.generation).toBe(planted.generation);
    expect(stored.content).toEqual(content);
  });

  it("maps a content md5 mismatch to a definitive rejection", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    const input = { ...archiveInput(Buffer.from("archive-v2")), md5: md5b64(Buffer.from("other-bytes")) };
    const error = await store.write(SCOPE, previous, input).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("invalid_input");
    expect((error as WorkspaceObjectStoreError).status).toBe(400);
    expect(must(fake.stored()).content).toEqual(Buffer.from("archive-v1"));
  });
});

describe("workspace object store read", () => {
  it("streams the pinned generation with an exact byte count", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("workspace-archive-bytes".repeat(40));
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    const stream = await store.read(SCOPE, object);
    const bytes = await streamToBytes(stream);
    expect(Buffer.from(bytes).equals(content)).toBe(true);
    const media = must(fake.callsNamed("GET").find((call) => call.url.includes("alt=media")));
    expect(media.url).toBe(`${META_URL}?alt=media&generation=${object.generation}`);
    expect(media.authorization).toBe(`Bearer ${TOKEN}`);
    expect(media.redirect).toBe("error");
    expect(media.hasSignal).toBe(true);
  });

  it("reads the empty seed as a zero-byte stream", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const seed = await store.claim(SCOPE, { initialize: true });
    const bytes = await streamToBytes(await store.read(SCOPE, seed));
    expect(bytes.byteLength).toBe(0);
  });

  it("fails when the object changed since the claim, never silently reading latest", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.plant(Buffer.from("archive-v2"), { owner: 1, saved: true, sealed: false });
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("changed");
    expect(fake.calls.filter((call) => call.url.includes("alt=media"))).toHaveLength(0);
  });

  it("fails when the pinned generation disappears before the media request", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media") ? jsonResponse(404, { error: "gone" }) : undefined,
    );
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("changed");
  });

  it("rejects a snapshot owned by another generation without any request", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const content = Buffer.from("abc");
    const object: WorkspaceObject = {
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 2,
      saved: true,
      sealed: false,
      bytes: content.byteLength,
      sha256: sha256hex(content),
      md5: md5b64(content),
    };
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("stale");
    expect(fake.calls).toHaveLength(0);
  });

  it("bounds the stream: overflow, truncation and header mismatch all fail", async () => {
    const content = Buffer.from("archive-bytes");
    const scenarios: Array<{ body: () => ReadableStream<Uint8Array>; lengthHeader: string; duringRead: boolean }> = [
      {
        body: () => chunkedStream(Buffer.concat([content, Buffer.from("!")])),
        lengthHeader: String(content.byteLength),
        duringRead: true,
      },
      {
        body: () => chunkedStream(content.subarray(0, content.byteLength - 2)),
        lengthHeader: String(content.byteLength),
        duringRead: true,
      },
      { body: () => chunkedStream(content), lengthHeader: String(content.byteLength + 1), duringRead: false },
    ];
    for (const scenario of scenarios) {
      const fake = createFakeGcs();
      fake.plant(content, { owner: 1, saved: true, sealed: false });
      const store = createStore(fake);
      const object = must(await store.head(SCOPE));
      fake.setInterceptor(async ({ call }) =>
        call.url.includes("alt=media")
          ? new Response(scenario.body(), { status: 200, headers: { "content-length": scenario.lengthHeader } })
          : undefined,
      );
      if (scenario.duringRead) {
        const stream = await store.read(SCOPE, object);
        const error = await streamToBytes(stream).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect((error as WorkspaceObjectStoreError).code).toBe("corrupt");
      } else {
        const error = await store.read(SCOPE, object).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect((error as WorkspaceObjectStoreError).code).toBe("corrupt");
      }
    }
  });

  it("keeps the deadline armed across slow consumption without firing early", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes".repeat(16));
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake, 2_000);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) => {
      if (!call.url.includes("alt=media")) return undefined;
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (offset >= content.byteLength) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
            const end = Math.min(offset + 3, content.byteLength);
            controller.enqueue(content.subarray(offset, end));
            offset = end;
          },
        }),
        { status: 200, headers: { "content-length": String(content.byteLength) } },
      );
    });
    const bytes = await streamToBytes(await store.read(SCOPE, object));
    expect(Buffer.from(bytes).equals(content)).toBe(true);
  });

  it("errors the stream with a typed timeout when the deadline fires mid-read", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake, 60);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) => {
      if (!call.url.includes("alt=media")) return undefined;
      const signal = call.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          },
          pull() {
            // Never yields: the shared deadline must abort the consumption.
          },
        }),
        { status: 200, headers: { "content-length": String(content.byteLength) } },
      );
    });
    const stream = await store.read(SCOPE, object);
    const error = await streamToBytes(stream).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("timeout");
  });

  it("cancels cleanly when the consumer abandons the stream", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-bytes".repeat(8)), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    const stream = await store.read(SCOPE, object);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    reader.releaseLock();
  });
});

describe("workspace object store transport hygiene", () => {
  it("times out and maps deadline failures to a typed timeout", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async () => {
      throw timeoutError();
    });
    const store = createStore(fake);
    const error = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("timeout");
  });

  it("treats transport failures (including blocked redirects) as unavailable, without token leakage", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async () => {
      throw new TypeError(`redirect blocked for authorization=Bearer ${TOKEN}`);
    });
    const store = createStore(fake);
    const error = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
    const typed = error as WorkspaceObjectStoreError;
    expect(typed.code).toBe("unavailable");
    expect(typed.message).not.toContain(TOKEN);
    expect(typed.message).not.toContain("authorization");
  });

  it("fails with credential when the token provider or GCS auth rejects", async () => {
    const fake = createFakeGcs();
    const failing = new GcsWorkspaceObjectStore({
      tokenProvider: async () => {
        throw new Error("metadata server down");
      },
      fetchImpl: fake.fetchImpl,
      timeoutMs: 5_000,
    });
    const providerError = await failing.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((providerError as WorkspaceObjectStoreError).code).toBe("credential");
    expect(fake.calls).toHaveLength(0);

    fake.setInterceptor(async () => jsonResponse(401, { error: "unauthorized" }));
    const store = createStore(fake);
    const authError = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((authError as WorkspaceObjectStoreError).code).toBe("credential");
  });

  it("bounds metadata responses instead of buffering untrusted bodies", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async () => new Response("x".repeat(200_000), { status: 200 }));
    const store = createStore(fake);
    const error = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unavailable");
  });

  it("maps server-side failures to typed codes and never parses error bodies", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async () => new Response("sensitive-upstream-payload", { status: 503 }));
    const store = createStore(fake);
    const error = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const typed = error as WorkspaceObjectStoreError;
    expect(typed.code).toBe("unavailable");
    expect(typed.status).toBe(503);
    expect(typed.message).not.toContain("sensitive-upstream-payload");
  });

  it("swallows a rejecting cancel while discarding an upstream error body", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("upstream error body"));
            },
            cancel() {
              return Promise.reject(new Error("teardown failed"));
            },
          }),
          { status: 404 },
        ),
    );
    const store = createStore(fake);
    expect(await store.head(SCOPE)).toBeUndefined();
    // Let the detached teardown promise settle so a regression to an unhandled rejection is visible.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects constructor timeouts outside the safe bound", () => {
    expect(() => new GcsWorkspaceObjectStore({ tokenProvider: async () => TOKEN, timeoutMs: 0 })).toThrow(
      WorkspaceObjectStoreError,
    );
    expect(() => new GcsWorkspaceObjectStore({ tokenProvider: async () => TOKEN, timeoutMs: 1.5 })).toThrow(
      WorkspaceObjectStoreError,
    );
  });
});

describe("workspace object store fail-closed input validation", () => {
  it("rejects storage URIs outside the durable address bound", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    for (const storageUri of ["", `gs://${BUCKET}/${"a".repeat(2_100)}`, 42 as unknown as string]) {
      const error = await store.head({ ...SCOPE, storageUri }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_uri");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a metadata response that is not a JSON object resource", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async () => jsonResponse(200, []));
    const store = createStore(fake);
    const error = await store.head(SCOPE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("corrupt");
  });

  it("rejects snapshots outside the durable snapshot shape, before any request", async () => {
    const fake = createFakeGcs();
    const store = createStore(fake);
    const content = Buffer.from("abc");
    const valid: WorkspaceObject = {
      generation: "1001",
      metageneration: "1",
      ownerGeneration: 1,
      saved: true,
      sealed: false,
      bytes: content.byteLength,
      sha256: sha256hex(content),
      md5: md5b64(content),
    };
    const cases: Array<Record<string, unknown> | null> = [
      null,
      { generation: "0" },
      { generation: "12x" },
      { metageneration: "0" },
      { ownerGeneration: 0 },
      { ownerGeneration: 10_000_000_000 },
      { ownerGeneration: 1.5 },
      { bytes: -1 },
      { bytes: RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES + 1 },
      { bytes: 1.5 },
      { sha256: "z".repeat(64) },
      { md5: "not-base64!!" },
      { saved: "true" },
      { sealed: 0 },
    ];
    for (const patch of cases) {
      const object = (patch === null ? null : { ...valid, ...patch }) as unknown as WorkspaceObject;
      const error = await store.read(SCOPE, object).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_input");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects write inputs outside the durable input shape, before any request", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("payload");
    const planted = fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = previousOf(planted);
    // `null` is the missing input; the second case passes every earlier field check with a
    // non-boolean seal, which must still fail closed.
    const cases: unknown[] = [null, { ...archiveInput(content), sealed: "yes" }];
    for (const input of cases) {
      const error = await store.write(SCOPE, previous, input as WorkspaceObjectWriteInput).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
      expect((error as WorkspaceObjectStoreError).code).toBe("invalid_input");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("defaults the deadline and the platform fetch when options omit them", () => {
    const store = new GcsWorkspaceObjectStore({ tokenProvider: async () => TOKEN });
    expect(store).toBeInstanceOf(GcsWorkspaceObjectStore);
  });

  it("skips zero-length source chunks when framing the upload", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    async function* padded(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0);
      yield content.subarray(0, 4);
      yield new Uint8Array(0);
      yield content.subarray(4);
      yield new Uint8Array(0);
    }
    const result = await store.write(SCOPE, previous, { ...archiveInput(content), body: padded() });
    expect(result.sha256).toBe(sha256hex(content));
    expect(result.bytes).toBe(content.byteLength);
    expect(must(fake.stored()).content).toEqual(content);
  });
});

describe("workspace object store read failure modes", () => {
  it("fails a read when the archive disappeared after the claim", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.clearStored();
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("missing");
    expect(fake.calls.filter((call) => call.url.includes("alt=media"))).toHaveLength(0);
  });

  it("maps a failed media request to a typed error without reading its body", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media") ? new Response("sensitive-upstream-payload", { status: 503 }) : undefined,
    );
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const typed = error as WorkspaceObjectStoreError;
    expect(typed.code).toBe("unavailable");
    expect(typed.status).toBe(503);
    expect(typed.message).not.toContain("sensitive-upstream-payload");
  });

  it("fails a read whose media response carried no body", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media")
        ? new Response(null, { status: 200, headers: { "content-length": String(content.byteLength) } })
        : undefined,
    );
    const error = await store.read(SCOPE, object).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unavailable");
  });

  it("errors the stream with unavailable for an untyped mid-read failure", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media")
        ? new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("socket reset"));
              },
            }),
            { status: 200, headers: { "content-length": String(content.byteLength) } },
          )
        : undefined,
    );
    const stream = await store.read(SCOPE, object);
    const error = await streamToBytes(stream).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unavailable");
  });

  it("errors the stream with a typed timeout when the media body times out", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media")
        ? new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new DOMException("The operation timed out.", "TimeoutError"));
              },
            }),
            { status: 200, headers: { "content-length": String(content.byteLength) } },
          )
        : undefined,
    );
    const stream = await store.read(SCOPE, object);
    const error = await streamToBytes(stream).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("timeout");
  });

  it("ignores a rejecting cancel while bounding an over-long media stream", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.url.includes("alt=media")
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.concat([content, Buffer.from("!")]));
              },
              cancel() {
                return Promise.reject(new Error("teardown failed"));
              },
            }),
            { status: 200, headers: { "content-length": String(content.byteLength) } },
          )
        : undefined,
    );
    const stream = await store.read(SCOPE, object);
    const error = await streamToBytes(stream).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("corrupt");
  });

  it("settles a read abandoned mid-pull without a leaked source reader", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-bytes");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const object = must(await store.head(SCOPE));
    let markPulled: (() => void) | undefined;
    let openGate: (() => void) | undefined;
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    fake.setInterceptor(async ({ call }) => {
      if (!call.url.includes("alt=media")) return undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            markPulled?.();
            await gate;
            controller.enqueue(content.subarray(0, 4));
          },
        }),
        { status: 200, headers: { "content-length": String(content.byteLength) } },
      );
    });
    const stream = await store.read(SCOPE, object);
    const reader = stream.getReader();
    const pending = reader.read();
    await pulled; // The bounded stream is provably inside a pull, so cancellation races it.
    await reader.cancel("abandoned").catch(() => undefined);
    openGate?.();
    await pending.catch(() => undefined);
  });
});

describe("workspace object store uncertain upload settlement", () => {
  it("verifies by read-back when the upload response disagrees with the attempt", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v2".repeat(16));
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method !== "POST") return undefined;
      await proceed(); // The intended object committed...
      const resource = structuredClone(fake.resourceJson());
      // ...but the response describes a valid yet different snapshot, so only read-back can settle it.
      (resource.metadata as Record<string, string>).saved = "false";
      return jsonResponse(200, resource);
    });
    const result = await store.write(SCOPE, previous, archiveInput(content));
    expect(result.saved).toBe(true);
    expect(result.sha256).toBe(sha256hex(content));
    expect(must(fake.stored()).content).toEqual(content);
  });

  it("verifies by read-back when the upload response could not be decoded", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v2".repeat(16));
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method !== "POST") return undefined;
      await proceed();
      return new Response("x".repeat(200_000), { status: 200 });
    });
    const result = await store.write(SCOPE, previous, archiveInput(content));
    expect(result.generation).not.toBe(previous.generation);
    expect(result.sha256).toBe(sha256hex(content));
  });

  it("verifies by read-back when the upload response is not a workspace object", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v2".repeat(16));
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method !== "POST") return undefined;
      await proceed();
      return jsonResponse(200, { error: "unexpected resource" });
    });
    const result = await store.write(SCOPE, previous, archiveInput(content));
    expect(result.generation).not.toBe(previous.generation);
    expect(result.md5).toBe(md5b64(content));
  });

  it("reports an uncertain write when the verification read itself fails", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive-v1"), { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    let uploaded = false;
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "POST") {
        uploaded = true;
        return jsonResponse(503, { error: "backend error" }); // Never committed.
      }
      if (uploaded && call.method === "GET") return jsonResponse(500, { error: "verification read failed" });
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
  });

  it("rethrows a non-uncertain upload failure without re-reading", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    let tokenCalls = 0;
    // The metadata pre-check authenticates; the token then expires before the upload is signed.
    const store = new GcsWorkspaceObjectStore({
      tokenProvider: async () => {
        tokenCalls += 1;
        if (tokenCalls > 2) throw new Error("token expired");
        return TOKEN;
      },
      fetchImpl: fake.fetchImpl,
      timeoutMs: 5_000,
    });
    const previous = must(await store.head(SCOPE));
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("credential");
    expect(fake.callsNamed("POST")).toHaveLength(0);
  });

  it("treats a transport failure during the upload as an uncertain outcome", async () => {
    const fake = createFakeGcs();
    const original = Buffer.from("archive-v1");
    const planted = fake.plant(original, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) => {
      if (call.method === "POST") throw new TypeError("socket hang up");
      return undefined;
    });
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    const stored = must(fake.stored());
    expect(stored.generation).toBe(planted.generation);
    expect(stored.content).toEqual(original);
  });

  it("rejects a definitive 404 upload as missing, without re-reading", async () => {
    const fake = createFakeGcs();
    const original = Buffer.from("archive-v1");
    const planted = fake.plant(original, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    fake.setInterceptor(async ({ call }) =>
      call.method === "POST" ? jsonResponse(404, { error: "no such bucket" }) : undefined,
    );
    const error = await store.write(SCOPE, previous, archiveInput(Buffer.from("archive-v2"))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("missing");
    expect(fake.callsNamed("POST")).toHaveLength(1);
    expect(must(fake.stored()).generation).toBe(planted.generation);
  });

  it("errors the upload stream when the source iterable fails mid-body", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const store = createStore(fake);
    const previous = must(await store.head(SCOPE));
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield content.subarray(0, 4);
      throw new Error("source exploded");
    }
    const error = await store.write(SCOPE, previous, { ...archiveInput(content), body: broken() }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceObjectStoreError);
    expect((error as WorkspaceObjectStoreError).code).toBe("invalid_input");
    expect(must(fake.stored()).content).toEqual(content);
  });

  it("closes the multipart source iterator when the transport abandons the upload", async () => {
    const fake = createFakeGcs();
    const content = Buffer.from("archive-v1");
    fake.plant(content, { owner: 1, saved: true, sealed: false });
    const resource = fake.resourceJson();
    let closed = 0;
    const generator = chunksOf(content, 4);
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => generator.next(),
        return: (value?: unknown) => {
          closed += 1;
          return generator.return(value as undefined);
        },
      }),
    };
    let posted = false;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = true;
        const stream = must(init.body as ReadableStream<Uint8Array> | undefined, "upload body");
        const reader = stream.getReader();
        await reader.read(); // The framed preamble.
        await reader.read(); // The first content chunk: the source iterator is now open.
        await reader.cancel("transport abandoned the upload");
        reader.releaseLock();
        return jsonResponse(503, { error: "backend error" });
      }
      return posted ? jsonResponse(404, { error: "not found" }) : jsonResponse(200, resource);
    }) as unknown as typeof fetch;
    const store = new GcsWorkspaceObjectStore({ tokenProvider: async () => TOKEN, fetchImpl, timeoutMs: 5_000 });
    const previous = must(await store.head(SCOPE));
    const error = await store.write(SCOPE, previous, { ...archiveInput(content), body }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(closed).toBe(1);
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
  });
});

describe("workspace object store claim re-reads", () => {
  it("retries a claim whose PATCH lost the object to a 404", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(async ({ call }) =>
      call.method === "PATCH" ? jsonResponse(404, { error: "gone" }) : undefined,
    );
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("conflict");
    expect(fake.callsNamed("PATCH")).toHaveLength(5);
    expect(must(fake.stored()).metadata.owner).toBe("1");
  });

  it("re-reads a claim whose PATCH response could not be decoded", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(async ({ call }) =>
      call.method === "PATCH" ? new Response("x".repeat(200_000), { status: 200 }) : undefined,
    );
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
    expect(fake.callsNamed("PATCH")).toHaveLength(5);
  });

  it("re-reads a claim whose PATCH response is not a workspace object", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(async ({ call }) =>
      call.method === "PATCH" ? jsonResponse(200, { error: "unexpected resource" }) : undefined,
    );
    const store = createStore(fake);
    const error = await store.claim({ ...SCOPE, environmentGeneration: 2 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as WorkspaceObjectStoreError).code).toBe("unknown_result");
    expect(fake.callsNamed("PATCH")).toHaveLength(5);
  });

  it("re-reads a claim whose PATCH response does not match the patched snapshot", async () => {
    const fake = createFakeGcs();
    fake.plant(Buffer.from("archive"), { owner: 1, saved: true, sealed: false });
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method !== "PATCH") return undefined;
      await proceed(); // The owner advanced to generation 2...
      const resource = structuredClone(fake.resourceJson());
      // ...but the response still claims generation 1, so the claim must be re-read.
      (resource.metadata as Record<string, string>).owner = "1";
      return jsonResponse(200, resource);
    });
    const store = createStore(fake);
    const object = await store.claim({ ...SCOPE, environmentGeneration: 2 });
    expect(object.ownerGeneration).toBe(2);
    expect(fake.callsNamed("PATCH")).toHaveLength(1);
    expect(fake.callsNamed("GET")).toHaveLength(2);
  });

  it("re-reads a seed response that does not describe the empty object", async () => {
    const fake = createFakeGcs();
    fake.setInterceptor(async ({ call, proceed }) => {
      if (call.method !== "POST") return undefined;
      await proceed(); // The seed committed...
      const resource = structuredClone(fake.resourceJson());
      // ...but the response reports it as saved, which the empty seed never is.
      (resource.metadata as Record<string, string>).saved = "true";
      return jsonResponse(200, resource);
    });
    const store = createStore(fake);
    const seed = await store.claim(SCOPE, { initialize: true });
    expect(seed.ownerGeneration).toBe(1);
    expect(seed.saved).toBe(false);
    expect(seed.bytes).toBe(0);
    expect(fake.callsNamed("POST")).toHaveLength(1);
  });
});
