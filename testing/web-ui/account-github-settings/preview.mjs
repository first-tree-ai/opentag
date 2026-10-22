/** Local-only mock Account preview. Run from the repository root after building the Web app. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const dist = resolve("apps/web/dist");
const accountId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const now = "2026-10-22T00:00:00.000Z";
const connection = {
  id: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  accountId,
  githubHost: "github.com",
  oauthClientId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
  authorizationVersion: "2",
  credentialGeneration: "1",
  accessExpiresAt: "2027-10-22T00:00:00.000Z",
  refreshExpiresAt: "2028-10-22T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: null,
  lastVerifiedAt: now,
  lastErrorCode: null,
  createdAt: now,
  updatedAt: now,
};
const disconnected = new Set();
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const github = "/api/v2/integrations/github";
function overview(scenario, send) {
  if (scenario === "overview-error") return send({ error: { message: "Mock overview failure" } }, 503);
  return send({
    availability: {
      available: scenario !== "unavailable",
      githubHost: "github.com",
      oauthClientId: scenario === "unavailable" ? null : "871235",
    },
    connection:
      ["empty", "unavailable"].includes(scenario) || disconnected.has(scenario)
        ? null
        : { ...connection, status: scenario === "reauthorize" ? "reauthorization_required" : "active" },
  });
}

function repositories(scenario, send) {
  if (scenario === "repository-error") return send({ error: { message: "Mock repository failure" } }, 503);
  return send({
    repositories: ["octocat/hello-world", "acme/private-project"].map((fullName, i) => ({
      repositoryId: String(i + 1),
      fullName,
      private: i === 1,
      defaultBranch: "main",
      permissions: { pull: true, push: true },
    })),
    nextCursor: null,
    truncated: false,
  });
}

function serveApi(path, scenario, send) {
  const simple = new Map([
    [
      "/api/v1/me",
      { user: { id: accountId, email: "mock@example.com", displayName: "Mock preview" }, setupCompletedAt: now },
    ],
    ["/api/v1/cloud/billing", { enabled: false }],
    ["/api/v1/agents", { agents: [] }],
    ["/api/v1/computers", { computers: [] }],
  ]);
  if (path === "/api/v1/me/setup/reset")
    return send({ error: { message: "Internal Tools are disabled in this preview" } }, 404);
  if (simple.has(path)) return send(simple.get(path));
  if (path === github) return overview(scenario, send);
  if (path === `${github}/repositories`) return repositories(scenario, send);
  if (path === `${github}/authorization`)
    return send({ error: { message: "Mock preview: OAuth navigation is disabled." } }, 503);
  if (path === `${github}/disconnect`) {
    disconnected.add(scenario);
    return send({ ...connection, status: "revoked" });
  }
  return send({ error: { message: "Not provided by the mock preview" } }, 404);
}

async function serveAsset(url, res) {
  const file = resolve(dist, `.${url.pathname}`);
  if (!file.startsWith(`${dist}/`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch (error) {
    if (!["ENOENT", "EISDIR"].includes(error.code)) throw error;
    const html = await readFile(`${dist}/index.html`, "utf8");
    res.setHeader("content-type", "text/html");
    res.end(
      html.replace(
        "</body>",
        '<aside style="position:fixed;bottom:0;left:0;z-index:9999;background:#fff3cd;color:#422;padding:4px 12px;font:12px sans-serif">MOCK PREVIEW · 模拟数据 · OAuth disabled</aside></body>',
      ),
    );
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4318");
  const scenario = new URL(req.headers.referer ?? url, url).searchParams.get("scenario") ?? "active";
  const send = (value, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "set-cookie": "opentag_csrf=mock-preview; Path=/; SameSite=Lax",
    });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname.startsWith("/api/")) return serveApi(url.pathname, scenario, send);
    await serveAsset(url, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send({ error: { message: "Mock preview failed" } }, 500);
    else res.end();
  }
});
server.listen(4318, "127.0.0.1", () => console.log("Mock Account preview: http://127.0.0.1:4318/account"));
