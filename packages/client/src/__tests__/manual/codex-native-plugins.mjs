import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CodexAgentRuntimeFactory, codexAgentRuntimeEnvironment } from "@opentag/client";

const exec = promisify(execFile);
const home = await realpath(await mkdtemp(join(tmpdir(), "otcn-")));
const workspace = join(home, "workspace");
const sibling = join(home, "sibling");
const configHome = join(home, "codex");
const marketplace = join(home, "marketplace");
const plugin = join(marketplace, "plugins", "native-fixture");
const command = process.env.OPENTAG_CODEX_COMMAND ?? "codex";
const calls = [];
const hostedCalls = [];
const reports = [];
const tokens = [
  "otmg_fixture_one",
  "otmg_fixture_two",
  "otmg_fixture_failed",
  "otmg_fixture_hanging",
  "otmg_fixture_cancelled",
  "otmg_fixture_recovered",
];
const hookPath = join(home, "hook.json");
const stdioLog = join(home, "stdio.jsonl");
const projectConfigPath = join(workspace, ".codex", "config.toml");
let state;
let fixtureError;
let runtime;
let siblingRuntime;
let socketRuntime;
const socketServers = [];
let messageSequence = 0;

function sendResponse(response, items) {
  const id = `resp_fixture_${++messageSequence}`;
  const result = {
    id,
    object: "response",
    model: "gpt-5.1-codex",
    status: "completed",
    output: items,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events = [{ type: "response.created", response: { ...result, status: "in_progress", output: [] } }];
  for (const [index, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index: index, item });
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response: result });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function serveMcp(request, response, body) {
  if (request.method !== "POST") return response.writeHead(405).end();
  const kind = request.url.split("/").at(-1);
  if (kind === "rejected") return response.writeHead(401).end();
  if (kind === "hanging") {
    const abort = state.abort;
    delete state.abort;
    if (abort) setTimeout(abort, 25);
    return;
  }
  if (kind === "managed" && request.headers.authorization !== `Bearer ${state.token}`)
    return response.writeHead(401).end();
  if (body.id === undefined) return response.writeHead(202).end();
  const collection = {
    "resources/list": "resources",
    "resources/templates/list": "resourceTemplates",
    "prompts/list": "prompts",
  }[body.method];
  let result = {};
  if (body.method === "initialize")
    result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: kind, version: "1" } };
  else if (body.method === "tools/list")
    result = {
      tools: [
        {
          name: `${kind}_echo`,
          description: `${kind} fixture`,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    };
  else if (collection) result = { [collection]: [] };
  else if (body.method === "tools/call") {
    calls.push({ kind, phase: state.phase, token: kind === "managed" ? state.token : undefined });
    result = { content: [{ type: "text", text: `${kind}-ok` }] };
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
}

function serveModel(response, body) {
  const namespaces = (body.tools ?? []).filter((tool) => tool.type === "namespace");
  const names = namespaces.map((tool) => tool.name);
  if (!state.catalog) {
    state.catalog = names;
    state.managed = names.find((name) => /^mcp__g[a-f0-9]{10}$/.test(name));
    state.skillContextPresent = JSON.stringify(body).includes("NATIVE_SKILL_MARKER_742");
  }
  if (!state.issued) {
    assert.ok(names.includes("mcp__opentag_mcp"), "Missing user MCP");
    assert.equal(names.includes("mcp__plugin"), state.pluginEnabled, "Native plugin enablement differs");
    assert.equal(names.includes("mcp__stdio"), state.pluginEnabled, "Missing native stdio MCP");
    assert.equal(Boolean(state.managed), state.gatewayEnabled, "Platform attach/fallback differs");
    const targets = [{ namespace: "mcp__opentag_mcp", name: "user_echo", arguments: "{}" }];
    if (state.pluginEnabled)
      targets.push(
        { namespace: "mcp__plugin", name: "plugin_echo", arguments: "{}" },
        { namespace: "mcp__stdio", name: "stdio_echo", arguments: "{}" },
      );
    if (state.managed) targets.push({ namespace: state.managed, name: "managed_echo", arguments: "{}" });
    targets.push({ name: "hosted_echo", arguments: "{}" });
    const script = state.socketPath
      ? `const net=require("node:net");const s=net.createConnection(${JSON.stringify(state.socketPath)});s.on("data",d=>process.stdout.write(d));s.on("error",e=>{console.error(e.code);process.exitCode=1});s.setTimeout(1500,()=>s.destroy());`
      : 'process.stdout.write("EXEC_ENV="+process.env.PLUGIN_CUSTOM_OPTION)';
    targets.push({
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        yield_time_ms: 1000,
        max_output_tokens: 100,
      }),
    });
    state.issued = true;
    return sendResponse(
      response,
      targets.map((target, index) => ({
        type: "function_call",
        id: `fc_${messageSequence}_${index}`,
        call_id: `call_${state.phase}_${index}`,
        ...target,
      })),
    );
  }
  assert.ok(
    JSON.stringify(body.input).includes(state.socketPath ? `SOCKET=${state.phase}` : "EXEC_ENV=native-option"),
    "Native shell environment or exact socket permission missing",
  );
  sendResponse(response, [
    {
      type: "message",
      id: `msg_${messageSequence}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "codex-native-fixture-ok", annotations: [] }],
    },
  ]);
}

const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.startsWith("/mcp/")) return serveMcp(request, response, body);
    if (request.url.startsWith("/v1/responses")) return serveModel(response, body);
    response.writeHead(404).end("{}");
  } catch (error) {
    fixtureError = error;
    response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { type: "invalid_request_error", message: String(error) } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const environment = codexAgentRuntimeEnvironment({
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: configHome,
  TMPDIR: process.env.TMPDIR,
  LANG: "en_US.UTF-8",
  PLUGIN_CUSTOM_OPTION: "native-option",
});
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));

async function openRuntime(factory, cwd, restricted = false) {
  return factory.create({
    workspace: { cwd },
    systemPrompt: "Run the controlled native plugin fixture.",
    eventSink: () => {},
    policy: {
      fileSystem: restricted ? "workspace-write" : "unrestricted",
      network: restricted ? "disabled" : "enabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    },
    hostedTools: {
      definitions: [{ name: "hosted_echo", description: "Hosted fixture", inputSchema: { type: "object" } }],
      handler: async (call) => {
        hostedCalls.push(call.runId);
        return { success: true, content: [{ type: "text", text: "hosted-ok" }] };
      },
    },
  });
}

async function run(target, phase, token, pluginEnabled = true, gateway = "managed", socketPath) {
  state = {
    phase,
    token,
    pluginEnabled,
    gatewayEnabled: Boolean(token) && gateway === "managed",
    issued: false,
    socketPath,
  };
  const result = await target.prompt({
    ...(socketPath ? { allowedUnixSockets: [socketPath] } : {}),
    runId: phase,
    input: { items: [{ type: "text", text: "Run the controlled fixture." }] },
    ...(token ? { configuration: { provider: { mcpGateway: { url: `${origin}/mcp/${gateway}`, token } } } } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(fixtureError, undefined, String(fixtureError));
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.ok(hostedCalls.includes(phase));
  assert.ok(calls.some((call) => call.phase === phase && call.kind === "user"));
  if (pluginEnabled) assert.ok(calls.some((call) => call.phase === phase && call.kind === "plugin"));
  reports.push({
    phase,
    nativePluginLoaded: state.catalog.includes("mcp__plugin"),
    managedLoaded: Boolean(state.managed),
    skillContextPresent: state.skillContextPresent,
  });
  return result.binding;
}

async function scanBearers(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanBearers(path);
    else if (entry.isFile()) {
      const content = await readFile(path);
      for (const token of tokens)
        assert.equal(content.includes(Buffer.from(token)), false, `Persisted fixture bearer in ${entry.name}`);
    }
  }
}

try {
  for (const directory of [
    workspace,
    sibling,
    configHome,
    join(workspace, ".codex"),
    join(marketplace, ".agents", "plugins"),
    join(plugin, ".codex-plugin"),
    join(plugin, "skills", "native-fixture"),
    join(plugin, "hooks"),
  ])
    await mkdir(directory, { recursive: true });
  const hook = join(plugin, "hook.mjs");
  await writeFile(
    hook,
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const p=${JSON.stringify(hookPath)};const count=existsSync(p)?JSON.parse(readFileSync(p,'utf8')).count:0;writeFileSync(p,JSON.stringify({count:count+1,option:process.env.PLUGIN_CUSTOM_OPTION}));`,
  );
  const stdio = join(plugin, "stdio.mjs");
  await writeFile(
    stdio,
    `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const b=JSON.parse(line);if(b.id===undefined)return;let result={};if(b.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'stdio',version:'1'}};if(b.method==='tools/list')result={tools:[{name:'stdio_echo',description:'Stdio fixture',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};if(b.method==='tools/call'){appendFileSync(${JSON.stringify(stdioLog)},JSON.stringify({option:process.env.PLUGIN_CUSTOM_OPTION})+'\\n');result={content:[{type:'text',text:'stdio-'+process.env.PLUGIN_CUSTOM_OPTION}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:b.id,result})+'\\n');});`,
  );
  await writeJson(join(plugin, ".codex-plugin", "plugin.json"), {
    name: "native-fixture",
    version: "1.0.0",
    description: "Native fixture",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    hooks: "./hooks/hooks.json",
  });
  await writeJson(join(plugin, ".mcp.json"), {
    mcpServers: {
      plugin: { type: "http", url: `${origin}/mcp/plugin` },
      stdio: { command: process.execPath, args: [stdio], env_vars: ["PLUGIN_CUSTOM_OPTION"] },
    },
  });
  await writeJson(join(plugin, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(hook)}` }] }],
    },
  });
  await writeFile(
    join(plugin, "skills", "native-fixture", "SKILL.md"),
    "---\nname: native-fixture\ndescription: NATIVE_SKILL_MARKER_742 native plugin fixture\n---\nRun the fixture.\n",
  );
  await writeJson(join(marketplace, ".agents", "plugins", "marketplace.json"), {
    name: "native-market",
    interface: { displayName: "Native fixture" },
    plugins: [
      {
        name: "native-fixture",
        source: { source: "local", path: "./plugins/native-fixture" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  const userConfigPath = join(configHome, "config.toml");
  await writeFile(
    userConfigPath,
    `model="gpt-5.1-codex"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nplugins=true\nremote_plugin=false\nhooks=true\n[model_providers.fixture]\nname="fixture"\nbase_url="${origin}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.opentag-mcp]\nurl="${origin}/mcp/user"\nstartup_timeout_sec=2\ndefault_tools_approval_mode="approve"\n`,
  );
  await appendFile(
    userConfigPath,
    `[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(sibling)}]\ntrust_level="trusted"\n`,
  );
  const execution = { cwd: workspace, env: environment, timeout: 30_000 };
  await exec(command, ["plugin", "marketplace", "add", marketplace, "--json"], execution);
  await exec(command, ["plugin", "add", "native-fixture@native-market", "--json"], execution);
  const installed = await readFile(userConfigPath, "utf8");
  assert.ok(installed.includes('[plugins."native-fixture@native-market"]\nenabled = true'));
  await writeFile(
    userConfigPath,
    installed.replace(
      '[plugins."native-fixture@native-market"]\nenabled = true',
      '[plugins."native-fixture@native-market"]\nenabled = false',
    ),
  );
  const originalUserConfig = await readFile(userConfigPath, "utf8");
  const enabledProject = '[plugins."native-fixture@native-market"]\nenabled=true\n';
  await writeFile(projectConfigPath, enabledProject);
  const factory = new CodexAgentRuntimeFactory({
    clientVersion: "0.0.1-native-fixture",
    process: { command, env: environment },
    mcpAttachTimeoutMs: 3000,
  });
  runtime = await openRuntime(factory, workspace);
  await run(runtime, "enabled-one", tokens[0]);
  assert.equal(state.skillContextPresent, true);
  const firstBinding = runtime.binding;
  await run(runtime, "enabled-two", tokens[1]);
  assert.deepEqual(runtime.binding, firstBinding);
  await run(runtime, "detached", undefined);
  await run(runtime, "failed-gateway", tokens[2], true, "rejected");
  await run(runtime, "hanging-gateway", tokens[3], true, "hanging");
  state = {
    phase: "cancel-attach",
    token: tokens[4],
    abort: () => {
      void runtime.abort({ expectedRunId: "cancel-attach", reason: "fixture" });
    },
  };
  const cancelled = await runtime.prompt({
    runId: "cancel-attach",
    input: { items: [{ type: "text", text: "Cancel the pending attach." }] },
    configuration: { provider: { mcpGateway: { url: `${origin}/mcp/hanging`, token: tokens[4] } } },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(cancelled.status, "aborted");
  await delay(1500);
  await run(runtime, "recovered", tokens[5]);
  assert.deepEqual(runtime.binding, firstBinding);
  assert.equal(await readFile(userConfigPath, "utf8"), originalUserConfig);
  assert.equal(await readFile(projectConfigPath, "utf8"), enabledProject);
  await assert.rejects(readFile(hookPath), { code: "ENOENT" });
  let stdioCalls = (await readFile(stdioLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(stdioCalls.length >= 5);
  assert.ok(stdioCalls.every((call) => call.option === "native-option"));
  await writeFile(projectConfigPath, '[plugins."native-fixture@native-market"]\nenabled=false\n');
  await run(runtime, "disabled", undefined, false);
  await assert.rejects(readFile(hookPath), { code: "ENOENT" });
  await runtime.close();
  siblingRuntime = await openRuntime(factory, sibling);
  await run(siblingRuntime, "sibling", undefined, false);
  await siblingRuntime.close();
  assert.equal(state.skillContextPresent, false);
  await writeFile(projectConfigPath, enabledProject);
  socketRuntime = await openRuntime(factory, workspace, true);
  for (const phase of ["socket-one", "socket-two"]) {
    const socketPath = join(home, phase);
    const socketServer = createSocketServer((connection) => connection.end(`SOCKET=${state.phase}`));
    socketServers.push(socketServer);
    await new Promise((resolve) => socketServer.listen(socketPath, resolve));
    await run(socketRuntime, phase, undefined, true, "managed", socketPath);
  }
  await writeFile(projectConfigPath, `${enabledProject}[features]\nplugins=false\n`);
  await run(socketRuntime, "socket-native-feature-disabled", undefined, false, "managed", join(home, "socket-one"));
  await writeFile(projectConfigPath, enabledProject);
  await run(socketRuntime, "socket-removed", undefined);
  await socketRuntime.close();
  stdioCalls = (await readFile(stdioLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(stdioCalls.every((call) => call.option === "native-option"));
  await scanBearers(configHome);
  const version = (await exec(command, ["--version"], { env: environment })).stdout.trim();
  process.stdout.write(
    `${JSON.stringify({ ok: true, version, reports, nativeMcpCalls: calls.length, hostedCalls: hostedCalls.length, untrustedHooksSkipped: true, stdioCalls: stdioCalls.length, bindingPreserved: true, userConfigurationUnchanged: true, bearerPersisted: false })}\n`,
  );
} finally {
  await runtime?.close();
  await siblingRuntime?.close();
  await socketRuntime?.close();
  for (const socketServer of socketServers) await new Promise((resolve) => socketServer.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
