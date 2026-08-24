#!/usr/bin/env node
/**
 * End-to-end onboarding check.
 *
 * Runs the real Server against a real PostgreSQL database, serves the real Web
 * build, drives a real Chromium browser through `/onboarding`, and connects a
 * real Computer with the real CLI daemon over the runtime WebSocket protocol.
 * Nothing in the Server, Web, Client, or CLI code paths is stubbed. The only
 * substituted artifacts are the local Claude Code and lark-cli executables,
 * because readiness otherwise depends on installed and signed-in CLIs; the
 * stubs answer the same probe contracts the Client runs.
 *
 * The Feishu leg cannot be authorized offline, so the check does two things: it
 * starts a real setup attempt and records the outcome, then writes an authorized
 * binding directly into the database to confirm that the Server projects handoff
 * readiness and the page derives its ready state from those facts.
 *
 * Requirements:
 * - a reachable PostgreSQL superuser URL (OPENTAG_E2E_ADMIN_DATABASE_URL)
 * - a built workspace (`pnpm build`)
 * - `playwright-core` resolvable, or OPENTAG_E2E_PLAYWRIGHT_PATH pointing at it
 * - a Chromium executable (OPENTAG_E2E_CHROMIUM, default /opt/pw-browsers/chromium)
 *
 * Usage: node scripts/e2e/onboarding-e2e.mjs
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require_ = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PORT = Number(process.env.OPENTAG_E2E_PORT ?? 8123);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_DATABASE_URL =
  process.env.OPENTAG_E2E_ADMIN_DATABASE_URL ?? "postgresql://opentag:opentag@127.0.0.1:5432/postgres";
const DATABASE_NAME = process.env.OPENTAG_E2E_DATABASE ?? "opentag_e2e";
const DATABASE_URL = new URL(ADMIN_DATABASE_URL);
DATABASE_URL.pathname = `/${DATABASE_NAME}`;
const CHROMIUM_PATH = process.env.OPENTAG_E2E_CHROMIUM ?? "/opt/pw-browsers/chromium";
const DEV_EMAIL = "e2e@opentag.local";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_DIRECTORY = resolve(process.env.OPENTAG_E2E_ARTIFACTS ?? join(tmpdir(), "opentag-onboarding-e2e"));
/* Set to "off" to probe the Claude Code CLI already installed on PATH instead. */
const PROVIDER_STUB = process.env.OPENTAG_E2E_PROVIDER_STUB !== "off";
/* Set to "on" to keep the E2E database after the run for debugging. */
const KEEP_DATABASE = process.env.OPENTAG_E2E_KEEP_DATABASE === "on";

/** The database this run created, so the same run can drop it again. */
let createdDatabase;
/** Rejects once the Server this run spawned exits, which invalidates every later fact. */
let serverExited;

/**
 * Endpoint ownership has to hold across every await, not only at its start:
 * once this child is gone, anything answering on its port is someone else's
 * Server, so awaited work loses to the exit that invalidated it.
 */
function raceServerExit(work) {
  return serverExited ? Promise.race([work, serverExited]) : work;
}

const steps = [];
let stepIndex = 0;

