import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Handler = (event: SessionStartEvent, context: ExtensionContext) => Promise<unknown> | unknown;
async function load(native: boolean, installed: boolean, compiled = false) {
  const root = await mkdtemp(join(tmpdir(), "ot-pi-gateway-"));
  roots.push(root);
  const adapter = join(root, compiled ? "opentag-runtime.mjs" : "adapter.mjs");
  await writeFile(
    adapter,
    `
    export function registerMcpServer({pi, name, definition}) {
      if (!${installed}) throw new Error("No runtime registrar");
      pi.events.emit("registered", {name, definition});
      return { dispose: async () => pi.events.emit("disposed", {}) };
    }
    export function createMcpAdapter({config}) { return (pi) => {
      pi.events.emit("installed", config);
      pi.registerTool({name: "mcp"});
      pi.on("session_start", async (_event, ctx) => { ctx.ui.notify("adapter start", "info"); });
      pi.on("session_shutdown", async (_event, ctx) => { ctx.ui.notify("adapter stop", "info"); });
    }; }
  `,
  );
  vi.stubEnv("OPENTAG_PI_NATIVE_RESOURCES", native ? "1" : "0");
  vi.stubEnv("OPENTAG_MCP_GATEWAY_URL", "https://fixture.example/api/v1/mcp");
  vi.stubEnv("OPENTAG_MCP_GATEWAY_TOKEN", "otmg_fixture");
  vi.stubEnv("OPENTAG_PI_MCP_ADAPTER_ENTRY", adapter);
  const { default: extension } = await import("../pi-extensions/mcp-gateway.js");
  const handlers = new Map<string, Handler[]>();
  const tools: { name: string }[] = [];
  const commands: { name: string }[] = [];
  const emit = vi.fn();
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: { name: string }) => tools.push(tool),
    getAllTools: () => tools,
    getCommands: () => commands,
    events: { emit },
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const context = { ui: { notify } } as unknown as ExtensionContext;
  const fire = async (type: string) => {
    for (const handler of [...(handlers.get(type) ?? [])]) {
      await handler({ type, reason: "startup" } as SessionStartEvent, context);
    }
  };
  return { extension: () => extension(api), api, tools, commands, emit, notify, fire };
}

it.each([false, true])("keeps Cloud's one isolated adapter (precompiled: %s)", async (compiled) => {
  const fixture = await load(false, false, compiled);
  fixture.extension();
  expect(fixture.emit).toHaveBeenCalledWith(
    "installed",
    expect.objectContaining({
      mcpServers: { "opentag-mcp": expect.objectContaining({ bearerToken: "otmg_fixture" }) },
    }),
  );
  await fixture.fire("session_start");
  expect(fixture.notify).toHaveBeenCalledWith("adapter start", "info");
});

it("registers with the existing native adapter after all factories load and disposes only its registration", async () => {
  const fixture = await load(true, true);
  fixture.extension();
  expect(fixture.emit).not.toHaveBeenCalled();
  fixture.tools.push({ name: "mcp" });
  await fixture.fire("session_start");
  expect(fixture.emit).toHaveBeenCalledWith(
    "registered",
    expect.objectContaining({ name: expect.stringMatching(/^g[0-9a-f]{16}$/) }),
  );
  expect(fixture.tools).toEqual([{ name: "mcp" }]);
  await fixture.fire("session_start");
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  await fixture.fire("session_shutdown");
  expect(fixture.emit).toHaveBeenLastCalledWith("disposed", {});
});

it.each(["tool", "command"])(
  "preserves an incompatible native %s namespace without installing a second adapter",
  async (kind) => {
    const fixture = await load(true, false);
    fixture.extension();
    if (kind === "tool") fixture.tools.push({ name: "mcp" });
    else fixture.commands.push({ name: "mcp-auth" });
    await fixture.fire("session_start");
    expect(fixture.emit).not.toHaveBeenCalled();
    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringContaining("does not support runtime registration"),
      "warning",
    );
  },
);

it("bootstraps a platform-only fallback once, without rerunning native startup handlers", async () => {
  const fixture = await load(true, false);
  fixture.extension();
  const nativeStart = vi.fn();
  fixture.api.on("session_start", nativeStart);
  await fixture.fire("session_start");
  expect(nativeStart).toHaveBeenCalledTimes(1);
  expect(fixture.tools).toEqual([{ name: "mcp" }]);
  expect(fixture.notify).toHaveBeenCalledTimes(1);
  const config = fixture.emit.mock.calls[0]?.[1] as { mcpServers: Record<string, unknown> };
  expect(Object.keys(config.mcpServers)).toEqual([expect.stringMatching(/^g[0-9a-f]{16}$/)]);
  await fixture.fire("session_start");
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  expect(nativeStart).toHaveBeenCalledTimes(2);
  expect(fixture.notify).toHaveBeenCalledTimes(2);
  await fixture.fire("session_shutdown");
  expect(fixture.notify).toHaveBeenLastCalledWith("adapter stop", "info");
});

it.each(["before module timing", "after module timing"])("isolates broken diagnostic stderr %s", async (failureAt) => {
  const stderr = new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error("stderr closed"), { code: "EPIPE" }));
    },
  });
  const closed = new Promise<void>((resolve) => stderr.once("close", resolve));
  vi.spyOn(process, "stderr", "get").mockReturnValue(stderr as typeof process.stderr);
  vi.stubEnv("OPENTAG_PI_STARTUP_DIAGNOSTICS", "1");

  if (failureAt === "before module timing") {
    const { createPiDiagnosticStderrWriter } = await import("../observability/pi-diagnostic-stderr.js");
    createPiDiagnosticStderrWriter(stderr)("prime stderr failure");
    await closed;
  }

  const fixture = await load(true, false);
  await closed;
  fixture.extension();
  await expect(fixture.fire("session_start")).resolves.toBeUndefined();
  expect(fixture.notify).toHaveBeenCalledWith("adapter start", "info");

  const originalError = new Error("gateway startup failed");
  fixture.notify.mockImplementationOnce(() => {
    throw originalError;
  });
  await expect(fixture.fire("session_start")).rejects.toBe(originalError);
});
