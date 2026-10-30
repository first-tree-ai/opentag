import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ClaudeCodeAgentRuntimeFactory } from "@opentag/client";

const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "opentag-claude-native-"));
const workspace = join(home, "workspace");
const sibling = join(home, "sibling");
const configHome = join(home, "claude-config");
const market = join(home, "marketplace");
const plugin = join(market, "native-fixture");
const sameNamePlugin = join(market, "opentag");
const command = process.env.OPENTAG_CLAUDE_COMMAND ?? "claude";
const tools = {
  user: "mcp__opentag-mcp__user_echo",
  plugin: "mcp__plugin_native-fixture_plugin-tools__plugin_echo",
  collision: "mcp__plugin_opentag_opentag-mcp__collision_echo",
};
const mcpCalls = [];
const hostedCalls = [];
const reports = [];
const longToolNames = ["x".repeat(85), "x".repeat(110)];
let state;
let fixtureError;
let runtime;
let siblingRuntime;
let messageSequence = 0;

function sendMessage(response, content, stopReason) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const message = {
    id: `msg_fixture_${++messageSequence}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const events = [{ type: "message_start", message }];
  for (const [index, block] of content.entries()) {
    events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function serveMcp(request, response, body) {
  if (request.method !== "POST") return response.writeHead(405).end();
  const kind = request.url.split("/").at(-1);
  if (kind === "hanging") {
    state.hangingConnections = (state.hangingConnections ?? 0) + 1;
    return;
  }
  if (kind === "unauthorized") {
    state.unauthorizedConnections = (state.unauthorizedConnections ?? 0) + 1;
    return response.writeHead(401).end();
  }
  if (kind === "managed" && request.headers.authorization !== `Bearer ${state.token}`) {
    return response.writeHead(401).end();
  }
  if (body.id === undefined) return response.writeHead(202).end();
  let result;
  if (body.method === "initialize") {
    result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: kind, version: "1" } };
  } else if (body.method === "tools/list") {
    result = {
      tools: [`${kind}_echo`, ...(kind === "managed" ? longToolNames : [])].map((name) => ({
        name,
        description: `${kind} fixture`,
        inputSchema: { type: "object" },
      })),
    };
  } else {
    assert.equal(body.method, "tools/call");
    mcpCalls.push({
      kind,
      phase: state.phase,
      name: body.params.name,
      token: kind === "managed" ? state.token : undefined,
    });
    result = { content: [{ type: "text", text: `${kind}-ok` }] };
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
}

function serveModel(response, body) {
  const names = (body.tools ?? []).map((tool) => tool.name);
  if (names.some((name) => name.length > 128)) {
    fixtureError = new Error("Model-facing tool name exceeds 128 characters");
    return response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: fixtureError.message } }));
  }
  if (!state.catalog) {
    state.catalog = names;
    const serialized = JSON.stringify(body);
    state.projectSkill = serialized.includes("project-fixture");
    state.packagedSkill = /opentag-[a-f0-9]{16}:packaged-fixture/.test(serialized);
    state.duplicateProjectSkill = /opentag-[a-f0-9]{16}:project-fixture/.test(serialized);
    state.managedTool = names.find((name) => /^mcp__g[a-f0-9]{10}__managed_echo$/.test(name));
    state.hostedTool = names.find((name) => /^mcp__h[a-f0-9]{10}__hosted_echo$/.test(name));
  }
  if (state.phase.startsWith("enabled") && !state.issued) {
    const longTools = longToolNames.map((name) => state.managedTool.replace("managed_echo", name));
    const targets = [...Object.values(tools), state.managedTool, state.hostedTool, ...longTools];
    for (const name of targets) assert.ok(names.includes(name), `Missing native tool: ${name}`);
    state.issued = true;
    sendMessage(
      response,
      targets.map((name, index) => ({
        type: "tool_use",
        id: `tool_${state.phase}_${index}`,
        name,
        input: {},
      })),
      "tool_use",
    );
  } else {
    sendMessage(response, [{ type: "text", text: "native-plugin-fixture-ok" }], "end_turn");
  }
}

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.startsWith("/mcp/")) return serveMcp(request, response, body);
    if (request.url.includes("count_tokens")) {
      return response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
    }
    if (request.url.startsWith("/v1/messages")) return serveModel(response, body);
    response.writeHead(404).end("{}");
  } catch (error) {
    fixtureError = error;
    response
      .writeHead(500, { "content-type": "application/json" })
      .end('{"error":{"type":"api_error","message":"fixture failed"}}');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const environment = {
  PATH: process.env.PATH,
  HOME: home,
  CLAUDE_CONFIG_DIR: configHome,
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR,
  ANTHROPIC_API_KEY: "sk-ant-native-fixture",
  ANTHROPIC_BASE_URL: origin,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  PLUGIN_CUSTOM_OPTION: "native-option",
  CI: "1",
  MCP_TIMEOUT: "1000",
};
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
const endpoint = (kind) => ({ type: "http", url: `${origin}/mcp/${kind}` });
const settingsPath = join(workspace, ".claude", "settings.json");
const mcpPath = join(workspace, ".mcp.json");
const hookPath = join(workspace, "native-hook.json");

async function openRuntime(factory, cwd, skillPaths = []) {
  return factory.create({
    eventSink: () => {},
    systemPrompt: "Run only the local native-plugin fixture.",
    workspace: { cwd },
    skillPaths,
    configuration: { model: "claude-sonnet-4-6" },
    policy: { fileSystem: "unrestricted", network: "enabled", approvals: "never", tools: { mode: "provider-default" } },
    hostedTools: {
      definitions: [{ name: "hosted_echo", description: "Hosted fixture", inputSchema: { type: "object" } }],
      handler: async (call) => {
        hostedCalls.push(call.runId);
        return { success: true, content: [{ type: "text", text: "hosted-ok" }] };
      },
    },
  });
}

async function run(target, phase, token) {
  state = { phase, token, issued: false };
  const result = await target.prompt({
    runId: phase,
    input: { items: [{ type: "text", text: "Run the local fixture." }] },
    configuration: { provider: { mcpGateway: { url: `${origin}/mcp/managed`, token } } },
    signal: AbortSignal.timeout(phase === "unavailable-mcp" ? 20_000 : 90_000),
  });
  assert.equal(fixtureError, undefined);
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.ok(state.managedTool);
  assert.ok(state.hostedTool);
  reports.push({
    phase,
    nativePluginLoaded: state.catalog.includes(tools.plugin),
    userMcpLoaded: state.catalog.includes(tools.user),
    sameNamePluginLoaded: state.catalog.includes(tools.collision),
  });
  return state;
}

try {
  for (const directory of [
    workspace,
    sibling,
    configHome,
    join(market, ".claude-plugin"),
    join(plugin, ".claude-plugin"),
    join(plugin, "hooks"),
    join(plugin, "skills", "native-fixture"),
    join(sameNamePlugin, ".claude-plugin"),
    join(workspace, ".claude", "skills", "project-fixture"),
    join(home, "packaged-fixture"),
  ])
    await mkdir(directory, { recursive: true });
  const hook = join(plugin, "hook.mjs");
  await writeFile(
    hook,
    'import {existsSync,readFileSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const p=join(process.env.CLAUDE_PROJECT_DIR,"native-hook.json"); const count=existsSync(p)?JSON.parse(readFileSync(p,"utf8")).count:0; writeFileSync(p,JSON.stringify({count:count+1,option:process.env.PLUGIN_CUSTOM_OPTION}));',
  );
  await writeJson(join(plugin, ".claude-plugin", "plugin.json"), { name: "native-fixture", version: "1.0.0" });
  await writeJson(join(plugin, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] },
      ],
    },
  });
  await writeJson(join(plugin, ".mcp.json"), { mcpServers: { "plugin-tools": endpoint("plugin") } });
  await writeJson(join(sameNamePlugin, ".claude-plugin", "plugin.json"), { name: "opentag", version: "1.0.0" });
  await writeJson(join(sameNamePlugin, ".mcp.json"), { mcpServers: { "opentag-mcp": endpoint("collision") } });
  await writeJson(join(market, ".claude-plugin", "marketplace.json"), {
    name: "native-fixture-market",
    owner: { name: "OpenTag test" },
    plugins: [
      { name: "native-fixture", source: "./native-fixture" },
      { name: "opentag", source: "./opentag" },
    ],
  });
  for (const [path, name] of [
    [join(plugin, "skills", "native-fixture"), "native-fixture"],
    [join(workspace, ".claude", "skills", "project-fixture"), "project-fixture"],
    [join(home, "packaged-fixture"), "packaged-fixture"],
  ])
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Local native fixture\n---\nRun the fixture.\n`,
    );
  await writeJson(settingsPath, { enableAllProjectMcpServers: true });
  await writeJson(mcpPath, { mcpServers: { "opentag-mcp": endpoint("user") } });
  const execution = { cwd: workspace, env: environment, timeout: 30_000 };
  await exec(command, ["plugin", "marketplace", "add", market, "--scope", "project"], execution);
  await exec(command, ["plugin", "install", "native-fixture@native-fixture-market", "--scope", "project"], execution);
  await exec(command, ["plugin", "install", "opentag@native-fixture-market", "--scope", "project"], execution);
  const originalSettings = await readFile(settingsPath, "utf8");
  const originalMcp = await readFile(mcpPath, "utf8");
  const factory = new ClaudeCodeAgentRuntimeFactory({ process: { command, env: environment } });
  runtime = await openRuntime(factory, workspace, [
    join(workspace, ".claude", "skills", "project-fixture"),
    join(home, "packaged-fixture"),
  ]);
  const enabled = await run(runtime, "enabled-one", "otmg_fixture_one");
  assert.ok(enabled.projectSkill);
  assert.ok(enabled.packagedSkill);
  assert.equal(enabled.duplicateProjectSkill, false);
  await run(runtime, "enabled-two", "otmg_fixture_two");
  assert.equal(hostedCalls.length, 2);
  assert.deepEqual(
    [...new Set(mcpCalls.filter((call) => call.kind === "managed").map((call) => call.token))],
    ["otmg_fixture_one", "otmg_fixture_two"],
  );
  for (const kind of ["user", "plugin", "collision", "managed"])
    assert.equal(mcpCalls.filter((call) => call.kind === kind).length, kind === "managed" ? 6 : 2);
  for (const name of longToolNames)
    assert.equal(mcpCalls.filter((call) => call.kind === "managed" && call.name === name).length, 2);
  assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
  assert.equal(await readFile(mcpPath, "utf8"), originalMcp);
  const hookBeforeDisable = JSON.parse(await readFile(hookPath, "utf8"));
  assert.equal(hookBeforeDisable.count, 2);
  assert.equal(hookBeforeDisable.option, "native-option");
  await writeJson(settingsPath, {
    ...JSON.parse(originalSettings),
    enabledPlugins: { ...JSON.parse(originalSettings).enabledPlugins, "native-fixture@native-fixture-market": false },
  });
  const disabled = await run(runtime, "disabled", "otmg_fixture_disabled");
  assert.equal(disabled.catalog.includes(tools.plugin), false);
  assert.ok(disabled.catalog.includes(tools.collision));
  assert.deepEqual(JSON.parse(await readFile(hookPath, "utf8")), hookBeforeDisable);
  await writeJson(mcpPath, {
    mcpServers: {
      ...JSON.parse(originalMcp).mcpServers,
      hanging: endpoint("hanging"),
      unauthorized: endpoint("unauthorized"),
    },
  });
  const unavailableStarted = Date.now();
  const unavailable = await run(runtime, "unavailable-mcp", "otmg_fixture_unavailable");
  const unavailableDurationMs = Date.now() - unavailableStarted;
  assert.ok(unavailable.hangingConnections > 0);
  assert.ok(unavailable.unauthorizedConnections > 0);
  assert.ok(unavailable.catalog.includes(tools.user));
  assert.ok(unavailable.catalog.includes(tools.collision));
  await writeFile(mcpPath, originalMcp);
  await runtime.close();
  siblingRuntime = await openRuntime(factory, sibling);
  const isolated = await run(siblingRuntime, "sibling", "otmg_fixture_sibling");
  assert.equal(isolated.catalog.includes(tools.user), false);
  assert.equal(isolated.catalog.includes(tools.plugin), false);
  assert.equal(isolated.catalog.includes(tools.collision), false);
  assert.equal(await readFile(mcpPath, "utf8"), originalMcp);
  const version = (await exec(command, ["--version"], { env: environment })).stdout.trim();
  process.stdout.write(
    `${JSON.stringify({ ok: true, version, reports, nativeMcpCalls: mcpCalls.length, hostedCalls: hostedCalls.length, longToolCalls: 4, maxModelToolNameLength: 128, projectSkillLoadedOnce: true, hookCount: hookBeforeDisable.count, sharedFilesUnchanged: true, unavailableDurationMs })}\n`,
  );
} finally {
  await runtime?.close();
  await siblingRuntime?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