async function step(name, run) {
  stepIndex += 1;
  const label = `${String(stepIndex).padStart(2, "0")} ${name}`;
  const startedAt = Date.now();
  try {
    const value = await raceServerExit(run());
    const detail = typeof value === "string" ? value : typeof value?.detail === "string" ? value.detail : "";
    steps.push({ label, ok: true, detail, ms: Date.now() - startedAt });
    process.stdout.write(`PASS ${label}${detail ? ` — ${detail}` : ""}\n`);
    return value;
  } catch (error) {
    steps.push({ label, ok: false, detail: String(error?.message ?? error), ms: Date.now() - startedAt });
    process.stdout.write(`FAIL ${label} — ${String(error?.message ?? error)}\n`);
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const expiry = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

async function waitFor(description, predicate, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

/**
 * Keeps the password out of argv, where any local process could read it. A URL
 * stores its password percent-encoded, but libpq wants the decoded credential.
 */
function connectionTarget(url) {
  const target = new URL(String(url));
  const encoded = target.password;
  target.password = "";
  return { dsn: target.href, password: decodeURIComponent(encoded), encodedPassword: encoded };
}

function redactSecrets(message, ...secrets) {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[redacted]"), String(message));
}

async function psql(url, sql) {
  const { dsn, password, encodedPassword } = connectionTarget(url);
  try {
    const { stdout } = await execFileAsync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
      env: { ...process.env, PGPASSWORD: password },
    });
    return stdout.trim();
  } catch (error) {
    // execFile puts the whole command, and psql echoes the target, into the failure text.
    throw new Error(redactSecrets(error.message, password, encodedPassword));
  }
}

/**
 * Turns the common case of a busy port into a clear message before spawning.
 * The Server's own listening line, not this probe, proves the endpoint is ours.
 */
async function assertPortAvailable(port) {
  await new Promise((settle, fail) => {
    const probe = createServer();
    probe.once("error", (error) =>
      fail(
        error.code === "EADDRINUSE"
          ? new Error(`127.0.0.1:${port} is already in use; stop it or set OPENTAG_E2E_PORT`)
          : error,
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => settle(undefined)));
  });
}

/**
 * This check drops its database on every run, so the target must be
 * unmistakably disposable and safe to interpolate as an SQL identifier.
 */
function disposableDatabaseName(name, adminUrl) {
  if (!/^[a-z][a-z0-9_]{0,61}$/.test(name)) {
    throw new Error(`OPENTAG_E2E_DATABASE must be a lowercase identifier, received "${name}"`);
  }
  if (!name.includes("e2e")) {
    throw new Error(`OPENTAG_E2E_DATABASE must name an E2E database, received "${name}"`);
  }
  const administered = new URL(String(adminUrl)).pathname.replace(/^\//, "");
  if (name === administered) {
    throw new Error(`OPENTAG_E2E_DATABASE must differ from the administrative database "${administered}"`);
  }
  return name;
}

function loadChromium() {
  const specifier = process.env.OPENTAG_E2E_PLAYWRIGHT_PATH ?? "playwright-core";
  try {
    return require_(specifier).chromium;
  } catch (error) {
    throw new Error(
      `playwright-core could not be loaded from "${specifier}". Install it and set OPENTAG_E2E_PLAYWRIGHT_PATH: ${
        error.message
      }`,
    );
  }
}

/**
 * Provider readiness must come from this check's own configuration, not from
 * whatever the developer's shell exports. The stub run sees only the stubbed
 * executable and an empty provider home; the installed run deliberately points
 * Claude Code at a real configuration directory and still keeps Codex out, so
 * the asserted route is the same in both modes.
 */
function providerEnvironment(clientHome, openTagHome, stubBin) {
  const {
    CLAUDE_CONFIG_DIR: configuredClaudeHome,
    CODEX_HOME: _codexHome,
    HOME: realHome,
    PATH: inheritedPath,
    ...inherited
  } = process.env;
  const systemPath = "/usr/local/bin:/usr/bin:/bin";
  if (PROVIDER_STUB) {
    return {
      ...inherited,
      HOME: clientHome,
      OPENTAG_HOME: openTagHome,
      CLAUDE_CONFIG_DIR: join(clientHome, ".claude"),
      PATH: `${stubBin}:${systemPath}`,
    };
  }
  const claudeHome = configuredClaudeHome ?? (realHome ? join(realHome, ".claude") : join(clientHome, ".claude"));
  return {
    ...inherited,
    HOME: clientHome,
    OPENTAG_HOME: openTagHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    PATH: inheritedPath ?? systemPath,
  };
}

/** Answers exactly the probe contract in the Claude Code provider adapter. */
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) echo "9.9.9 (opentag-e2e-stub)" ;;
  --help)
    echo "stream-json --session-id --resume --mcp-config --strict-mcp-config --allowedTools --append-system-prompt"
    ;;
  auth)
    echo '{"loggedIn":true}'
    ;;
  *) echo "opentag e2e stub does not run turns" >&2; exit 1 ;;
