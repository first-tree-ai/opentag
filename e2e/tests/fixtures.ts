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
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version) echo "9.9.9 (opentag-e2e-stub)" ;;
  --help) echo "stream-json --session-id --resume --mcp-config --strict-mcp-config --allowedTools --append-system-prompt" ;;
  auth) echo '{"loggedIn":true}' ;;
  *) echo "opentag e2e stub does not run turns" >&2; exit 1 ;;
esac
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

export interface E2ERuntime {
  accountComputerId: string;
  databaseURL: string;
  devEmail: string;
  setSetupIncomplete(): Promise<void>;
  setSetupComplete(): Promise<void>;
  seedTask(agentId: string): Promise<string>;
  userId: string;
  workspaceId: string;
}

interface RuntimeFile {
  accountComputerId: string;
  adminDatabaseURL: string;
  baseURL: string;
  databaseURL: string;
  devEmail: string;
  userId: string;
  workspaceId: string;
}

function connectionTarget(url: string): { dsn: string; password: string } {
  const target = new URL(url);
  const password = decodeURIComponent(target.password);
  target.password = "";
  return { dsn: target.href, password };
}

async function psql(url: string, sql: string): Promise<string> {
  const { dsn, password } = connectionTarget(url);
  const { stdout } = await execFileAsync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    env: { ...process.env, PGPASSWORD: password },
  });
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

async function startDaemon(runtime: RuntimeFile): Promise<{ daemon: ReturnType<typeof spawn>; temporaryHome: string }> {
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
      data: {},
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
      Number(
        await psql(runtime.databaseURL, "select count(*) from account_computers where current_instance_id is not null"),
      ) > 0,
  );
  return { daemon, temporaryHome };
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

export const test = base.extend<Record<never, never>, { e2eRuntime: E2ERuntime }>({
  page: async ({ page }, use, testInfo) => {
    const browserErrors: string[] = [];
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
  e2eRuntime: [
    async ({ browser: _browser }, use) => {
      const runtime = JSON.parse(await readFile(join(repositoryRoot, "e2e/.runtime.json"), "utf8")) as RuntimeFile;
      const daemon = await startDaemon(runtime);
      try {
        await use({
          accountComputerId: runtime.accountComputerId,
          databaseURL: runtime.databaseURL,
          devEmail: runtime.devEmail,
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
          workspaceId: runtime.workspaceId,
        });
      } finally {
        await stopDaemon(daemon.daemon, daemon.temporaryHome);
      }
    },
    { scope: "worker", auto: true },
  ],
});

export { expect };
