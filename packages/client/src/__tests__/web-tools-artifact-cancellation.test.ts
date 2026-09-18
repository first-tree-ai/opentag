import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import webToolsExtension, { deriveWebToolIdentity, saveWebArtifact } from "../pi-extensions/web-tools.js";
import { type WebGatewayDispatch, WebToolsGatewayServer } from "../runtime/web-tools-gateway.js";

/**
 * The metadata/publication cancellation contract is reproduced against the real extension
 * callback and a real Unix-socket gateway, with only the filesystem calls instrumented so aborts
 * and renames can land deterministically at exact points. The hook is installed with `vi.mock`
 * because the extension imports `node:fs/promises` directly.
 */
const hook = vi.hoisted(() => ({
  afterWriteFile: undefined as ((path: string) => void) | undefined,
  afterRename: undefined as ((to: string) => void) | undefined,
  writeFileSignals: [] as Array<AbortSignal | null | undefined>,
  writeFilePaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const options = args[2] as { signal?: AbortSignal | null } | undefined;
      hook.writeFileSignals.push(options?.signal);
      hook.writeFilePaths.push(String(args[0]));
      await (actual.writeFile as unknown as (...callArgs: unknown[]) => Promise<void>)(...args);
      hook.afterWriteFile?.(String(args[0]));
    },
    rename: async (...args: unknown[]) => {
      await (actual.rename as unknown as (...callArgs: unknown[]) => Promise<void>)(...args);
      hook.afterRename?.(String(args[1]));
    },
  };
});

const roots: string[] = [];
const servers: WebToolsGatewayServer[] = [];

