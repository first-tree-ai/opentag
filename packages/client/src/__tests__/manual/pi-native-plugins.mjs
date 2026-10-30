import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PiAgentRuntimeFactory, PiRpcProcess, piAgentRuntimeEnvironment, WebToolsGatewayServer } from "@opentag/client";

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "otpn-")));
const workspace = join(root, "workspace");
const sibling = join(root, "sibling");
const piHome = join(root, "pi");
const sessions = join(root, "sessions");
const nativePackage = join(workspace, ".pi", "native-package");
const extensionLog = join(root, "extensions.jsonl");
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const command = process.execPath;
const cli = join(dirname(piEntry), "cli.js");
const adapterEntry = fileURLToPath(import.meta.resolve("pi-mcp-adapter"));
const calls = [];
const modelCalls = [];
const reports = [];
const webCalls = [];
let webGateway;
let toolSequence = [];
let token = "otmg_fixture_one";
let runtime;
let rpc;
let fixtureError;

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") return response.writeHead(405, { allow: "POST" }).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url.startsWith("/v1")) {
      serveModel(response, body);
      return;
    }
    serveMcp(request, response, body);
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});

function serveModel(response, body) {
  modelCalls.push(body);
  let tool = toolSequence.shift();
  if (tool?.name === "connect-managed") {
    const name = JSON.stringify(body.messages.at(-1)).match(/\bg[0-9a-f]{16}\b/)?.[0];
    assert(name, "Runtime MCP server must be discoverable through the native catalog");
    tool = { name: "mcp", arguments: JSON.stringify({ connect: name }) };
  }
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [{ index: 0, id: `tool-${modelCalls.length}`, type: "function", function: tool }],
      }
    : { role: "assistant", content: "native-ok" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

function serveMcp(request, response, body) {
  const native = request.url === "/native";
  const authorization = request.headers.authorization;
  calls.push({ native, method: body.method, params: body.params, authorization });
  if (authorization !== `Bearer ${native ? "native-user-key" : token}`) return response.writeHead(401).end();
  if (body.id === undefined) return response.writeHead(202).end();
  const result =
    body.method === "initialize"
      ? {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : body.method === "tools/list"
        ? {
            tools: [
              {
                name: native ? "native_ping" : "managed_ping",
                description: "Fixture ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        : { content: [{ type: "text", text: native ? "native-pong" : "managed-pong" }] };
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : [],
    ),
  );
  return nested.flat();
}
const policy = {
  approvals: "never",
  fileSystem: "unrestricted",
  network: "enabled",
  tools: { mode: "provider-default" },
};
try {
  await Promise.all([workspace, sibling, piHome, sessions].map((path) => mkdir(path, { recursive: true })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const socketPath = join(root, "web.sock");
  webGateway = await WebToolsGatewayServer.start({
    socketPath,
    dispatch: async (input) => {
      assert.equal(input.operation, "search");
      webCalls.push(input);
      return {
        requestId: "native-web-fixture",
        status: "ok",
        retrievedAt: "2026-10-30T00:00:00Z",
        effectiveDepth: "basic",
        results: [
          { sourceId: "s1", title: "Native web fixture", url: "https://fixture.example", snippet: "web-fixture-ok" },
        ],
      };
    },
  });
  const webTools = {
    extensionPath: join(
      dirname(fileURLToPath(import.meta.resolve("@opentag/client"))),
      "pi-extensions",
      "web-tools.mjs",
    ),
    socketPath,
  };
  const environment = piAgentRuntimeEnvironment({
    HOME: root,
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: piHome,
    NATIVE_PLUGIN_SECRET: "custom-plugin-value",
  });
  await put(join(piHome, "models.json"), {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: `${base}/v1`,
        models: [{ id: "mock", name: "mock", contextWindow: 128000, maxTokens: 2048 }],
      },
    },
  });
  await put(join(piHome, "auth.json"), { fixture: { type: "api_key", key: "fixture-key" } });
  await put(join(workspace, "AGENTS.md"), "Native project context sentinel: pi-project-context\n");
  await put(
    join(workspace, ".pi", "skills", "native-skill", "SKILL.md"),
    "---\nname: native-skill\ndescription: Native fixture skill\n---\nNative skill content\n",
  );
  await put(
    join(workspace, ".pi", "prompts", "native-prompt.md"),
    "Native prompt expansion sentinel: pi-native-template $@\n",
  );
  await put(join(nativePackage, "package.json"), {
    name: "pi-native-fixture",
    version: "1.0.0",
    pi: { extensions: ["extension.ts"] },
  });
  await put(
    join(nativePackage, "extension.ts"),
    `export default function(pi) { pi.registerCommand("native-package", { description: "Package fixture", handler: async () => {} }); }`,
  );
  await put(
    join(workspace, ".pi", "extensions", "native.ts"),
    `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      const record = (value) => appendFileSync(${JSON.stringify(extensionLog)}, JSON.stringify(value) + "\\n");
      pi.on("session_start", () => record({ type: "start", secret: process.env.NATIVE_PLUGIN_SECRET }));
      pi.on("before_agent_start", (_event, ctx) => {
        ctx.ui.notify("Native notice", "info"); ctx.ui.setStatus("native", "ready");
        ctx.ui.setWidget("native", ["Native widget"]); ctx.ui.setTitle("Native title");
        ctx.ui.setEditorText("Native editor text"); ctx.ui.pasteToEditor("Native pasted text");
      });
      pi.registerTool({ name: "native_probe", label: "Native probe", description: "Local plugin fixture", parameters: { type: "object", properties: {} }, execute: async () => {
        record({ type: "tool", secret: process.env.NATIVE_PLUGIN_SECRET });
        return { content: [{ type: "text", text: "native-tool-ok" }], details: {} };
      }});
      pi.registerCommand("native-command", { description: "Consumed command", handler: async (_args, ctx) => {
        record({ type: "command" }); ctx.ui.notify("Command ran", "info");
        pi.sendMessage({ customType: "fixture", content: "native custom message", display: true });
      }});
      pi.registerCommand("native-throw", { description: "Throwing command", handler: async () => { throw new Error("fixture command error"); }});
      pi.on("input", (event) => { if (event.text === "consume-input") { record({ type: "input" }); return { action: "handled" }; } });
    }
  `,
  );
  const nativeConfigPath = join(workspace, ".pi", "native-mcp.json");
  await put(nativeConfigPath, {
    mcpServers: {
      "opentag-mcp": {
        url: `${base}/native`,
        auth: "bearer",
        bearerToken: "native-user-key",
        protocolVersion: "legacy",
        directTools: false,
      },
    },
    settings: { scriptMode: false },
  });
  const nativeConfig = await readFile(nativeConfigPath, "utf8");
  await put(
    join(workspace, ".pi", "extensions", "user-mcp.ts"),
    `import { createMcpAdapter } from ${JSON.stringify(adapterEntry)}; export default createMcpAdapter({ configPath: ${JSON.stringify(nativeConfigPath)} });`,
  );
  const installed = await exec(command, [cli, "install", "-l", nativePackage, "--approve"], {
    cwd: workspace,
    env: environment,
    timeout: 30000,
  });
  assert.match(installed.stdout, /installed|added/i);
  const settingsPath = join(workspace, ".pi", "settings.json");
  const settings = await readFile(settingsPath, "utf8");
  assert.match(settings, /native-package/);
  const factory = new PiAgentRuntimeFactory({
    nativeResources: true,
    process: { command, args: [cli], env: environment, sessionDirectory: sessions },
  });
  const make = async (cwd = workspace, managed = true) => {
    const events = [];
    runtime = await factory.create({
      eventSink: (event) => {
        events.push(event);
      },
      workspace: { cwd },
      systemPrompt: "Managed system sentinel: pi-managed-context",
      policy,
      configuration: {
        model: "fixture/mock",
        ...(managed ? { provider: { mcpGateway: { url: `${base}/api/v1/mcp`, token }, webTools } } : {}),
      },
    });
    return events;
  };
  const prompt = (text, runId, configuration) =>
    runtime.prompt({
      runId,
      configuration,
      input: { items: [{ type: "text", text }] },
      signal: AbortSignal.timeout(30000),
    });
  const mcpTool = (name) => ({ name: "mcp", arguments: JSON.stringify({ tool: name, args: {} }) });
  const events = await make();
  let firstBinding;
  for (const phase of ["first", "rotated"]) {
    if (phase === "rotated") token = "otmg_fixture_two";
    events.splice(0);
    toolSequence = [
      { name: "native_probe", arguments: "{}" },
      { name: "web_search", arguments: JSON.stringify({ query: "native web coexistence" }) },
      mcpTool("native_ping"),
      { name: "mcp", arguments: "{}" },
      { name: "connect-managed" },
      mcpTool("managed_ping"),
    ];
    const result = await prompt("Exercise native resources and both MCP services", phase, {
      provider: { mcpGateway: { url: `${base}/api/v1/mcp`, token }, webTools },
    });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.output[0].text, "native-ok");
    assert(events.some((event) => event.type === "provider_event" && event.payload.method === "notify"));
    for (const text of ["Native editor text", "Native pasted text"]) {
      assert(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.payload.method === "set_editor_text" &&
            event.payload.text === text,
        ),
      );
    }
    assert(
      !events.some((event) => event.type === "provider_warning" && event.code === "pi_extension_error"),
      JSON.stringify(events),
    );
    if (firstBinding) assert.deepEqual(runtime.binding, firstBinding);
    else firstBinding = runtime.binding;
    reports.push({ phase, status: result.status });
  }
  await runtime.close();
  runtime = undefined;
  assert.equal(webCalls.length, 2);
  const toolCalls = calls.filter((call) => call.method === "tools/call");
  assert.equal(toolCalls.filter((call) => call.native).length, 2, JSON.stringify(toolCalls));
  assert.deepEqual(
    toolCalls.filter((call) => !call.native).map((call) => call.authorization),
    ["Bearer otmg_fixture_one", "Bearer otmg_fixture_two"],
  );
  for (const call of modelCalls) {
    const names = call.tools.map((tool) => tool.function.name);
    assert.equal(names.filter((name) => name === "mcp").length, 1);
    assert(names.includes("native_probe"));
    const serialized = JSON.stringify(call);
    assert.match(serialized, /pi-project-context/);
    assert.match(serialized, /pi-managed-context/);
    assert(!serialized.includes("otmg_fixture_"));
  }
  rpc = new PiRpcProcess({
    command,
    args: [
      cli,
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      "--skill",
      join(workspace, ".pi", "skills", "native-skill"),
    ],
    cwd: workspace,
    env: environment,
  });
  const catalog = await rpc.request({ type: "get_commands" });
  for (const name of ["native-package", "native-prompt", "skill:native-skill"])
    assert.equal(catalog.commands.filter((entry) => entry.name === name).length, 1, JSON.stringify(catalog));
  await rpc.close();
  rpc = undefined;
  const disabledSettings = JSON.parse(settings);
  disabledSettings.packages = [{ source: nativePackage, extensions: [] }];
  await put(settingsPath, disabledSettings);
  rpc = new PiRpcProcess({
    command,
    args: [cli, "--mode", "rpc", "--no-session", "--approve"],
    cwd: workspace,
    env: environment,
  });
  const disabledCatalog = await rpc.request({ type: "get_commands" });
  assert(!disabledCatalog.commands.some((entry) => entry.name === "native-package"));
  assert(disabledCatalog.commands.some((entry) => entry.name === "native-command"));
  await rpc.close();
  rpc = undefined;
  await writeFile(settingsPath, settings);
  for (const text of ["/native-command", "/native-throw", "consume-input"]) {
    const count = modelCalls.length;
    const events = await make(workspace, false);
    const result = await prompt(text, `consumed-${count}`);
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.error.code, "provider_request_rejected");
    assert.match(result.error.message, /side effects/);
    assert.equal(modelCalls.length, count);
    if (text === "/native-command")
      assert(events.some((event) => event.type === "provider_event" && event.payload.message?.role === "custom"));
    if (text === "/native-throw")
      assert(events.some((event) => event.type === "provider_warning" && event.message === "fixture command error"));
    await runtime.close();
    runtime = undefined;
    reports.push({ phase: text, status: result.status, code: result.error.code });
  }
  await make(workspace, false);
  const template = await prompt("/native-prompt expanded-value", "template");
  assert.equal(template.status, "completed", JSON.stringify(template));
  assert.match(JSON.stringify(modelCalls.at(-1)), /pi-native-template expanded-value/);
  await runtime.close();
  runtime = undefined;
  await make(sibling, false);
  assert.equal((await prompt("Sibling run", "sibling")).status, "completed");
  assert(!JSON.stringify(modelCalls.at(-1)).includes("pi-project-context"));
  assert(!modelCalls.at(-1).tools.some((tool) => tool.function.name === "native_probe"));
  await runtime.close();
  runtime = undefined;
  const beforeProbe = await readFile(extensionLog, "utf8");
  await factory.getConfigurationOptions({ cwd: workspace });
  assert.equal(await readFile(extensionLog, "utf8"), beforeProbe);
  assert.equal(await readFile(nativeConfigPath, "utf8"), nativeConfig);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.equal(await exists(join(piHome, "trust.json")), false);
  const persisted = (await Promise.all((await files(root)).map((path) => readFile(path, "utf8")))).join("\n");
  assert(!persisted.includes("otmg_fixture_"));
  assert.match(await readFile(extensionLog, "utf8"), /custom-plugin-value/);
  assert.equal(fixtureError, undefined);
  reports.push({ phase: "catalog, templates, sibling isolation, query isolation, config and trust", status: "passed" });
  console.log(
    JSON.stringify(
      {
        piVersion: (await exec(command, [cli, "--version"], { env: environment })).stdout.trim(),
        reports,
        modelCalls: modelCalls.length,
        mcpToolCalls: toolCalls.length,
      },
      null,
      2,
    ),
  );
} finally {
  await runtime?.close();
  await rpc?.close();
  await webGateway?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.env.OPENTAG_KEEP_PI_NATIVE_FIXTURE === "1") console.log(`Fixture: ${root}`);
  else await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
