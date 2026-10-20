/** Deterministic local UI fixture. Build @opentag/web first. No production requests. */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";

const e2eRequire = createRequire(resolve("e2e/package.json"));
const axeRequire = createRequire(e2eRequire.resolve("@axe-core/playwright"));

const dist = resolve("apps/web/dist");
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const now = "2026-10-20T10:00:00.000Z";
const agents = ["opentag", "reviewer"].map((name, index) => ({
  id: index ? "2b74b32f-a7d8-4585-92fb-5ecbf1677b35" : "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  name,
  displayName: name,
  avatarPath: `/api/v1/agents/${index ? "2b74b32f-a7d8-4585-92fb-5ecbf1677b35" : "1a63a21e-f6c7-4474-91ea-4dabf0566a24"}/avatar`,
  createdBy: { userId, displayName: "Ginger may" },
  computer: null,
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: now,
  updatedAt: now,
  activity: { state: "idle" },
  usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
}));
const configs = new Map(
  agents.map(({ createdBy, computer, activity, usage, avatarPath, ...identity }) => [
    identity.id,
    {
      ...identity,
      createdByUserId: userId,
      computerId: null,
      selfConfigurationEnabled: false,
      revision: 1,
      runtimeConfig: {
        permissions: { approvalPolicy: "on-request", allowCommands: [] },
        contextTrees: [],
        revision: 1,
        model: null,
        reasoningEffort: null,
        instructions: "",
        maxDurationMs: null,
      },
    },
  ]),
);
async function serveAsset(url, res) {
  const requested = resolve(dist, `.${url.pathname}`);
  if (!requested.startsWith(`${dist}/`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const types = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".html": "text/html",
  };
  try {
    const body = await readFile(requested);
    res.setHeader("content-type", types[extname(requested)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("content-type", "text/html");
    let html = await readFile(`${dist}/index.html`, "utf8");
    if (url.searchParams.has("qa"))
      html = html.replace(
        "</body>",
        `<script src="/__qa/axe.js"></script><button id="qa-run" style="position:fixed;right:8px;bottom:8px;z-index:999;background:white;color:black;border:1px solid;padding:8px">Run accessibility check</button><script>
        document.getElementById('qa-run').onclick = async () => {
          const result = await axe.run(document.getElementById('root'), {runOnly: {type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});
          const report = document.createElement('pre'); report.id='qa-report'; report.textContent=JSON.stringify(result.violations.map(({id,impact,nodes})=>({id,impact,nodes:nodes.map(({target,failureSummary})=>({target,failureSummary}))}))); document.body.append(report);
        };
      </script></body>`,
      );
    res.end(html);
  }
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "set-cookie": "opentag_csrf=local-design-fixture; Path=/; SameSite=Lax",
  });
  res.end(value === undefined ? undefined : JSON.stringify(value));
  return true;
}

async function updateConfig(req, agent, send) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const update = JSON.parse(raw);
  const config = configs.get(agent.id);
  if (update.expectedRevision !== config.revision) return send({ error: { message: "Revision conflict" } }, 409);
  Object.assign(config.runtimeConfig, update.runtimeConfig);
  config.revision += 1;
  return send(config);
}

async function serveAgent(req, res, url, send) {
  const path = url.pathname;
  const agent = agents.find((a) => path.startsWith(`/api/v1/agents/${a.id}`));
  if (!agent) return false;
  const suffix = path.slice(`/api/v1/agents/${agent.id}`.length);
  if (suffix === "/avatar") {
    res.setHeader("content-type", "image/png");
    res.end(await readFile(`${dist}/bot-avatars/v1/${agent.name === "opentag" ? "developer" : "architect"}.png`));
    return true;
  }
  if (suffix.startsWith("/im-binding")) return send(undefined, 204);
  if (!suffix && req.method === "PATCH") return updateConfig(req, agent, send);
  const { usage, ...detail } = agent;
  const responses = new Map([
    ["", detail],
    ["/config", configs.get(agent.id)],
    ["/mcp-servers", { servers: [] }],
    ["/skills", { skills: [], storage: "available" }],
    ["/schedules", { items: [], nextCursor: null }],
    [
      "/usage",
      {
        windowDays: Number(url.searchParams.get("days") ?? 30),
        startedAt: now,
        endedAt: now,
        tasks: 0,
        measuredTasks: 0,
        failed: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        daily: [],
      },
    ],
  ]);
  return responses.has(suffix) ? send(responses.get(suffix)) : false;
}

const responses = new Map([
  [
    "/api/v1/me",
    { user: { id: userId, email: "preview@example.com", displayName: "Ginger may" }, setupCompletedAt: now },
  ],
  ["/api/v1/cloud/billing", { enabled: false }],
  [
    "/api/v1/integrations/github",
    { availability: { available: false, githubHost: "github.com", appId: null }, connection: null },
  ],
  ["/api/v1/mcp-catalog/endpoints", { endpoints: [] }],
  ["/api/v1/agents", { agents }],
  ["/api/v1/computers", { computers: [] }],
  ["/api/v1/sessions", { tasks: [], nextCursor: null }],
]);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4317");
  const send = (value, status) => sendJson(res, value, status);
  try {
    if (url.pathname === "/__qa/axe.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(axeRequire.resolve("axe-core/axe.min.js")));
      return;
    }
    if (!url.pathname.startsWith("/api/")) return await serveAsset(url, res);
    if (url.pathname === "/api/v1/error-reports") return send(undefined, 204);
    if (responses.has(url.pathname)) return send(responses.get(url.pathname));
    if (await serveAgent(req, res, url, send)) return;
    console.warn(`Unimplemented fixture: ${req.method} ${url.pathname}`);
    return send({ error: { message: "Not offered by the design fixture" } }, 404);
  } catch (error) {
    console.error(error);
    return send({ error: { message: "Fixture failed" } }, 500);
  }
});
server.listen(4317, "127.0.0.1", () => console.log("Design fixture: http://127.0.0.1:4317/agents"));
