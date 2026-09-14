import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPortAvailable,
  ensureDir,
  execFileAsync,
  spawnLogged,
  stopChild,
  waitFor,
  withTimeout,
} from "./common.mjs";
import { createBrowserApi, createCookieJar, signInDev } from "./http.mjs";
import { SLACK_STUB_PATH } from "./im-stub.mjs";
import { startDisposablePostgres } from "./postgres.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEV_EMAIL = "e1-local-pi@opentag.local";
const PI_CONFIG_NAMES = ["settings.json", "models.json", "auth.json", "models-store.json", "trust.json"];

function copyEnvWithoutSecrets(source) {
  const allowed = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function credentialValues(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry === "object") return credentialValues(entry);
    return typeof entry === "string" && /api.?key|token|secret|password/i.test(key) ? [entry] : [];
  });
}

async function copyPiConfigSilently(sourceDir, destinationDir, secrets) {
  await ensureDir(destinationDir);
  await chmod(destinationDir, 0o700);
  let copied = 0;
  for (const name of PI_CONFIG_NAMES) {
    const from = join(sourceDir, name);
    if (!existsSync(from)) continue;
    const to = join(destinationDir, name);
    await copyFile(from, to);
    await chmod(to, 0o600);
    try {
      secrets.push(...credentialValues(JSON.parse(await readFile(to, "utf8"))));
    } catch {
      // Redaction is best-effort; never emit the file.
    }
    copied += 1;
  }
  if (copied === 0) {
    throw new Error("Pi config source had none of the expected files; refusing to run without a real credential");
  }
  return copied;
}

async function stopFixture(resources) {
  const failures = [];
  const steps = [
    () => stopChild(resources.daemon, { name: "daemon", graceMs: 10_000 }),
    () => stopChild(resources.server, { name: "server", graceMs: 10_000 }),
    () => (resources.keep ? undefined : resources.postgres?.stop()),
    () => rm(resources.workspace, { recursive: true, force: true }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(String(error.message));
    }
  }
  return failures;
}