esac
`;

/** Answers exactly the Feishu CLI readiness probe used by the Client. */
const LARK_CLI_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]] || [[ "\${1:-}" == "im" && "\${2:-}" == "--help" ]]; then
  echo "opentag-e2e-stub"
  exit 0
fi
echo "opentag e2e stub does not run Feishu commands" >&2
exit 1
`;

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "opentag-e2e-"));
  const clientHome = join(workspace, "home");
  const openTagHome = join(workspace, "opentag-home");
  const stubBin = join(workspace, "bin");
  await mkdir(join(clientHome, ".claude"), { recursive: true });
  await mkdir(join(clientHome, ".codex"), { recursive: true });
  await mkdir(openTagHome, { recursive: true });
  await mkdir(stubBin, { recursive: true });
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  await writeFile(join(stubBin, "claude"), CLAUDE_STUB, { mode: 0o755 });
  await writeFile(join(stubBin, "lark-cli"), LARK_CLI_STUB, { mode: 0o755 });
  await Promise.all([chmod(join(stubBin, "claude"), 0o755), chmod(join(stubBin, "lark-cli"), 0o755)]);

  const serverLogPath = join(ARTIFACT_DIRECTORY, "server.log");
  const daemonLogPath = join(ARTIFACT_DIRECTORY, "daemon.log");
  let server;
  let daemon;
  let browser;

  const shutdown = async () => {
    if (browser) await browser.close().catch(() => undefined);
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await sleep(1_000);
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await sleep(1_000);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  };

  try {
    await step("reset the E2E database", async () => {
      const database = disposableDatabaseName(DATABASE_NAME, ADMIN_DATABASE_URL);
      await psql(ADMIN_DATABASE_URL, `drop database if exists "${database}" with (force)`);
      await psql(ADMIN_DATABASE_URL, `create database "${database}"`);
      createdDatabase = database;
      return KEEP_DATABASE ? `${database} (retained after the run)` : database;
    });

    await step("start the Server with the real Web build", async () => {
      const serverEntry = join(repositoryRoot, "packages", "server", "dist", "index.mjs");
      if (!existsSync(serverEntry)) throw new Error("Run pnpm build before this check");
      if (!existsSync(join(repositoryRoot, "apps", "web", "dist", "index.html"))) {
        throw new Error("apps/web/dist is missing; run pnpm build before this check");
      }
      await assertPortAvailable(PORT);
      const log = createWriteStream(serverLogPath);
      server = spawn(process.execPath, [serverEntry], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          OPENTAG_DATABASE_URL: String(DATABASE_URL),
          OPENTAG_AUTO_MIGRATE: "true",
          OPENTAG_ENV: "dev",
          OPENTAG_HOST: "127.0.0.1",
          OPENTAG_PORT: String(PORT),
          OPENTAG_PUBLIC_URL: BASE_URL,
          OPENTAG_JWT_SECRET: randomBytes(32).toString("hex"),
          OPENTAG_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
          OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
          OPENTAG_DEV_AUTH_EMAIL: DEV_EMAIL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout.pipe(log);
      server.stderr.pipe(log);
      /*
       * The endpoint belongs to this run only when this child binds it: the
       * operating system hands the port to one listener, so its own listening
       * line is the proof. A health response alone could come from anyone.
       */
      const listening = new Promise((settle) => {
        let announced = "";
        server.stdout.on("data", (chunk) => {
          if (announced.length > 8_192) announced = announced.slice(-1_024);
          announced += String(chunk);
          if (announced.includes(`Server listening at ${BASE_URL}`)) settle(undefined);
        });
      });
      serverExited = new Promise((_, fail) => {
        server.once("exit", (code) => {
          log.write(`\nserver exited with ${code}\n`);
          fail(new Error(`Server exited with ${code}; see ${serverLogPath}`));
        });
      });
      // The signal outlives the listening line and never becomes an unhandled rejection.
      serverExited.catch(() => undefined);
      await withTimeout(Promise.race([listening, serverExited]), 60_000, `Server did not bind ${BASE_URL} within 60s`);
      await raceServerExit(waitFor("the Server health endpoint", async () => (await fetch(`${BASE_URL}/healthz`)).ok));
      return `${BASE_URL} (migrations applied, log: ${serverLogPath})`;
    });

    await step("seed an authenticated user and Team", async () => {
      await psql(
        DATABASE_URL,
        `insert into users (id, email, display_name) values ('${USER_ID}', '${DEV_EMAIL}', 'E2E User');
         insert into teams (id, name, display_name) values ('${TEAM_ID}', 'e2e-team', 'E2E Team');
         insert into memberships (team_id, user_id, role, status) values ('${TEAM_ID}', '${USER_ID}', 'admin', 'active');`,
      );
      return `${DEV_EMAIL} as admin of e2e-team`;
    });

    const chromium = loadChromium();
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      consoleErrors.push(
        `${message.text().replace(/\s+/g, " ").trim()} [${location.url}:${location.lineNumber}:${location.columnNumber}]`,
      );
    });
    page.on("requestfailed", (request) => {
      consoleErrors.push(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const shot = async (name) => {
      await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `${name}.png`), fullPage: true });
    };

    await step("sign in through the browser and land on /onboarding", async () => {
      await page.goto(`${BASE_URL}/api/v1/auth/dev/callback?next=/onboarding`, { waitUntil: "networkidle" });
      if (new URL(page.url()).pathname !== "/onboarding") throw new Error(`Landed on ${page.url()}`);
      await page.getByRole("heading", { name: "Set up OpenTag" }).waitFor({ timeout: 15_000 });
      await shot("01-signed-in");
      return page.url();
    });

    const connect = await step("read the Computer connect command from the page", async () => {
      await page.getByRole("heading", { name: "Connect a Local Computer" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Generate connection command" }).click();
      const command = await waitFor("the bootstrap command", async () => {
        const text = await page.locator("body").innerText();
        const match = /login --server\s+'?([^\s']+)'?\s+--\s+'?([A-Za-z0-9_-]+)'?/.exec(text);
        return match ? { serverUrl: match[1], code: match[2] } : undefined;
      });
      await shot("02-connect-computer");
      if (command.serverUrl !== BASE_URL) throw new Error(`Unexpected server URL ${command.serverUrl}`);
      return { code: command.code, detail: `one-time code issued for ${command.serverUrl}` };
    });

    await step("exchange the connect code with the real CLI", async () => {
      const cli = join(repositoryRoot, "apps", "cli", "dist", "cli", "index.mjs");
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "login", "--no-start", "--server", BASE_URL, "--", connect.code],
        { env: { ...process.env, HOME: clientHome, OPENTAG_HOME: openTagHome } },
      );
      return stdout.trim().split("\n")[0];
    });

    await step("run the Computer daemon and reach an online Computer", async () => {
      const cli = join(repositoryRoot, "apps", "cli", "dist", "cli", "index.mjs");
      const log = createWriteStream(daemonLogPath);
      daemon = spawn(process.execPath, [cli, "daemon", "service-run"], {
        cwd: workspace,
        env: providerEnvironment(clientHome, openTagHome, stubBin),
        stdio: ["ignore", "pipe", "pipe"],
      });
      daemon.stdout.pipe(log);
      daemon.stderr.pipe(log);
      daemon.on("exit", (code) => log.write(`\ndaemon exited with ${code}\n`));
      const connected = await waitFor(
        "the Computer to register as online",
        async () => {
          const online = await psql(DATABASE_URL, "select count(*) from computers where connected_at is not null");
          return Number(online) > 0;
        },
        { timeoutMs: 90_000 },
      );
      return connected ? `${PROVIDER_STUB ? "stubbed" : "installed"} local CLIs, daemon log: ${daemonLogPath}` : "";
    });

    await step("advance the page to the Agent creation step", async () => {
      const createAgent = page.getByRole("button", { name: "Create Agent" });
      const providerHeading = page.getByRole("heading", {
        name: /Prepare Codex or Claude Code|Confirm the runtime route/,
      });
      await waitFor(
        "the Agent creation step",
        async () => {
          if (await createAgent.isEnabled().catch(() => false)) return true;
          const checkAgain = page.getByRole("button", { name: /Check again|Checking…/ });
          if (await providerHeading.isVisible().catch(() => false)) {
            if (await checkAgain.isEnabled().catch(() => false)) await checkAgain.click();
          }
          return false;
        },
        { timeoutMs: 120_000, intervalMs: 1_500 },
      );
      const description = await page.getByRole("region", { name: "Where it runs" }).innerText();
      await shot("03-create-agent");
      if (!description.includes("Claude Code")) throw new Error(`Unexpected runtime route: ${description}`);
      return description;
    });

    await step("create the Agent from the onboarding form", async () => {
      const input = page.getByLabel("Display name");
      await input.fill("OpenTag E2E");
      await page.getByRole("button", { name: "Create Agent" }).click();
      await page.getByRole("heading", { name: "Connect OpenTag to Feishu" }).waitFor({ timeout: 60_000 });
      await shot("04-handoff");
      return "handoff step reached";
    });

    await step("verify the Server facts behind the new Agent", async () => {
      const row = await psql(
        DATABASE_URL,
        `select a.display_name || ' | ' || a.runtime_provider || ' | ' || a.status || ' | ' || c.display_name
           from agents a join computers c on c.id = a.computer_id where a.team_id = '${TEAM_ID}'`,
      );
      if (!row.includes("claude-code")) throw new Error(`Unexpected Agent row: ${row || "<none>"}`);
      const api = await page.evaluate(async () => {
        const response = await fetch("/api/v1/teams/22222222-2222-4222-8222-222222222222/computers", {
          headers: { "x-opentag-provider-readiness": "1" },
        });
        return response.json();
      });
      const readiness = api.computers?.[0]?.providerReadiness ?? [];
      const claude = readiness.find((entry) => entry.provider === "claude-code");
      if (claude?.status !== "ready") throw new Error(`Unexpected readiness projection: ${JSON.stringify(readiness)}`);
      return `${row} | claude-code readiness=${claude.status}`;
    });

    await step("reload and stay on the same factual step", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Connect OpenTag to Feishu" }).waitFor({ timeout: 30_000 });
      return "no step cursor is persisted";
    });

    await step("start the Feishu handoff and report the outcome", async () => {
      await page.getByRole("button", { name: /Connect existing or new Feishu Bot|Resume Feishu setup/ }).click();
      const outcome = await waitFor(
        "a Feishu setup response",
        async () => {
          const text = await page.locator(".onboarding-action").innerText();
          const alert = await page
            .locator("[role=alert], .notice.error")
            .first()
            .innerText()
            .catch(() => "");
          if (alert) return `error: ${alert.replace(/\s+/g, " ").trim()}`;
          if (/scan|QR|Authorize|awaiting/i.test(text)) return "attempt awaiting user authorization";
          return undefined;
        },
        { timeoutMs: 30_000, intervalMs: 1_000 },
      );
      await shot("05-feishu-attempt");
      return outcome;
    });

    await step("keep a member out of the admin-only onboarding flow", async () => {
      await psql(DATABASE_URL, `update memberships set role = 'member' where user_id = '${USER_ID}'`);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForURL(`${BASE_URL}/agents`, { timeout: 30_000 });
      await page
        .getByText("An administrator needs to prepare the first Agent.", { exact: false })
        .waitFor({ timeout: 30_000 });
      await shot("06-member-waiting-for-admin");
      await psql(DATABASE_URL, `update memberships set role = 'admin' where user_id = '${USER_ID}'`);
      await page.goto(`${BASE_URL}/onboarding`, { waitUntil: "networkidle" });
      return "member redirected to Agents with the admin dependency explained";
    });

    await step("reach the ready state with an authorized Feishu binding", async () => {
      const { FEISHU_REQUIRED_TENANT_SCOPES } = await import(
        join(repositoryRoot, "packages", "shared", "dist", "index.mjs")
      );
      const agentId = await psql(DATABASE_URL, `select id from agents where team_id = '${TEAM_ID}' limit 1`);
      const scopes = FEISHU_REQUIRED_TENANT_SCOPES.map((scope) => `'${scope}'`).join(", ");
      await psql(
        DATABASE_URL,
        `delete from im_bindings where agent_id = '${agentId}';
         insert into im_bindings (
           agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
           external_team_brand, bot_display_name, credential_schema_version, credential_generation,
           encrypted_credential, granted_capabilities, connection_owner_instance_id,
           connection_lease_expires_at, observed_connected_at, observed_at, activated_at
         ) values (
           '${agentId}', 'feishu', 'active', 'cli_e2e_app', 'tenant_e2e', 'bot_e2e',
           'feishu', 'OpenTag E2E Bot', 1, 1,
           'e2e-placeholder', ARRAY[${scopes}]::text[], '33333333-3333-4333-8333-333333333333',
           now() + interval '1 hour', now(), now(), now()
         )`,
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForURL(`${BASE_URL}/agents`, { timeout: 30_000 });
      const completedAt = await psql(DATABASE_URL, `select setup_completed_at from teams where id = '${TEAM_ID}'`);
      if (!completedAt) throw new Error("Team setup completion was not persisted");
      await shot("07-completed");
      return `handoff readiness projected and Team setup completed at ${completedAt}`;
    });

    await step("survive a Computer outage without losing the Agent", async () => {
      daemon.kill("SIGTERM");
      await waitFor(
        "the Computer to go offline",
        async () => {
          const offline = await psql(DATABASE_URL, "select count(*) from computers where connected_at is null");
          return Number(offline) > 0;
        },
        { timeoutMs: 60_000 },
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForURL(`${BASE_URL}/agents`, { timeout: 30_000 });
      await page.getByRole("heading", { name: "Agents" }).waitFor({ timeout: 30_000 });
      await shot("08-runtime-outage");
      const agents = await psql(DATABASE_URL, `select count(*) from agents where team_id = '${TEAM_ID}'`);
      if (Number(agents) !== 1) throw new Error(`Expected exactly one Agent, found ${agents}`);
      const completedAt = await psql(DATABASE_URL, `select setup_completed_at from teams where id = '${TEAM_ID}'`);
      if (!completedAt) throw new Error("Computer outage reopened Team setup");
      return `Agents remained the product destination; setup completion stayed at ${completedAt}`;
    });

    await step("run the whole flow without an uncaught browser error", async () => {
      const unique = [...new Set(consoleErrors)];
      await writeFile(join(ARTIFACT_DIRECTORY, "console-errors.txt"), `${unique.join("\n")}\n`);
      if (pageErrors.length > 0) throw new Error(pageErrors.join(" | "));
      return `${unique.length} console entries recorded in console-errors.txt`;
    });
  } finally {
    await shutdown();
    // A promised cleanup that did not happen is a failed run, not a footnote.
    let cleanupFailure;
    if (createdDatabase && !KEEP_DATABASE) {
      cleanupFailure = await psql(ADMIN_DATABASE_URL, `drop database if exists "${createdDatabase}" with (force)`).then(
        () => undefined,
        (error) => `Could not drop ${createdDatabase}: ${error.message}`,
      );
      if (cleanupFailure) process.stdout.write(`FAIL cleanup — ${cleanupFailure}\n`);
    }
    process.stdout.write(`\nArtifacts: ${ARTIFACT_DIRECTORY}\n`);
    const failed = steps.filter((entry) => !entry.ok);
    process.stdout.write(`${steps.length - failed.length}/${steps.length} steps passed\n`);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    process.exitCode = failed.length > 0 || cleanupFailure ? 1 : 0;
  }
}

await main().catch((error) => {
  // A failure outside any step, such as an unusable Chromium, still needs to name itself.
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
