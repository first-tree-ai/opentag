import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { runCli } from "../cli/run.js";
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
});