export async function createLocalPiFixture({ repositoryRoot, artifactDirectory, port }) {
  const workspace = await mkdtemp(join(tmpdir(), "opentag-e1-local-pi-"));
  const resources = { workspace, keep: process.env.OPENTAG_E1_KEEP === "on" };
  try {
    const clientHome = join(workspace, "home");
    const openTagHome = join(workspace, "opentag-home");
    const stubBin = join(workspace, "bin");
    const piConfigDir = join(workspace, "pi-agent");
    await Promise.all([
      ensureDir(clientHome),
      ensureDir(openTagHome),
      ensureDir(stubBin),
      ensureDir(artifactDirectory),
    ]);

    const slackStub = join(stubBin, "slack");
    await copyFile(SLACK_STUB_PATH, slackStub);
    await chmod(slackStub, 0o755);

    const sourceEnvironment = process.env;
    const piSource = sourceEnvironment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const secrets = [];
    const piConfigFiles = await copyPiConfigSilently(piSource, piConfigDir, secrets);

    const encryptionKey = Buffer.alloc(32, 7);
    const jwtSecret = randomBytes(32).toString("hex");
    const betterAuthSecret = randomBytes(32).toString("hex");
    const serverLogPath = join(artifactDirectory, "server.log");
    const daemonLogPath = join(artifactDirectory, "daemon.log");
    const baseUrl = `http://127.0.0.1:${port}`;
    const keep = process.env.OPENTAG_E1_KEEP === "on";

    const serverEntry = join(repositoryRoot, "packages", "server", "dist", "index.mjs");
    const cliEntry = join(repositoryRoot, "apps", "cli", "dist", "cli", "index.mjs");
    if (!existsSync(serverEntry) || !existsSync(cliEntry)) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Run pnpm build before this check (packages/server/dist and apps/cli/dist are required)");
    }

    const postgres = await startDisposablePostgres();
    resources.postgres = postgres;
    secrets.push(
      postgres.password,
      postgres.databaseUrl,
      jwtSecret,
      betterAuthSecret,
      encryptionKey.toString("base64"),
    );
    let server;
    let daemon;
    let serverExited;

    const abortStartup = async (error) => {
      if (server) await stopChild(server, { name: "server" }).catch(() => undefined);
      await postgres.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    };

    try {
      await assertPortAvailable(port);
    } catch (error) {
      await abortStartup(error);
    }
    server = spawnLogged(process.execPath, [serverEntry], {
      cwd: repositoryRoot,
      logPath: serverLogPath,
      secrets,
      env: {
        ...copyEnvWithoutSecrets(process.env),
        HOME: clientHome,
        OPENTAG_DATABASE_URL: postgres.databaseUrl,
        OPENTAG_AUTO_MIGRATE: "true",
        OPENTAG_ENV: "dev",
        OPENTAG_HOST: "127.0.0.1",
        OPENTAG_PORT: String(port),
        OPENTAG_PUBLIC_URL: baseUrl,
        OPENTAG_JWT_SECRET: jwtSecret,
        BETTER_AUTH_SECRET: betterAuthSecret,
        OPENTAG_ENCRYPTION_KEY: encryptionKey.toString("base64"),
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: DEV_EMAIL,
        OPENTAG_LOG_LEVEL: "info",
      },
    });
    resources.server = server;
    const listening = new Promise((settle) => {
      let announced = "";
      server.stdout.on("data", (chunk) => {
        if (announced.length > 8_192) announced = announced.slice(-1_024);
        announced += String(chunk);
        if (announced.includes(`Server listening at ${baseUrl}`)) settle(undefined);
      });
    });
    serverExited = new Promise((_, fail) => {
      server.once("exit", (code) => fail(new Error(`Server exited with ${code}; see ${serverLogPath}`)));
    });
    serverExited.catch(() => undefined);
    let cookies;
    let api;
    try {
      await withTimeout(Promise.race([listening, serverExited]), 60_000, `Server did not bind ${baseUrl} within 60s`);
      await waitFor("the Server health endpoint", async () => (await fetch(`${baseUrl}/healthz`)).ok);
      await postgres.psql(
        `insert into users (id, email, display_name) values ('${USER_ID}', '${DEV_EMAIL}', 'E1 Local Pi');`,
      );
      cookies = createCookieJar();
      await signInDev({ baseUrl, cookies });
      api = createBrowserApi({ baseUrl, cookies });
    } catch (error) {
      await abortStartup(error);
    }

    const daemonEnv = () => ({
      ...copyEnvWithoutSecrets(process.env),
      HOME: clientHome,
      OPENTAG_HOME: openTagHome,
      PI_CODING_AGENT_DIR: piConfigDir,
      CODEX_HOME: join(clientHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(clientHome, ".claude"),
      PATH: `${stubBin}:${process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"}`,
    });

    async function startDaemon() {
      const child = spawnLogged(process.execPath, [cliEntry, "daemon", "service-run"], {
        cwd: workspace,
        logPath: daemonLogPath,
        secrets,
        env: daemonEnv(),
      });
      child.once("exit", () => undefined);
      return child;
    }

    async function connectComputer() {
      const issued = await api.post("/api/v1/computer-connect-codes", { mode: "create" });
      const { parseConnectCode } = await import("./observe.mjs");
      const connect = parseConnectCode(issued.bootstrapCommand);
      secrets.push(connect.code);
      if (connect.serverUrl !== baseUrl) {
        throw new Error(`Connect command targeted ${connect.serverUrl}, expected ${baseUrl}`);
      }
      await execFileAsync(
        process.execPath,
        [cliEntry, "computer", "connect", "--no-start", "--server", baseUrl, "--", connect.code],
        {
          env: daemonEnv(),
        },
      );
      return issued.connectCodeId;
    }

    const stopAll = () => stopFixture(resources);

    return {
      USER_ID,
      DEV_EMAIL,
      repositoryRoot,
      workspace,
      clientHome,
      openTagHome,
      stubBin,
      piConfigDir,
      piConfigFiles,
      piSourcePresent: existsSync(piSource),
      encryptionKey,
      redact: (text) => secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), String(text)),
      artifactDirectory,
      serverLogPath,
      daemonLogPath,
      baseUrl,
      port,
      postgres,
      api,
      cookies,
      serverEntry,
      cliEntry,
      keep,
      get server() {
        return server;
      },
      get daemon() {
        return daemon;
      },
      setDaemon(child) {
        daemon = child;
        resources.daemon = child;
      },
      startDaemon,
      connectComputer,
      stopAll,
      serverExited,
    };
  } catch (error) {
    resources.keep = false;
    const failures = await stopFixture(resources);
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `Fixture startup failed: ${error.message}; cleanup failed: ${failures.join("; ")}`,
      );
    throw error;
  }
}
