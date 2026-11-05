import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { ignoreBrokenPipeOnStream, runCli } from "../cli/run.js";
import { CommandError, executeCommand } from "../core/command/policy.js";

// One home for the whole file: the client logger accepts a single service log directory per process.
let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "opentag-cli-run-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function programWith(commands: (program: ReturnType<typeof createProgram>) => void) {
  const program = createProgram({ json: true });
  commands(program);
  return program;
}

function run(program: ReturnType<typeof createProgram>, args: string[]) {
  const report = vi.fn().mockResolvedValue({ ok: true });
  const exit = vi.fn();
  const exitCode = runCli({
    argv: ["node", "opentag", ...args],
    env: { ...process.env, OPENTAG_HOME: home },
    program,
    report,
    exit,
    processHandlers: false,
  });
  return { exitCode, exit, report };
}

describe("runCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a failure the shared execution path handled, exactly once, with the command path", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failure = new Error("agent listing exploded");
    const program = programWith((root) => {
      root
        .command("explode")
        .description("test-only command whose operation fails inside executeCommand")
        .action(async () => {
          process.exitCode = await executeCommand(async () => {
            throw failure;
          });
        });
    });

    const { exitCode, exit, report } = run(program, ["explode"]);

    await expect(exitCode).resolves.toBe(0);
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    const [error, commandError, context] = report.mock.calls[0] ?? [];
    expect(error).toBe(failure);
    expect(commandError).toBeInstanceOf(CommandError);
    expect((commandError as CommandError).category).toBe("internal");
    expect(context).toMatchObject({ command: "explode", home });
    expect(exit).not.toHaveBeenCalled();
    process.exitCode = 0;
  });

  it("reports a failure that escaped to the entry point once and presents it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failure = new Error("action threw directly");
    const program = programWith((root) => {
      root
        .command("escape")
        .description("test-only command whose action throws")
        .action(async () => {
          throw failure;
        });
    });

    const { exitCode, report } = run(program, ["escape"]);

    await expect(exitCode).resolves.toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      failure,
      expect.any(CommandError),
      expect.objectContaining({ command: "escape" }),
    );
    expect(String(stderr.mock.calls[0]?.[0])).toContain("INTERNAL_ERROR: action threw directly");
  });

  it("turns a Commander usage error into exit code 2 without reporting it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { exitCode, exit, report } = run(createProgram({ json: true }), ["no-such-command"]);

    await expect(exitCode).resolves.toBe(2);
    expect(exit).toHaveBeenCalledExactlyOnceWith(2);
    expect(report).not.toHaveBeenCalled();
  });

  it("exits with code 0 without writing stderr or reporting when a command's stdout write throws EPIPE", async () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw epipe;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = programWith((root) => {
      root
        .command("pipe-closed")
        .description("test-only command whose stdout write hits EPIPE")
        .action(async () => {
          process.stdout.write("hello\n");
        });
    });

    const { exitCode, exit, report } = run(program, ["pipe-closed"]);

    await expect(exitCode).resolves.toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports and exits with code 1 when a command throws a non-output EPIPE (such as a child stdin pipe failure)", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      input: Buffer.alloc(4 * 1024 * 1024),
      timeout: 2000,
    });
    const childStdinEpipe =
      child.error ?? Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
    const program = programWith((root) => {
      root
        .command("child-stdin-epipe")
        .description("test-only command whose child stdin pipe hits EPIPE")
        .action(async () => {
          throw childStdinEpipe;
        });
    });

    const { exitCode, exit, report } = run(program, ["child-stdin-epipe"]);

    await expect(exitCode).resolves.toBe(1);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      childStdinEpipe,
      expect.objectContaining({ code: "EPIPE", category: "internal" }),
      expect.objectContaining({ command: "child-stdin-epipe" }),
    );
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^EPIPE: .*EPIPE/u);
    expect(exit).not.toHaveBeenCalled();
  });

  it("idempotently ignores EPIPE error events on output streams and rethrows non-EPIPE stream errors", async () => {
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    const report = vi.fn().mockResolvedValue({ ok: true });
    const program = programWith((root) => {
      root.command("noop").action(async () => undefined);
    });

    await expect(
      runCli({
        argv: ["node", "opentag", "noop"],
        env: { ...process.env, OPENTAG_HOME: home },
        program,
        report,
        processHandlers: false,
        stdoutStream,
        stderrStream,
      }),
    ).resolves.toBe(0);
    await expect(
      runCli({
        argv: ["node", "opentag", "noop"],
        env: { ...process.env, OPENTAG_HOME: home },
        program,
        report,
        processHandlers: false,
        stdoutStream,
        stderrStream,
      }),
    ).resolves.toBe(0);

    expect(stdoutStream.listenerCount("error")).toBe(1);
    expect(stderrStream.listenerCount("error")).toBe(1);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
    expect(() => stdoutStream.emit("error", epipe)).not.toThrow();
    expect(() => stderrStream.emit("error", new Error("wrapped", { cause: epipe }))).not.toThrow();
    expect(() => stdoutStream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }))).toThrow(
      "write EIO",
    );
    expect(report).not.toHaveBeenCalled();

    const customStream = new EventEmitter();
    ignoreBrokenPipeOnStream(customStream);
    ignoreBrokenPipeOnStream(customStream);
    expect(customStream.listenerCount("error")).toBe(1);
  });
});
