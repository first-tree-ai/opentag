import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test as base, expect, request as playwrightRequest } from "@playwright/test";
import { baseURL, repositoryRoot } from "../playwright.config.js";

const execFileAsync = promisify(execFile);
const ADMIN_AUTH_STATE = join(repositoryRoot, "e2e", ".auth", "admin.json");
const COMPOSE_FILE = join(repositoryRoot, "docker-compose.yml");
const CLAUDE_STUB_JS = join(repositoryRoot, "e2e/scripts/claude-stub.mjs");
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLAUDE_STUB_JS)} "$@"
`;
const LARK_CLI_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]] || [[ "\${1:-}" == "im" && "\${2:-}" == "--help" ]]; then
  echo "opentag-e2e-stub"
  exit 0
fi
echo "opentag e2e stub does not run Feishu commands" >&2
exit 1
`;

export type ClaudeStubMode = "pass" | "fail" | "hold";

export interface E2ERuntime {
  accountComputerId: string;
  claudeStubCancellationCount(): Promise<number>;
  claudeStubStartCount(): Promise<number>;
  databaseURL: string;
  devEmail: string;
  setClaudeStubMode(mode: ClaudeStubMode): Promise<void>;
  setSetupIncomplete(): Promise<void>;
  setSetupComplete(): Promise<void>;
  seedTask(agentId: string): Promise<string>;
  userId: string;
}

interface RuntimeFile {
  accountComputerId: string;
  adminDatabaseURL: string;
  baseURL: string;
  databaseURL: string;
  devEmail: string;
  userId: string;
}

function connectionTarget(url: string): { database: string; password: string; username: string } {
  const target = new URL(url);
  return {
    database: target.pathname.slice(1),
    password: decodeURIComponent(target.password),
    username: decodeURIComponent(target.username),
  };
}

async function psql(url: string, sql: string): Promise<string> {
  const { database, password, username } = connectionTarget(url);
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "-e",
      `PGPASSWORD=${password}`,
      "postgres",
      "psql",
      "-U",
      username,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      sql,
    ],
    { cwd: repositoryRoot },
  );
  return stdout.trim();
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function startDaemon(
  runtime: RuntimeFile,
): Promise<{ daemon: ReturnType<typeof spawn>; openTagHome: string; temporaryHome: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runtime.accountComputerId)) {
    throw new Error("The E2E runtime is missing its canonical Account Computer identity");
  }
  const temporaryHome = await mkdtemp(join(tmpdir(), "opentag-e2e-daemon-"));
  const home = join(temporaryHome, "home");
  const openTagHome = join(temporaryHome, "opentag-home");
  const stubBin = join(temporaryHome, "bin");
  await Promise.all([
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(openTagHome, { recursive: true }),
    mkdir(stubBin, { recursive: true }),
  ]);
  await writeFile(join(stubBin, "claude"), CLAUDE_STUB, { mode: 0o755 });
  await writeFile(join(stubBin, "lark-cli"), LARK_CLI_STUB, { mode: 0o755 });
  await Promise.all([chmod(join(stubBin, "claude"), 0o755), chmod(join(stubBin, "lark-cli"), 0o755)]);

  const state = JSON.parse(await readFile(ADMIN_AUTH_STATE, "utf8")) as {
    cookies?: Array<{ name: string; value: string }>;
  };
  const csrf = state.cookies?.find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("The authenticated storage state has no OpenTag CSRF cookie");
  const context = await playwrightRequest.newContext({ baseURL, storageState: ADMIN_AUTH_STATE });
  try {
    const response = await context.post("/api/v1/computer-connect-codes", {
      data: { mode: "repair", targetComputerId: runtime.accountComputerId },
      headers: { Origin: baseURL, "x-opentag-csrf": csrf },
    });
    if (!response.ok())
      throw new Error(`Computer connect code failed with HTTP ${response.status()}: ${await response.text()}`);
    const payload = (await response.json()) as { bootstrapCommand: string };
    const match = /computer connect --server\s+'?([^\s']+)'?\s+--\s+'?([A-Za-z0-9_-]+)'?/.exec(
      payload.bootstrapCommand,
    );
    if (!match?.[2]) throw new Error(`Unexpected computer connect command: ${payload.bootstrapCommand}`);
    const cli = join(repositoryRoot, "apps/cli/dist/cli/index.mjs");
    await execFileAsync(
      process.execPath,
      [cli, "computer", "connect", "--no-start", "--server", baseURL, "--", match[2]],
      {
        env: { ...process.env, HOME: home, OPENTAG_HOME: openTagHome },
      },
    );
  } finally {
    await context.dispose();
  }

  const daemon = spawn(
    process.execPath,
    [join(repositoryRoot, "apps/cli/dist/cli/index.mjs"), "daemon", "service-run"],
    {
      cwd: temporaryHome,
      env: {
        ...process.env,
        HOME: home,
        OPENTAG_HOME: openTagHome,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        PATH: `${stubBin}:/usr/local/bin:/usr/bin:/bin`,
      },
      stdio: "ignore",
    },
  );
  daemon.once("error", () => undefined);
  await waitFor(
    "the E2E Computer to connect",
    async () =>
      Number(await psql(runtime.databaseURL, "select count(*) from computers where current_instance_id is not null")) >
      0,
  );
  return { daemon, openTagHome, temporaryHome };
}

