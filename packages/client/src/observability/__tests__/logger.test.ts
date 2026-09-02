import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const stderrWrites = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock("../rotating-file-stream.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rotating-file-stream.js")>();
  return { ...original, writeStringToFileDescriptor: stderrWrites.write };
});

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
  stderrWrites.write.mockReset();
  resetClientLoggerForTests();
  if (originalLevel === undefined) delete process.env.OPENTAG_LOG_LEVEL;
  else process.env.OPENTAG_LOG_LEVEL = originalLevel;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Client logger", () => {
  it("does not create the service log directory until the first write", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "nested", "logs");
    process.env.OPENTAG_LOG_LEVEL = "info";

    configureClientLoggerForService(directory);
    expect(await pathExists(directory)).toBe(false);
    const logger = createLogger("lazy");
    expect(await pathExists(directory)).toBe(false);

    logger.info({}, "First diagnostic");

    expect(await pathExists(directory)).toBe(true);
    await expect(readFile(join(directory, "client.log"), "utf8")).resolves.toContain("First diagnostic");
  });

  it("writes a terminal daemon failure to stderr and the file sink", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);

    createLogger("daemon", { destination: "dual" }).warn(
      { category: "ownership" },
      "Daemon is already running; inspect daemon status",
    );

    const message = "Daemon is already running; inspect daemon status";
    await expect(readFile(join(directory, "client.log"), "utf8")).resolves.toContain(message);
    expect(stderrWrites.write).toHaveBeenCalledWith(2, expect.stringContaining(message));
  });

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

  it("caps an over-long process context value in the emitted record", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerContext({ instanceId: "x".repeat(20_000) });
    configureClientLoggerForService(directory);
    createLogger("daemon").info({}, "Context bounded");

    const raw = await readFile(join(directory, "client.log"), "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.instanceId).toEqual(expect.stringContaining("[TRUNCATED]"));
    expect(new TextEncoder().encode(record.instanceId as string).byteLength).toBeLessThanOrEqual(4 * 1024);
  });

  it("scrubs reproduced credential leaks at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const logger = createLogger("boundary");
    const messages = [
      "headers:\n  Cookie: session=first-secret; admin=second-secret\nX-Safe: ok",
      '{"set-cookie":["session=first-secret","admin=second-secret"]}',
      '{"headers":"Cookie: session=first-secret; admin=second-secret"}',
      'req:\n\tAuthorization: Digest u="x", nonce="deadbeef"\nX-Safe: ok',
    ];

    for (const message of messages) logger.error({}, message);

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(messages.length);
    const records = lines.map((line) => JSON.parse(line) as { message: string });
    const emitted = records.map((record) => record.message).join("\n");
    for (const secret of ["first-secret", "second-secret", "deadbeef"]) expect(emitted).not.toContain(secret);
    expect(records[0]?.message).toContain("X-Safe: ok");
    expect(records[3]?.message).toContain("X-Safe: ok");
    expect(() => JSON.parse(records[1]?.message ?? "")).not.toThrow();
  });

  it("scrubs a colon-bearing folded continuation at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    createLogger("boundary").error({}, "Cookie: a=first-secret\r\n  b: second-secret\r\nX-Safe: ok");

    const raw = await readFile(join(directory, "client.log"), "utf8");
    const record = JSON.parse(raw.trim()) as { message: string };
    expect(record.message).toBe("Cookie: [REDACTED]\r\nX-Safe: ok");
    expect(raw).not.toContain("first-secret");
    expect(raw).not.toContain("second-secret");
    expect(record.message).toContain("X-Safe: ok");
  });

  it("scrubs literal-backslash escaped serialized credentials at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const message = String.raw`{\"cookie\":\"session=first-secret; admin=second-secret\",\"other\":\"keep\"}`;
    createLogger("boundary").error({}, message);

    const raw = await readFile(join(directory, "client.log"), "utf8");
    const record = JSON.parse(raw.trim()) as { message: string };
    expect(record.message).toBe(String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`);
    expect(raw).not.toContain("first-secret");
    expect(raw).not.toContain("second-secret");
    expect(record.message).toContain(String.raw`\"other\":\"keep\"`);
  });

  it("scrubs review-round five shapes without losing serialized siblings", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const cases = [
      [
        String.raw`{\"authorization\":\"Digest username=\\\"u\\\", realm=\\\"tenant\\\", nonce=\\\"deep-secret\\\"\",\"other\":\"keep\"}`,
        String.raw`{\"authorization\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        "headers:\n  - Cookie: session=first-secret; admin=second-secret\n  - X-Safe: ok",
        "headers:\n  - Cookie: [REDACTED]\n  - X-Safe: ok",
      ],
      [
        "headers:\n  1. Cookie: session=first-secret; admin=second-secret\n  2. X-Safe: ok",
        "headers:\n  1. Cookie: [REDACTED]\n  2. X-Safe: ok",
      ],
      [
        String.raw`{\"set-cookie\":[\"session=first-secret\",\"admin=second-secret\"],\"other\":\"keep\"}`,
        String.raw`{\"set-cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
    ] as const;

    const logger = createLogger("review-round-five");
    for (const [message] of cases) logger.error({}, message);

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(cases.length);
    const records = lines.map((line) => JSON.parse(line) as { message: string });
    expect(records.map((record) => record.message)).toEqual(cases.map(([, expected]) => expected));
    const emitted = records.map((record) => record.message).join("\n");
    for (const secret of ["deep-secret", "first-secret", "admin=second-secret"]) expect(emitted).not.toContain(secret);
    expect(emitted).toContain(String.raw`\"other\":\"keep\"`);
    expect(emitted).toContain("- X-Safe: ok");
    expect(emitted).toContain("2. X-Safe: ok");
  });

  it("scrubs encoded line breaks inside serialized credential values at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const cases = [
      [
        String.raw`{\"cookie\":\"a=1\r\nb=deep-secret\",\"other\":\"keep\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"cookie\":\"a=1\nb=deep-secret\",\"other\":\"keep\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"cookie\":\"a=1\n  b=deep-secret\",\"other\":\"keep\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"authorization\":\"Bearer x\nnonce=deep-secret\",\"other\":\"keep\"}`,
        String.raw`{\"authorization\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"set-cookie\":[\"a=1\nb=deep-secret\"],\"other\":\"keep\"}`,
        String.raw`{\"set-cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
    ] as const;

    const logger = createLogger("encoded-line-breaks");
    for (const [message] of cases) logger.error({}, message);

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as { message: string });
    expect(records.map((record) => record.message)).toEqual(cases.map(([, expected]) => expected));
    const emitted = records.map((record) => record.message).join("\n");
    expect(emitted).not.toContain("deep-secret");
    expect(emitted).toContain(String.raw`\"other\":\"keep\"`);
  });

  it("scrubs encoded line breaks in unquoted serialized values at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const cases = [
      [
        String.raw`{\"cookie\":session=a\nb=deep-secret,\"other\":\"keep\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"cookie\":session=a\r\nb=deep-secret,\"other\":\"keep\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
      [
        String.raw`{\"authorization\":Bearer\nx=deep-secret,\"other\":\"keep\"}`,
        String.raw`{\"authorization\":\"[REDACTED]\",\"other\":\"keep\"}`,
      ],
    ] as const;

    const logger = createLogger("unquoted-encoded-line-breaks");
    for (const [message] of cases) logger.error({}, message);

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as { message: string });
    expect(records.map((record) => record.message)).toEqual(cases.map(([, expected]) => expected));
    const emitted = records.map((record) => record.message).join("\n");
    expect(emitted).not.toContain("deep-secret");
    expect(emitted).toContain(String.raw`\"other\":\"keep\"`);
  });

  it("scopes serialized credential scrubbing at the emitted NDJSON boundary", async () => {
    const directory = await temporaryDirectory();
    process.env.OPENTAG_LOG_LEVEL = "info";
    configureClientLoggerForService(directory);
    const cases = [
      [
        String.raw`spawn failed at C:\Users\me\bin: {\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
        String.raw`spawn failed at C:\Users\me\bin: {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
        String.raw`C:\Users\me\bin`,
      ],
      [
        String.raw`{\"cookie\":\"session=first-secret\",\"url\":\"https:\/\/api.example.com\/v1\"}`,
        String.raw`{\"cookie\":\"[REDACTED]\",\"url\":\"https:\/\/api.example.com\/v1\"}`,
        String.raw`https:\/\/api.example.com\/v1`,
      ],
      [
        String.raw`line one
{\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
        String.raw`line one
{\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
        "line one\n",
      ],
      [
        String.raw`col1${"\t"}col2 {\"cookie\":\"session=first-secret\",\"other\":\"keep\"}`,
        String.raw`col1${"\t"}col2 {\"cookie\":\"[REDACTED]\",\"other\":\"keep\"}`,
        "col1\tcol2",
      ],
    ] as const;

    const logger = createLogger("serialized-field-scope");
    for (const [message] of cases) logger.error({}, message);

    const lines = (await readFile(join(directory, "client.log"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(cases.length);
    const records = lines.map((line) => JSON.parse(line) as { message: string });
    expect(records.map((record) => record.message)).toEqual(cases.map(([, expected]) => expected));
    for (const [index, [, , context]] of cases.entries()) {
      expect(records[index]?.message).toContain(context);
      expect(records[index]?.message).not.toBe("[REDACTED]");
    }
    expect(records.map((record) => record.message).join("\n")).not.toContain("first-secret");
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
    expect(await pathExists(join(silentDirectory, "client.log"))).toBe(false);

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