afterEach(async () => {
  hook.afterWriteFile = undefined;
  hook.afterRename = undefined;
  hook.writeFileSignals.length = 0;
  hook.writeFilePaths.length = 0;
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.OPENTAG_WEB_TOOLS_SOCKET;
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ot-web-artifact-cancel-"));
  roots.push(root);
  return root;
}

interface CapturedTool {
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
}

function loadFetchTool(): CapturedTool {
  const tools = new Map<string, CapturedTool>();
  webToolsExtension({
    registerTool: (tool) => tools.set(tool.name, tool as unknown as CapturedTool),
  });
  const tool = tools.get("web_fetch");
  if (!tool) throw new Error("web_fetch did not register");
  return tool;
}

async function startGateway(dispatch: WebGatewayDispatch): Promise<WebToolsGatewayServer> {
  const root = await mkdtemp(join(tmpdir(), "ot-web-artifact-cancel-gw-"));
  roots.push(root);
  const server = await WebToolsGatewayServer.start({ socketPath: join(root, "gateway.sock"), dispatch });
  servers.push(server);
  return server;
}

function fetchFixture(url: string) {
  return {
    requestId: "fixture-artifact-cancel",
    status: "ok" as const,
    retrievedAt: "2026-09-17T00:00:00.000Z",
    effectiveDepth: "basic" as const,
    results: [
      {
        status: "ok" as const,
        url,
        finalUrl: null,
        contentKind: "extracted" as const,
        completeness: "unknown" as const,
        content: "synthetic page body",
        sourceFetchedAt: null,
        previewTruncated: false,
        artifactTruncated: false,
        upstreamTruncated: null,
      },
    ],
  };
}

describe("web_fetch artifact cancellation", () => {
  it("passes the caller signal into the actual page writeFile call", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const toolCallId = deriveWebToolIdentity("/synthetic/signal-write.sock", "call_signal_write");
    const saved = await saveWebArtifact({
      cwd,
      toolCallId,
      fileName: "page-0.md",
      content: "signal-bound body",
      signal: controller.signal,
    });
    expect(saved.bytes).toBeGreaterThan(0);
    expect(hook.writeFileSignals).toHaveLength(1);
    expect(hook.writeFileSignals[0]).toBe(controller.signal);
  });

  it("fails and withdraws every attempt file when cancelled during the metadata temp write", async () => {
    const cwd = await workspace();
    const url = "https://example.com/page";
    const server = await startGateway(async () => fetchFixture(url));
    process.env.OPENTAG_WEB_TOOLS_SOCKET = server.socketPath;
    const controller = new AbortController();
    let hooked = false;
    let metadataWriteSignal: AbortSignal | null | undefined;
    hook.afterWriteFile = (path) => {
      if (path.includes(".metadata.json.")) {
        hooked = true;
        metadataWriteSignal = hook.writeFileSignals.at(-1);
        controller.abort(new Error("synthetic metadata cancellation"));
      }
    };
    const tool = loadFetchTool();
    const outcome = await tool
      .execute("call_metadata_cancel", { urls: [url] } as never, controller.signal, undefined, { cwd })
      .then(
        () => "resolved" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(outcome).not.toBe("resolved");
    expect(outcome).toMatch(/metadata cancellation/i);
    expect(hooked).toBe(true);
    // The writeFile call that wrote the temp file received the live operation signal, and the
    // caller abort is reflected on that same signal object.
    expect(metadataWriteSignal).toBeInstanceOf(AbortSignal);
    expect(metadataWriteSignal?.aborted).toBe(true);
    const toolCallId = deriveWebToolIdentity(server.socketPath, "call_metadata_cancel");
    const directory = join(cwd, ".opentag", "web", toolCallId);
    expect(await readFile(join(directory, "metadata.json")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(directory, "page-0.md")).catch(() => undefined)).toBeUndefined();
    expect((await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails and leaves no page or temp file when cancelled during a page temp write", async () => {
    const cwd = await workspace();
    const url = "https://example.com/page";
    const server = await startGateway(async () => fetchFixture(url));
    process.env.OPENTAG_WEB_TOOLS_SOCKET = server.socketPath;
    const controller = new AbortController();
    let hooked = false;
    let pageWriteSignal: AbortSignal | null | undefined;
    hook.afterWriteFile = (path) => {
      if (path.includes(".page-0.md.") && path.endsWith(".tmp")) {
        hooked = true;
        pageWriteSignal = hook.writeFileSignals.at(-1);
        controller.abort(new Error("synthetic page cancellation"));
      }
    };
    const tool = loadFetchTool();
    await expect(
      tool.execute("call_page_cancel", { urls: [url] } as never, controller.signal, undefined, { cwd }),
    ).rejects.toThrow(/page cancellation/i);
    expect(hooked).toBe(true);
    expect(pageWriteSignal).toBeInstanceOf(AbortSignal);
    expect(pageWriteSignal?.aborted).toBe(true);
    const toolCallId = deriveWebToolIdentity(server.socketPath, "call_page_cancel");
    const directory = join(cwd, ".opentag", "web", toolCallId);
    expect(await readFile(join(directory, "metadata.json")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(directory, "page-0.md")).catch(() => undefined)).toBeUndefined();
    expect((await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the prior completed index when a same-ID retry is cancelled after the metadata rename", async () => {
    const cwd = await workspace();
    const url = "https://example.com/page";
    const server = await startGateway(async () => fetchFixture(url));
    process.env.OPENTAG_WEB_TOOLS_SOCKET = server.socketPath;
    const tool = loadFetchTool();
    const first = await tool.execute("call_repeat_cancel", { urls: [url] } as never, undefined, undefined, { cwd });
    expect(first.details.metadataWritten).toBe(true);
    const toolCallId = deriveWebToolIdentity(server.socketPath, "call_repeat_cancel");
    const directory = join(cwd, ".opentag", "web", toolCallId);
    const priorMetadata = await readFile(join(directory, "metadata.json"), "utf8");
    const priorPage = await readFile(join(directory, "page-0.md"), "utf8");

    const controller = new AbortController();
    let renameHookFired = false;
    hook.writeFilePaths.length = 0;
    hook.afterRename = (to) => {
      if (to.endsWith("/metadata.json")) {
        renameHookFired = true;
        controller.abort(new Error("synthetic retry cancellation after metadata publication"));
      }
    };
    const outcome = await tool
      .execute("call_repeat_cancel", { urls: [url] } as never, controller.signal, undefined, { cwd })
      .then(
        () => "resolved" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(outcome).not.toBe("resolved");
    expect(renameHookFired).toBe(true);
    // The prior completed index and its page bytes survive the cancelled same-ID retry.
    expect(await readFile(join(directory, "metadata.json"), "utf8")).toBe(priorMetadata);
    expect(await readFile(join(directory, "page-0.md"), "utf8")).toBe(priorPage);
    // Identical finalized content is reused, not rewritten: the retry wrote no page temp file and
    // the restored index still references the untouched page.
    expect(hook.writeFilePaths.filter((path) => path.includes(".page-0.md."))).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