async function stopDaemon(daemon: ReturnType<typeof spawn>, temporaryHome: string): Promise<void> {
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 2_000);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolveExit(undefined);
      });
    });
  }
  if (daemon.exitCode === null) daemon.kill("SIGKILL");
  await rm(temporaryHome, { recursive: true, force: true });
}

async function seedTask(runtime: RuntimeFile, agentId: string): Promise<string> {
  // The account task collection is read-only; seed the same inbound records the real Feishu ingestion path stores.
  const taskId = randomUUID();
  const bindingId = randomUUID();
  const messageId = randomUUID();
  const now = new Date().toISOString();
  const sql = `
    insert into im_bindings (
      id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
      bot_display_name, credential_schema_version, credential_generation, encrypted_credential,
      activated_at, created_at, updated_at
    ) values (
      '${bindingId}', '${agentId}', 'feishu', 'active', 'e2e-app', 'e2e-team', 'e2e-bot',
      'OpenTag E2E Bot', 1, 1, 'e2e-credential', '${now}', '${now}', '${now}'
    );
    insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_at)
      values ('${taskId}', '${bindingId}', 'e2e-channel', 'channel', 'channel', '${now}');
    insert into im_messages (
      id, im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction,
      author_kind, author_external_id, author_display_name, content, provider_context, occurred_at, received_at
    ) values (
      '${messageId}', '${bindingId}', 'e2e-channel', 'e2e-message', 'e2e-revision', 'created', 'inbound',
      'human', 'e2e-user', 'E2E Teammate',
      '{"fallbackText":"Review the seeded E2E task","blocks":[]}'::jsonb,
      '{}'::jsonb, '${now}', '${now}'
    );
    insert into im_message_deliveries (message_id, session_id, attention, state, placement_generation, expires_at)
      values ('${messageId}', '${taskId}', 'direct', 'pending', 1, now() + interval '1 hour');
  `;
  await psql(runtime.databaseURL, sql);
  return taskId;
}

const browserTest = base.extend({
  page: async ({ page }, use, testInfo) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      // Chromium reports this CSP fallback as console.error even though it is emitted by the
      // development server's policy and is not an application failure.
      if (
        message.type() === "error" &&
        !/script-src.*not explicitly set/u.test(message.text()) &&
        !message.text().startsWith("Failed to load resource:")
      ) {
        browserErrors.push(`console.error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      // Chromium reports an in-flight fetch as ERR_ABORTED when a route navigation intentionally replaces it.
      if (request.failure()?.errorText === "net::ERR_ABORTED") return;
      browserErrors.push(
        `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
      );
    });
    await use(page);
    if (browserErrors.length > 0) {
      await testInfo.attach("browser-errors", { body: browserErrors.join("\n"), contentType: "text/plain" });
      throw new Error(browserErrors.join(" | "));
    }
  },
});

export const test = browserTest.extend<Record<never, never>, { e2eRuntime: E2ERuntime }>({
  e2eRuntime: [
    async ({ browser: _browser }, use) => {
      const runtime = JSON.parse(await readFile(join(repositoryRoot, "e2e/.runtime.json"), "utf8")) as RuntimeFile;
      const daemon = await startDaemon(runtime);
      const claudeModePath = join(daemon.openTagHome, "e2e-claude-mode");
      await writeFile(claudeModePath, "pass\n");
      const claudeStubEventCount = async (name: "cancelled" | "started") => {
        try {
          const events = await readFile(join(daemon.openTagHome, `e2e-claude-${name}`), "utf8");
          return events.split("\n").filter(Boolean).length;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      };
      try {
        await use({
          accountComputerId: runtime.accountComputerId,
          claudeStubCancellationCount: () => claudeStubEventCount("cancelled"),
          claudeStubStartCount: () => claudeStubEventCount("started"),
          databaseURL: runtime.databaseURL,
          devEmail: runtime.devEmail,
          setClaudeStubMode: async (mode) => {
            await writeFile(claudeModePath, `${mode}\n`);
          },
          setSetupIncomplete: async () => {
            await psql(
              runtime.databaseURL,
              `update users set setup_completed_at = null, updated_at = now() where id = '${runtime.userId}'`,
            );
          },
          setSetupComplete: async () => {
            await psql(
              runtime.databaseURL,
              `update users set setup_completed_at = now(), updated_at = now() where id = '${runtime.userId}'`,
            );
          },
          seedTask: (agentId) => seedTask(runtime, agentId),
          userId: runtime.userId,
        });
      } finally {
        await stopDaemon(daemon.daemon, daemon.temporaryHome);
      }
    },
    { scope: "worker", auto: true },
  ],
});

/**
 * Smoke tests deliberately do not opt into the worker-scoped daemon fixture. Playwright creates a
 * fresh BrowserContext and Page for every test, so parallel smoke workers do not share mutable IDs
 * or runtime state with one another or with the serial journey project.
 */
export const smokeTest = browserTest.extend<{ smokeAccountReady: undefined }>({
  smokeAccountReady: [
    async ({ browser: _browser }, use) => {
      const runtime = JSON.parse(await readFile(join(repositoryRoot, "e2e/.runtime.json"), "utf8")) as RuntimeFile;
      await psql(
        runtime.databaseURL,
        `update users set setup_completed_at = now(), updated_at = now() where id = '${runtime.userId}'`,
      );
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
