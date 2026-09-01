import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureClientLoggerContext,
  configureClientLoggerForService,
  createLogger,
  resetClientLoggerForTests,
} from "../logger.js";

const directories: string[] = [];
const originalLevel = process.env.OPENTAG_LOG_LEVEL;

afterEach(async () => {
  vi.restoreAllMocks();
  resetClientLoggerForTests();
  if (originalLevel === undefined) delete process.env.OPENTAG_LOG_LEVEL;
  else process.env.OPENTAG_LOG_LEVEL = originalLevel;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Client logger", () => {
  it("redacts and caps the log message, not only the fields", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const logger = createLogger("provider-cli");

    logger.error({ agentId: "agent-1" }, "spawn failed: Authorization: Bearer message-secret");
    logger.error({ agentId: "agent-1" }, "z".repeat(20_000));

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0] as string);
    expect(first.message).not.toContain("message-secret");
    expect(first.message).toContain("[REDACTED]");

    const second = JSON.parse(lines[1] as string);
    expect(new TextEncoder().encode(second.message).byteLength).toBeLessThanOrEqual(4 * 1024);
  });

  it("writes NDJSON child bindings and redacts sensitive structured fields", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    createLogger("daemon")
      .child({ computerId: "computer-1", instanceId: "instance-1", module: "turn" })
      .child({ agentId: "agent-1", computerId: "computer-1", instanceId: "instance-1" })
      .info(
        {
          accessToken: "access-secret",
          auth: { refreshToken: "refresh-secret" },
          headers: { authorization: "Bearer secret", cookie: "session=secret" },
          sessionId: "session-1",
        },
        "Turn started",
      );

    const raw = (await readFile(join(directory, "client.log"), "utf8")).trim();
    const record = JSON.parse(raw);
    expect(record).toMatchObject({ agentId: "agent-1", level: 30, message: "Turn started", module: "turn" });
    expect(record.time).toEqual(expect.any(String));
    expect(JSON.stringify(record)).not.toContain("access-secret");
    expect(JSON.stringify(record)).not.toContain("refresh-secret");
    expect(JSON.stringify(record)).not.toContain("Bearer secret");
    expect(JSON.stringify(record)).not.toContain("session=secret");
    for (const key of ["module", "computerId", "instanceId"]) {
      expect(raw.match(new RegExp(`"${key}":`, "gu"))).toHaveLength(1);
    }
  });

  it("inherits process context and scrubs sensitive string values", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerContext({ instanceId: "instance-1", processRole: "daemon" });
    configureClientLoggerForService(directory);
    createLogger("daemon").info({ error: { message: "Authorization: Bearer embedded-secret" } }, "Observed failure");

    const raw = await readFile(join(directory, "client.log"), "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record).toMatchObject({ instanceId: "instance-1", processRole: "daemon" });
    expect(raw).not.toContain("embedded-secret");
  });

  it("treats repeated configuration as a no-op and rejects another directory", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    configureClientLoggerForService(first);
    expect(() => configureClientLoggerForService(first)).not.toThrow();
    expect(() => configureClientLoggerForService(second)).toThrow("different log directory");
  });

  it("falls back to info and emits a safe warning for an invalid configured level", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "credential-value";
    configureClientLoggerForService(directory);
    createLogger("daemon").info({}, "Daemon startup started");
    const content = await readFile(join(directory, "client.log"), "utf8");
    expect(content).toContain("Invalid OPENTAG_LOG_LEVEL; using info");
    expect(content).toContain("Daemon startup started");
    expect(content).not.toContain("credential-value");
  });

  it("is silent in tests unless an explicit level is configured", async () => {
    delete process.env.OPENTAG_LOG_LEVEL;
    const silentDirectory = await temporaryDirectory();
    configureClientLoggerForService(silentDirectory);
    createLogger("test").warn({}, "Hidden test diagnostic");
    expect(await readFile(join(silentDirectory, "client.log"), "utf8")).toBe("");

    resetClientLoggerForTests();
    process.env.OPENTAG_LOG_LEVEL = "debug";
    const visibleDirectory = await temporaryDirectory();
    configureClientLoggerForService(visibleDirectory);
    createLogger("test").debug({}, "Visible configured diagnostic");
    expect(await readFile(join(visibleDirectory, "client.log"), "utf8")).toContain("Visible configured diagnostic");
  });
});

async function temporaryDirectory(): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opentag-logger-")));
  directories.push(directory);
  return directory;
}
