import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import webToolsExtension, {
  cleanupWebArtifacts,
  deriveWebToolIdentity,
  saveWebArtifact,
  truncateToByteBudget,
  WEB_EXTENSION_LIMITS,
} from "../pi-extensions/web-tools.js";
import { type WebGatewayDispatch, WebToolsGatewayServer } from "../runtime/web-tools-gateway.js";

const roots: string[] = [];
const servers: WebToolsGatewayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.OPENTAG_WEB_TOOLS_SOCKET;
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ot-web-ext-test-"));
  roots.push(root);
  return root;
}

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
}

function loadTools(socketPath: string | undefined): Map<string, CapturedTool> {
  if (socketPath === undefined) delete process.env.OPENTAG_WEB_TOOLS_SOCKET;
  else process.env.OPENTAG_WEB_TOOLS_SOCKET = socketPath;
  const tools = new Map<string, CapturedTool>();
  webToolsExtension({
    registerTool: (tool) => tools.set(tool.name, tool as unknown as CapturedTool),
  });
  return tools;
}

async function startGateway(dispatch: WebGatewayDispatch): Promise<WebToolsGatewayServer> {
  const root = await mkdtemp(join(tmpdir(), "ot-web-ext-gw-"));
  roots.push(root);
  const server = await WebToolsGatewayServer.start({ socketPath: join(root, "gateway.sock"), dispatch });
  servers.push(server);
  return server;
}

function requireTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`The ${name} tool is not registered`);
  return tool;
}

function resultText(result: { content: { type: "text"; text: string }[] }): string {
  const first = result.content[0];
  if (!first) throw new Error("The tool result has no text content");
  return first.text;
}

const searchResult = {
  requestId: "req-search-1",
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00Z",
  effectiveDepth: "basic" as const,
  results: [{ sourceId: "s1", title: "OpenTag 文档", url: "https://example.com/docs", snippet: "中文摘要".repeat(10) }],
};

describe("web tools Pi extension registration", () => {
  it("registers nothing without the endpoint descriptor", () => {
    expect(loadTools(undefined).size).toBe(0);
  });

  it("registers exactly web_search and web_fetch with bounded schemas", () => {
    const tools = loadTools("/tmp/ot-web-extension-never-connected.sock");
    expect([...tools.keys()].sort()).toEqual(["web_fetch", "web_search"]);
    const search = requireTool(tools, "web_search");
    expect(JSON.stringify(search.parameters)).toContain('"maxLength":400');
    const fetch = requireTool(tools, "web_fetch");
    expect(JSON.stringify(fetch.parameters)).toContain('"maxItems":3');
    expect(fetch.description).toContain("depth=advanced");
  });
});

describe("web_search execution", () => {
  it("returns bounded source snippets with retrieval metadata", async () => {
    const server = await startGateway(async (input) => {
      expect(input.operation).toBe("search");
      // The runtime (extension) generates the toolCallId, not the LLM.
      expect(input.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
      expect(input.params).toEqual({ query: "opentag", limit: 7, depth: "basic" });
      return searchResult;
    });
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const result = await requireTool(tools, "web_search").execute(
      "llm-chosen-id",
      { query: "opentag", limit: 7 } as never,
      undefined,
      undefined,
      { cwd },
    );
    const text = resultText(result);
    expect(text).toContain("req-search-1");
    expect(text).toContain("https://example.com/docs");
    expect(text).toContain("中文摘要");
    expect(result.details.requestId).toBe("req-search-1");
    // Search saves no page artifacts.
    expect(await readFile(join(cwd, ".opentag", "web", "metadata.json")).catch(() => undefined)).toBeUndefined();
  });

  it("bounds the whole tool result at 48 KiB with codepoint-safe truncation", async () => {
    // Each snippet must fit the 8 KiB wire bound, so several results are needed to exceed 48 KiB.
    const bigSnippet = "漢字🙂".repeat(800);
    const server = await startGateway(async () => ({
      ...searchResult,
      results: Array.from({ length: 8 }, (_value, index) => ({
        sourceId: `s${index}`,
        title: "big",
        url: `https://example.com/${index}`,
        snippet: bigSnippet,
      })),
    }));
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const result = await requireTool(tools, "web_search").execute("id", { query: "q" } as never, undefined, undefined, {
      cwd,
    });
    const text = resultText(result);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(WEB_EXTENSION_LIMITS.toolResultMaxBytes);
    expect(text).toContain("…[truncated]");
    expect(result.details.truncated).toBe(true);
  });

  it("surfaces gateway failures as tool errors, never success text", async () => {
    const server = await startGateway(async () => {
      throw new (await import("../runtime/web-tools-gateway.js")).WebGatewayDispatchError("rate_limited", "limited", {
        retryable: true,
      });
    });
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    await expect(
      requireTool(tools, "web_search").execute("id", { query: "q" } as never, undefined, undefined, { cwd }),
    ).rejects.toThrow(/rate_limited.*retryable/);
  });
});

describe("web_fetch execution", () => {
  it("saves pages with sha256 metadata, 12 KiB previews, and per-URL failure items", async () => {
    const cjk = "中文内容。".repeat(4_000); // ~60 KiB of CJK content
    const server = await startGateway(async (input) => {
      expect(input.operation).toBe("fetch");
      return {
        requestId: "req-fetch-1",
        status: "partial" as const,
        retrievedAt: "2026-09-17T00:00:00Z",
        effectiveDepth: "advanced" as const,
        results: [
          {
            status: "ok" as const,
            url: "https://example.com/a",
            finalUrl: null,
            contentKind: "extracted" as const,
            completeness: "unknown" as const,
            content: cjk,
            sourceFetchedAt: null,
            previewTruncated: false,
            artifactTruncated: false,
            upstreamTruncated: null,
          },
          { status: "failed" as const, url: "https://example.com/b", code: "timeout", retryable: true },
        ],
      };
    });
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const result = await requireTool(tools, "web_fetch").execute(
      "id",
      { urls: ["https://example.com/a", "https://example.com/b"], depth: "advanced" } as never,
      undefined,
      undefined,
      { cwd },
    );
    const text = resultText(result);
    expect(text).toContain("req-fetch-1");
    expect(text).toContain("FAILED: timeout (retryable");
    const artifacts = result.details.artifacts as Array<{ path: string; bytes: number; sha256: string }>;
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    if (!artifact) throw new Error("expected one saved artifact");
    const savedPath = artifact.path;
    expect(savedPath).toMatch(/^\.opentag\/web\/[0-9a-f-]{36}\/page-0\.md$/);
    const saved = await readFile(join(cwd, savedPath), "utf8");
    expect(saved).toBe(cjk);
    const metadata = JSON.parse(await readFile(join(cwd, savedPath, "..", "metadata.json"), "utf8"));
    expect(metadata.pages[0].sha256).toBe(artifact.sha256);
    expect(metadata.failures).toEqual([{ url: "https://example.com/b", code: "timeout", retryable: true }]);
    // The preview is bounded per page.
    const previewStart = text.indexOf("preview:\n");
    const preview = text.slice(previewStart + 9, text.indexOf("\n[2]"));
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(WEB_EXTENSION_LIMITS.previewPageMaxBytes + 64);
  });

  it("reports the combined upstream+local truncation flag in details and metadata", async () => {
    const server = await startGateway(async () => ({
      requestId: "req-fetch-truncated",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [
        {
          status: "ok" as const,
          url: "https://example.com/t",
          finalUrl: null,
          contentKind: "extracted" as const,
          completeness: "unknown" as const,
          content: "short extracted body",
          sourceFetchedAt: null,
          previewTruncated: false,
          artifactTruncated: true,
          upstreamTruncated: null,
        },
      ],
    }));
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const result = await requireTool(tools, "web_fetch").execute(
      "id",
      { urls: ["https://example.com/t"] } as never,
      undefined,
      undefined,
      { cwd },
    );
    const artifacts = result.details.artifacts as Array<{ path: string; artifactTruncated: boolean }>;
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    if (!artifact) throw new Error("expected one saved artifact");
    expect(artifact.artifactTruncated).toBe(true);
    expect(resultText(result)).toContain("stored content truncated");
    const metadata = JSON.parse(await readFile(join(cwd, artifact.path, "..", "metadata.json"), "utf8"));
    expect(metadata.pages[0].artifactTruncated).toBe(true);
  });

  it("fails bounded on an oversize prior index without reading or overwriting it", async () => {
    const url = "https://example.com/page";
    const server = await startGateway(async () => ({
      requestId: "req-oversize-index",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [
        {
          status: "ok" as const,
          url,
          finalUrl: null,
          contentKind: "extracted" as const,
          completeness: "unknown" as const,
          content: "bounded body",
          sourceFetchedAt: null,
          previewTruncated: false,
          artifactTruncated: false,
          upstreamTruncated: null,
        },
      ],
    }));
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const directory = join(cwd, ".opentag", "web", deriveWebToolIdentity(server.socketPath, "id"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // One byte past the fixed metadata read cap: unreadable by design, never allocated.
    const oversizeIndex = Buffer.alloc(64 * 1024 + 1, 0x7b);
    await writeFile(join(directory, "metadata.json"), oversizeIndex);

    await expect(
      requireTool(tools, "web_fetch").execute("id", { urls: [url] } as never, undefined, undefined, { cwd }),
    ).rejects.toThrow(/bounded regular file/);
    // The unreadable index is untouched and this attempt's page files are withdrawn.
    expect(await readFile(join(directory, "metadata.json"))).toEqual(oversizeIndex);
    expect(await readdir(directory)).toEqual(["metadata.json"]);
  });

  it("rejects results for unrequested URLs instead of borrowing content", async () => {
    const server = await startGateway(async () => ({
      requestId: "req-fetch-2",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [
        {
          status: "ok" as const,
          url: "https://evil.example.com/",
          finalUrl: null,
          contentKind: "extracted" as const,
          completeness: "unknown" as const,
          content: "borrowed",
          sourceFetchedAt: null,
          previewTruncated: false,
          artifactTruncated: false,
          upstreamTruncated: null,
        },
      ],
    }));
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    await expect(
      requireTool(tools, "web_fetch").execute("id", { urls: ["https://example.com"] } as never, undefined, undefined, {
        cwd,
      }),
    ).rejects.toThrow(/unrequested or duplicated URL/);
    // Cancellation/failure cleanup: no leftover artifact directory.
    const store = join(cwd, ".opentag", "web");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(store).catch(() => []));
    expect(entries).toEqual([]);
  });

  it("cleans up artifacts when the call is aborted mid-flight", async () => {
    const server = await startGateway(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const cwd = await workspace();
    const tools = loadTools(server.socketPath);
    const abort = new AbortController();
    const pending = requireTool(tools, "web_fetch").execute(
      "id",
      { urls: ["https://example.com"] } as never,
      abort.signal,
      undefined,
      { cwd },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    abort.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/aborted/);
    const store = join(cwd, ".opentag", "web");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(store).catch(() => []));
    expect(entries).toEqual([]);
  });
});

describe("artifact store", () => {
  const artifactId = deriveWebToolIdentity("/synthetic/artifact-store/gateway.sock", "artifact-store-call");

  it("resists symlinked store components and rejects unsafe ids and file names", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await symlink(outside, join(cwd, ".opentag"));
    await expect(
      saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "x" }),
    ).rejects.toThrow();
    // A hostile parent must never be created through, even partially.
    expect(await readFile(join(outside, "web", artifactId, "page-0.md")).catch(() => undefined)).toBeUndefined();
    await rm(join(cwd, ".opentag"));
    await expect(
      saveWebArtifact({ cwd, toolCallId: "../escape", fileName: "page-0.md", content: "x" }),
    ).rejects.toThrow(/Unsafe/);
    // Only the deterministic UUID-v5 shape derived per execution is accepted as a directory.
    await expect(
      saveWebArtifact({
        cwd,
        toolCallId: "6b1d0b6c-5f7a-4c0a-9a2f-2d5c3d2f0a11",
        fileName: "page-0.md",
        content: "x",
      }),
    ).rejects.toThrow(/Unsafe/);
    await expect(
      saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "../../escape.md", content: "x" }),
    ).rejects.toThrow(/Unsafe/);
  });

  it("writes atomically with bounded content and a verifiable digest", async () => {
    const cwd = await workspace();
    const content = "正文".repeat(100);
    const saved = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content });
    expect(saved.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(saved.artifactTruncated).toBe(false);
    const written = await readFile(join(cwd, saved.relativePath), "utf8");
    expect(written).toBe(content);
    // A second identical write replaces atomically rather than failing on existence.
    const again = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "next" });
    expect(await readFile(join(cwd, again.relativePath), "utf8")).toBe("next");

    const huge = "x".repeat(WEB_EXTENSION_LIMITS.pageBodyMaxBytes + 10);
    const bounded = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-1.md", content: huge });
    expect(bounded.artifactTruncated).toBe(true);
    expect(bounded.bytes).toBeLessThanOrEqual(WEB_EXTENSION_LIMITS.pageBodyMaxBytes);
  });

  it("honors an already-aborted deadline without writing", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      saveWebArtifact({
        cwd,
        toolCallId: artifactId,
        fileName: "page-0.md",
        content: "x",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(
      await readFile(join(cwd, ".opentag", "web", artifactId, "page-0.md")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("cleanup removes only explicitly tracked attempt files and preserves prior/concurrent artifacts", async () => {
    const cwd = await workspace();
    const saved = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "first" });
    const directory = join(cwd, ".opentag", "web", artifactId);
    // Another attempt's temp and publication files are not ours: they must survive.
    await writeFile(join(directory, "other-attempt.tmp"), "concurrent fixture");
    await writeFile(join(directory, ".page-9.md.deadbeef.tmp"), "foreign temp fixture");
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(["page-0.md"]),
      writtenThisAttempt: new Set(),
    });
    expect(await readFile(join(directory, "other-attempt.tmp"), "utf8")).toBe("concurrent fixture");
    expect(await readFile(join(directory, ".page-9.md.deadbeef.tmp"), "utf8")).toBe("foreign temp fixture");
    expect(await readFile(join(cwd, saved.relativePath), "utf8")).toBe("first");
    // Explicitly registered names are removed: tracked temp files and pages without prior owners.
    await writeFile(join(directory, ".tracked.tmp"), "mine");
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(),
      writtenThisAttempt: new Set(["page-0.md"]),
      tempFiles: new Set([".tracked.tmp"]),
    });
    expect(await readFile(join(cwd, saved.relativePath)).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(directory, ".tracked.tmp")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(directory, "other-attempt.tmp"), "utf8")).toBe("concurrent fixture");
    expect(await readFile(join(directory, ".page-9.md.deadbeef.tmp"), "utf8")).toBe("foreign temp fixture");
  });

  it("cleanup never traverses a symlinked store and preserves finalized or self-published files", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    const foreignDirectory = join(outside, "web", artifactId);
    await mkdir(foreignDirectory, { recursive: true });
    await writeFile(join(foreignDirectory, "untouched.tmp"), "foreign fixture");
    await symlink(outside, join(cwd, ".opentag"));
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(),
      writtenThisAttempt: new Set(["page-0.md"]),
      tempFiles: new Set(["untouched.tmp"]),
    });
    // Intermediate symlink rejected: nothing outside the workspace is removed, ledger or not.
    expect(await readFile(join(foreignDirectory, "untouched.tmp"), "utf8")).toBe("foreign fixture");
    await rm(join(cwd, ".opentag"));
    // A finalized index from an earlier attempt protects the pages it references.
    const saved = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "prior" });
    await writeFile(
      join(cwd, ".opentag", "web", artifactId, "metadata.json"),
      `${JSON.stringify({ pages: [{ file: "page-0.md" }] })}\n`,
    );
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(),
      writtenThisAttempt: new Set(["page-0.md"]),
    });
    expect(await readFile(join(cwd, saved.relativePath), "utf8")).toBe("prior");
    // When this attempt published the index itself, cleanup withdraws its own index and pages.
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(),
      writtenThisAttempt: new Set(["page-0.md"]),
      publishedMetadata: true,
    });
    expect(await readFile(join(cwd, saved.relativePath)).catch(() => undefined)).toBeUndefined();
    expect(
      await readFile(join(cwd, ".opentag", "web", artifactId, "metadata.json")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("fails bounded on an unsafe or oversize existing artifact instead of reading it", async () => {
    const cwd = await workspace();
    const directory = join(cwd, ".opentag", "web", artifactId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Oversize page: never read or allocated, reported unsaved, and left untouched.
    const oversizePage = Buffer.alloc(WEB_EXTENSION_LIMITS.pageBodyMaxBytes + 1, 0x61);
    await writeFile(join(directory, "page-0.md"), oversizePage);
    await expect(
      saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "bounded replacement" }),
    ).rejects.toThrow(/bounded regular file/);
    expect(await readFile(join(directory, "page-0.md"))).toEqual(oversizePage);

    // Symlinked entry: O_NOFOLLOW rejects it and the outside target is never written through.
    const outside = await workspace();
    await writeFile(join(outside, "target.md"), "outside fixture");
    await rm(join(directory, "page-0.md"));
    await symlink(join(outside, "target.md"), join(directory, "page-0.md"));
    await expect(
      saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "bounded replacement" }),
    ).rejects.toThrow(/bounded regular file/);
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe("outside fixture");
  });

  it.skipIf(process.platform === "win32")("rejects a preexisting FIFO promptly without a writer", async () => {
    const cwd = await workspace();
    const directory = join(cwd, ".opentag", "web", artifactId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fifoPath = join(directory, "page-0.md");
    execFileSync("mkfifo", [fifoPath]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked waiting for a FIFO writer"), 2_000);
      });
      const outcome = await Promise.race([
        saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "bounded replacement" }).then(
          () => "resolved" as const,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
        timeout,
      ]);
      // O_NONBLOCK lets the open return so fstat rejects the FIFO; no writer exists in this test.
      expect(outcome).toMatch(/bounded regular file/);
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect((await lstat(fifoPath)).isFIFO()).toBe(true);
  });

  it("restores the prior finalized index when an attempt withdraws its own published index", async () => {
    const cwd = await workspace();
    const directory = join(cwd, ".opentag", "web", artifactId);
    const saved = await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "prior page" });
    const prior = `${JSON.stringify({ version: 1, pages: [{ file: "page-0.md" }] }, undefined, 2)}\n`;
    await writeFile(join(directory, "metadata.json"), prior);
    // A same-ID retry renamed its own index over the prior one and was then cancelled.
    const published = `${JSON.stringify({ version: 1, pages: [{ file: "page-0.md" }], requestId: "retry" }, undefined, 2)}\n`;
    await writeFile(join(directory, "metadata.json"), published);
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(["page-0.md", "metadata.json"]),
      writtenThisAttempt: new Set(),
      publishedMetadata: true,
      priorMetadata: Buffer.from(prior, "utf8"),
      publishedMetadataDigest: createHash("sha256").update(published, "utf8").digest("hex"),
    });
    expect(await readFile(join(directory, "metadata.json"), "utf8")).toBe(prior);
    expect(await readFile(join(cwd, saved.relativePath), "utf8")).toBe("prior page");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never clobbers a newer index another attempt published after ours", async () => {
    const cwd = await workspace();
    const directory = join(cwd, ".opentag", "web", artifactId);
    await saveWebArtifact({ cwd, toolCallId: artifactId, fileName: "page-0.md", content: "concurrent page" });
    const prior = `${JSON.stringify({ pages: [{ file: "page-0.md" }], requestId: "prior" })}\n`;
    const published = `${JSON.stringify({ pages: [{ file: "page-0.md" }], requestId: "ours" })}\n`;
    const concurrent = `${JSON.stringify({ pages: [{ file: "page-0.md" }], requestId: "concurrent" })}\n`;
    await writeFile(join(directory, "metadata.json"), concurrent);
    await cleanupWebArtifacts({
      cwd,
      toolCallId: artifactId,
      preExisting: new Set(["page-0.md", "metadata.json"]),
      writtenThisAttempt: new Set(),
      publishedMetadata: true,
      priorMetadata: Buffer.from(prior, "utf8"),
      publishedMetadataDigest: createHash("sha256").update(published, "utf8").digest("hex"),
    });
    expect(await readFile(join(directory, "metadata.json"), "utf8")).toBe(concurrent);
  });
});

describe("truncateToByteBudget", () => {
  it("never splits a UTF-8 codepoint and stays within budget including the marker", () => {
    const text = `${"a".repeat(100)}🙂${"b".repeat(100)}`;
    const budget = 100 + 1; // cut lands inside the 4-byte emoji
    const result = truncateToByteBudget(text, budget);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(budget);
    expect(result.text).not.toContain("🙂");
    expect(result.text.endsWith("…[truncated]")).toBe(true);
    const exact = truncateToByteBudget("short", 100);
    expect(exact).toEqual({ text: "short", truncated: false });
  });

  it("bounds multi-codeunit CJK text exactly", () => {
    const text = "漢".repeat(5000);
    const result = truncateToByteBudget(text, WEB_EXTENSION_LIMITS.previewPageMaxBytes);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(WEB_EXTENSION_LIMITS.previewPageMaxBytes);
    expect(result.text.endsWith("…[truncated]")).toBe(true);
  });
});
