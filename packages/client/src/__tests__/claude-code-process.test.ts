import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeProcess, ClaudeCodeProcessError } from "../providers/claude-code/process-wire.js";

const fixture = fileURLToPath(new URL("./fixtures/claude-code-stream.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("ClaudeCodeProcess", () => {
  it("initializes permission control before sending the prompt and writes the response to the same process", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = new ClaudeCodeProcess({
      args: ["--permission-prompt-tool", "stdio"],
      cwd: "/",
      env: {},
      spawnProcess: () => child,
    });
    const run = process.execute({ type: "user", text: "work" }, () => undefined, new AbortController().signal);
    expect(writes.map((line) => JSON.parse(line))).toEqual([
      { type: "control_request", request_id: "opentag_initialize", request: { subtype: "initialize", hooks: null } },
    ]);
    child.stdout.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "opentag_initialize" } })}\n`,
    );
    expect(JSON.parse(writes[1] ?? "")).toEqual({ type: "user", text: "work" });
    await process.send({ type: "control_response", response: { request_id: "approval-1" } });
    expect(JSON.parse(writes[2] ?? "")).toMatchObject({ type: "control_response" });
    await expect(process.send({ value: "x".repeat(8 * 1024 * 1024) })).rejects.toMatchObject({ code: "protocol" });
    child.stdout.write('{"type":"result"}\n');
    await expect(process.send({ type: "late" })).rejects.toMatchObject({ code: "exited" });
    child.emit("exit", 0, null);
    await run;
    await process.close();
  });

  it("keeps the query open across results until every steered input has started", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = fakeProcess(child);
    const seen: [unknown, boolean | undefined][] = [];
    await expect(process.steer({ type: "user", uuid: "early" })).rejects.toMatchObject({ code: "exited" });
    const run = process.execute(
      { type: "user", text: "first" },
      (message, terminal) => seen.push([message.type, terminal]),
      new AbortController().signal,
    );
    const handle = await process.steer({ type: "user", uuid: "steer-1" });
    await expect(process.steer({ type: "user", uuid: "big", text: "x".repeat(8 * 1024 * 1024) })).rejects.toMatchObject(
      { code: "protocol" },
    );
    expect(writes.map((line) => JSON.parse(line).uuid)).toEqual([undefined, "steer-1"]);
    child.stdout.write('{"type":"command_lifecycle","command_uuid":"steer-1","state":"queued"}\n');
    child.stdout.write('{"type":"result"}\n');
    // A result before the steer started is not terminal: input can still be written.
    await process.send({ type: "control_response" });
    // Written and queued is not started: the process could still exit without processing it.
    expect(handle.started()).toBe(false);
    // A lifecycle for a command this process did not steer (the prompt itself) changes nothing.
    child.stdout.write('{"type":"command_lifecycle","command_uuid":"prompt","state":"started"}\n');
    child.stdout.write('{"type":"command_lifecycle","command_uuid":"steer-1","state":"started"}\n');
    expect(handle.started()).toBe(true);
    child.stdout.write('{"type":"result"}\n');
    expect(seen).toEqual([
      ["command_lifecycle", false],
      ["result", false],
      ["command_lifecycle", false],
      ["command_lifecycle", false],
      ["result", true],
    ]);
    await expect(process.steer({ type: "user", uuid: "late" })).rejects.toMatchObject({ code: "exited" });
    child.emit("exit", 0, null);
    await run;
    await process.close();
  });

  it("waits past a result Claude Code generated itself on resume for the prompt's own result", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: [unknown, boolean | undefined][] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message, terminal) => seen.push([message.result, terminal]),
      new AbortController().signal,
    );
    // Claude Code 2.1.319 on `--resume` after a background task was orphaned.
    child.stdout.write(`${JSON.stringify(selfGeneratedResult)}\n`);
    await process.send({ type: "control_response" });
    child.stdout.write('{"type":"result","result":"answer","user_message_uuids":["prompt"]}\n');
    expect(seen).toEqual([
      ["", false],
      ["answer", true],
    ]);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "" });
  });

  it("ends the Run on a result that names user input even when it has an origin", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify({ ...selfGeneratedResult, user_message_uuids: [] })}\n`);
    child.stdout.write(`${JSON.stringify({ ...selfGeneratedResult, user_message_uuids: ["prompt"] })}\n`);
    expect(seen).toEqual([false, true]);
    child.emit("exit", 143, null);
    await run;
  });

  it("ends the Run on a failed result that Claude Code generated itself", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify({ ...selfGeneratedResult, is_error: true })}\n`);
    expect(seen).toEqual([true]);
    child.emit("exit", 1, null);
    await run;
  });

  it("tells the Session once about background work that stops with the Run, then reports what was left", async () => {
    const child = fakeChild();
    const writes: Record<string, never>[] = [];
    child.stdin.on("data", (line) => writes.push(JSON.parse(line.toString())));
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a", description: "Run the suite" }))}\n`);
    child.stdout.write('{"type":"result","result":"started"}\n');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    const notice = writes[1] as unknown as { uuid: string; message: { content: [{ text: string }] } };
    expect(notice.message.content[0].text).toContain("[openTag notice] This Run is about to end.");
    expect(notice.message.content[0].text).toContain("- Run the suite (local_bash)");
    child.stdout.write(
      `${JSON.stringify({ type: "command_lifecycle", command_uuid: notice.uuid, state: "started" })}\n`,
    );
    child.stdout.write('{"type":"result","result":"told them"}\n');
    // Stopping the process empties the task list; what was left is the list at the terminal result.
    child.stdout.write(`${JSON.stringify(backgroundTasks())}\n`);
    expect(seen.filter(Boolean)).toHaveLength(1);
    expect(writes).toHaveLength(2);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({
      stderr: "",
      abandonedBackgroundWork: ["Run the suite (local_bash)"],
    });
  });

  it("reports nothing when the Session finished its background work after the notice", async () => {
    const child = fakeChild();
    const writes: { uuid?: string }[] = [];
    child.stdin.on("data", (line) => writes.push(JSON.parse(line.toString())));
    const process = fakeProcess(child);
    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdout.write('{"type":"result"}\n');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    child.stdout.write(`${JSON.stringify(backgroundTasks())}\n`);
    child.stdout.write(
      `${JSON.stringify({ type: "command_lifecycle", command_uuid: writes[1]?.uuid, state: "completed" })}\n`,
    );
    child.stdout.write('{"type":"result"}\n');
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "" });
  });

  describe("timers in the process", () => {
    const toolUse = (id: string, name: string, input: unknown = {}) => ({
      type: "assistant",
      message: { content: [{ type: "text" }, { type: "tool_use", id, name, input }, "invalid"] },
    });
    const toolResult = (id: string, extra: Record<string, unknown> = {}, toolUseResult?: unknown) => ({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
      ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
    });

    /** Runs the frames, then a result; returns what was left and the notice, if one went out. */
    async function runWith(frames: Record<string, unknown>[]) {
      const child = fakeChild();
      const writes: string[] = [];
      child.stdin.on("data", (line) => writes.push(line.toString()));
      const process = fakeProcess(child);
      const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
      for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
      child.stdout.write('{"type":"assistant","message":{}}\n{"type":"result"}\n');
      await new Promise((resolve) => setImmediate(resolve));
      if (writes.length > 1) child.stdout.write('{"type":"result"}\n');
      child.emit("exit", 143, null);
      return { ...(await run), notice: writes[1] };
    }

    it("counts a cron job and a wakeup whose tool succeeded", async () => {
      await expect(
        runWith([
          toolUse("a", "CronCreate"),
          toolResult("a", {}, { id: "job-1", durable: false }),
          toolUse("b", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("b"),
          // Without a job id, the tool call identifies it.
          toolUse("c", "CronCreate", "invalid"),
          toolResult("c", {}, "invalid"),
          // Not a timer, and a result for a call never seen.
          toolUse("d", "Bash"),
          toolResult("d"),
          toolResult("unseen"),
        ]),
      ).resolves.toMatchObject({
        abandonedBackgroundWork: ["CronCreate job job-1", "ScheduleWakeup timer", "CronCreate job c"],
        notice: expect.stringContaining("- CronCreate job job-1"),
      });
    });

    it("does not count a timer whose tool has no result yet or failed", async () => {
      await expect(
        runWith([
          toolUse("a", "CronCreate", { cron: "not a cron" }),
          toolResult("a", { is_error: true }, "Error: Invalid cron expression"),
          toolUse("b", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("b", { is_error: true }),
          toolUse("c", "CronCreate"),
        ]),
      ).resolves.toEqual({ stderr: "", notice: undefined });
    });

    it("does not count a cron job written to disk", async () => {
      await expect(
        runWith([toolUse("a", "CronCreate"), toolResult("a", {}, { id: "job-1", durable: true })]),
      ).resolves.toEqual({ stderr: "", notice: undefined });
    });

    it("stops counting a cron job once it is deleted, and only that one", async () => {
      await expect(
        runWith([
          toolUse("a", "CronCreate"),
          toolResult("a", {}, { id: "job-1", durable: false }),
          toolUse("b", "CronCreate"),
          toolResult("b", {}, { id: "job-2", durable: false }),
          toolUse("c", "CronDelete", { id: "job-1" }),
          toolResult("c", {}, { id: "job-1" }),
          toolUse("d", "CronDelete", { id: "job-2" }),
          toolResult("d", { is_error: true }),
        ]),
      ).resolves.toMatchObject({ abandonedBackgroundWork: ["CronCreate job job-2"] });
    });

    it("stops counting a wakeup once it is stopped", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a"),
          toolUse("b", "ScheduleWakeup", { stop: true }),
          toolResult("b"),
        ]),
      ).resolves.toEqual({ stderr: "", notice: undefined });
    });

    const fired = (uuid: string, source: string, state = "started") => ({
      type: "command_lifecycle",
      command_uuid: uuid,
      state,
      wakeup_source: source,
    });
    const firedTurn = (uuid: string, source: string) => [fired(uuid, source), fired(uuid, source, "completed")];
    const oneShot = (id: string, nextFireAt?: number) => [
      toolUse(id, "CronCreate"),
      toolResult(id, {}, { id, recurring: false, durable: false, ...(nextFireAt === undefined ? {} : { nextFireAt }) }),
    ];

    it("does not count a wakeup that fired", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a"),
          ...firedTurn("w", "loop_wakeup"),
        ]),
      ).resolves.toEqual({ stderr: "", notice: undefined });
    });

    it("counts a wakeup set again after one fired", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a"),
          ...firedTurn("w", "loop_wakeup"),
          toolUse("b", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("b"),
        ]),
      ).resolves.toMatchObject({ abandonedBackgroundWork: ["ScheduleWakeup timer"] });
    });

    it("does not count a one-shot cron job that fired, taking the earliest due one", async () => {
      await expect(
        runWith([
          ...oneShot("late", 2000),
          ...oneShot("early", 1000),
          fired("q", "schedule_wakeup", "queued"),
          ...firedTurn("c", "schedule_wakeup"),
        ]),
      ).resolves.toMatchObject({ abandonedBackgroundWork: ["CronCreate job late"] });
      await expect(runWith([...oneShot("job"), ...firedTurn("c", "schedule_wakeup")])).resolves.toEqual({
        stderr: "",
        notice: undefined,
      });
    });

    it("keeps a recurring cron job and a one-shot job not due when a cron job fires", async () => {
      await expect(
        runWith([
          toolUse("a", "CronCreate"),
          toolResult("a", {}, { id: "recurring", recurring: true, durable: false, nextFireAt: 0 }),
          ...oneShot("future", Date.now() + 3_600_000),
          ...firedTurn("c", "schedule_wakeup"),
        ]),
      ).resolves.toMatchObject({ abandonedBackgroundWork: ["CronCreate job recurring", "CronCreate job future"] });
    });

    it("reports nothing when a one-shot timer fires during the notice turn, whose result still ends the Run", async () => {
      const child = fakeChild();
      const writes: string[] = [];
      child.stdin.on("data", (line) => writes.push(line.toString()));
      const process = fakeProcess(child);
      const seen: (boolean | undefined)[] = [];
      const run = process.execute(
        { type: "user" },
        (_message, terminal) => seen.push(terminal),
        new AbortController().signal,
      );
      const before = [
        toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
        toolResult("a"),
        ...oneShot("job", 1000),
        { type: "result", user_message_uuids: ["prompt"] },
      ];
      for (const frame of before) child.stdout.write(`${JSON.stringify(frame)}\n`);
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      seen.length = 0;
      const after = [
        // Each fired timer gets its own turn and result. Neither is the notice's.
        fired("w", "loop_wakeup"),
        { type: "result", result: "WAKE-OK", num_turns: 1 },
        fired("w", "loop_wakeup", "completed"),
        fired("c", "schedule_wakeup"),
        { type: "result", result: "CRON-OK", num_turns: 1 },
        fired("c", "schedule_wakeup", "completed"),
        { type: "result", result: "told them", user_message_uuids: [JSON.parse(writes[1] as string).uuid] },
      ];
      for (const frame of after) child.stdout.write(`${JSON.stringify(frame)}\n`);
      expect(seen).toEqual([false, false, false, false, false, false, true]);
      child.emit("exit", 143, null);
      await expect(run).resolves.toEqual({ stderr: "" });
    });

    it("ends the Run at the notice's result even while a fired timer's turn is open", async () => {
      const child = fakeChild();
      const writes: string[] = [];
      child.stdin.on("data", (line) => writes.push(line.toString()));
      const process = fakeProcess(child);
      const seen: (boolean | undefined)[] = [];
      const run = process.execute(
        { type: "user" },
        (_message, terminal) => seen.push(terminal),
        new AbortController().signal,
      );
      child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n{"type":"result"}\n`);
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      const named = { type: "result", user_message_uuids: [JSON.parse(writes[1] as string).uuid] };
      child.stdout.write(`${JSON.stringify(fired("w", "loop_wakeup"))}\n${JSON.stringify(named)}\n`);
      expect(seen.at(-1)).toBe(true);
      child.emit("exit", 143, null);
      await run;
    });

    it("reports nothing when the Session deletes its cron job in the notice turn", async () => {
      const child = fakeChild();
      const writes: string[] = [];
      child.stdin.on("data", (line) => writes.push(line.toString()));
      const process = fakeProcess(child);
      const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
      const frames = [toolUse("a", "CronCreate"), toolResult("a", {}, { id: "job-1", durable: false })];
      for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
      child.stdout.write('{"type":"result"}\n');
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      for (const frame of [toolUse("b", "CronDelete", { id: "job-1" }), toolResult("b", {}, { id: "job-1" })])
        child.stdout.write(`${JSON.stringify(frame)}\n`);
      child.stdout.write('{"type":"result"}\n');
      child.emit("exit", 143, null);
      await expect(run).resolves.toEqual({ stderr: "" });
    });
  });

  it("ends the Run at the result after the notice when Claude Code reports no lifecycle for it", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdout.write('{"type":"result","result":"started"}\n');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    child.stdout.write('{"type":"result","result":"told them"}\n');
    expect(seen.slice(-2)).toEqual([false, true]);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "", abandonedBackgroundWork: ["local_bash"] });
  });

  it("still waits for Claude Code's own result and a later steer after the notice", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdout.write('{"type":"result"}\n');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    await process.steer({ type: "user", uuid: "after-notice" });
    child.stdout.write(`${JSON.stringify(selfGeneratedResult)}\n`);
    child.stdout.write('{"type":"result"}\n');
    child.stdout.write('{"type":"command_lifecycle","command_uuid":"after-notice","state":"started"}\n');
    child.stdout.write('{"type":"result"}\n');
    expect(seen.slice(-5)).toEqual([false, false, false, false, true]);
    child.emit("exit", 143, null);
    await run;
  });

  it("writes no notice into an aborted Run", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = fakeProcess(child);
    const controller = new AbortController();
    const run = process.execute({ type: "user" }, () => undefined, controller.signal);
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    controller.abort();
    child.stdout.write('{"type":"result"}\n');
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "", abandonedBackgroundWork: ["local_bash"] });
    expect(writes).toHaveLength(1);
  });

  it("fails the Run when the background notice cannot be written", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdin.write = ((_line: string, callback: (error: Error) => void) => {
      callback(new Error("closed"));
      return false;
    }) as never;
    child.stdout.write('{"type":"result"}\n');
    await expect(run).rejects.toMatchObject({ code: "write" });
  });

  it("queues steer input behind the prompt while permission control initializes", async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on("data", (line) => writes.push(line.toString()));
    const process = new ClaudeCodeProcess({
      args: ["--permission-prompt-tool", "stdio"],
      cwd: "/",
      env: {},
      spawnProcess: () => child,
    });
    const run = process.execute({ type: "user", text: "work" }, () => undefined, new AbortController().signal);
    const handle = await process.steer({ type: "user", uuid: "steer-1" });
    expect(writes).toHaveLength(1);
    child.stdout.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "opentag_initialize" } })}\n`,
    );
    expect(
      writes
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).uuid ?? JSON.parse(line).text ?? JSON.parse(line).type),
    ).toEqual(["control_request", "work", "steer-1"]);
    // The steered input never started: the process exiting after a result is a failure, not a success.
    child.stdout.write('{"type":"result"}\n');
    child.emit("exit", 0, null);
    await expect(run).rejects.toMatchObject({ code: "exited" });
    expect(handle.started()).toBe(false);
    await process.close();
  });

  it("forgets a steer whose write failed", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user" },
      (_message, terminal) => seen.push(terminal),
      new AbortController().signal,
    );
    child.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof child.stdin.write;
    await expect(process.steer({ type: "user", uuid: "steer-1" })).rejects.toMatchObject({ code: "write" });
    child.stdout.write('{"type":"result"}\n');
    expect(seen).toEqual([true]);
    child.emit("exit", 0, null);
    await run;
    await process.close();
  });

  it("reports a native response write failure", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    child.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof child.stdin.write;
    await expect(process.send({ type: "control_response" })).rejects.toMatchObject({ code: "write" });
    child.emit("exit", 0, null);
    await process.close();
  });

  it.each(["denied", "timeout", "write"])("fails closed for %s permission initialization", async (scenario) => {
    const child = fakeChild();
    const process = new ClaudeCodeProcess({
      args: ["--permission-prompt-tool", "stdio"],
      cwd: "/",
      env: {},
      spawnProcess: () => child,
    });
    if (scenario === "timeout") vi.useFakeTimers();
    try {
      const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
      const rejected = expect(run).rejects.toBeInstanceOf(ClaudeCodeProcessError);
      if (scenario === "denied")
        child.stdout.write(
          '{"type":"control_response","response":{"request_id":"opentag_initialize","subtype":"error"}}\n',
        );
      if (scenario === "timeout") await vi.advanceTimersByTimeAsync(60_000);
      if (scenario === "write") {
        child.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
          callback(new Error("write failed"));
          return false;
        }) as typeof child.stdin.write;
        child.stdout.write(
          '{"type":"control_response","response":{"request_id":"opentag_initialize","subtype":"success"}}\n',
        );
      }
      await rejected;
      child.emit("exit", 1, null);
      await process.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exchanges bounded JSONL and closes after the terminal result", async () => {
    const process = await fixtureProcess("normal");
    const messages: Readonly<Record<string, unknown>>[] = [];
    await expect(
      process.execute(
        { type: "user", text: "hello" },
        (message) => messages.push(message),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ stderr: "" });
    expect(messages.map((message) => message.type)).toEqual(["system", "result"]);
    await process.close();
  });

  it.each(["malformed", "non-object", "oversized", "truncated"])(
    "fails closed for %s provider output",
    async (scenario) => {
      const process = await fixtureProcess(scenario, 1024);
      await expect(
        process.execute({ type: "user" }, () => undefined, new AbortController().signal),
      ).rejects.toBeInstanceOf(ClaudeCodeProcessError);
      await process.close();
    },
  );

  it("includes bounded stderr when the Provider exits without a result", async () => {
    const process = await fixtureProcess("exit");
    await expect(process.execute({ type: "user" }, () => undefined, new AbortController().signal)).rejects.toThrow(
      "fixture failure",
    );
    await process.close();
  });

  it("rejects pre-aborted and duplicate executions", async () => {
    const process = await fixtureProcess("normal");
    const controller = new AbortController();
    controller.abort();
    await expect(process.execute({ type: "user" }, () => undefined, controller.signal)).rejects.toMatchObject({
      code: "aborted",
    });

    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    await expect(
      process.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "protocol" });
    await run;
    await process.close();
  });

  it("rejects an input above the configured line bound", async () => {
    const process = await fixtureProcess("normal", 1024);
    await expect(
      process.execute({ text: "x".repeat(2048) }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it("validates process bounds and synchronous spawn failures", () => {
    const spawn = () => fakeChild();
    expect(
      () => new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, maxLineBytes: 1023, spawnProcess: spawn }),
    ).toThrow("maxLineBytes");
    expect(
      () => new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, maxStderrBytes: -1, spawnProcess: spawn }),
    ).toThrow("maxStderrBytes");
    expect(
      () =>
        new ClaudeCodeProcess({
          args: [],
          cwd: "/",
          env: {},
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
    ).toThrow("spawn failed");
    expect(
      () =>
        new ClaudeCodeProcess({
          args: [],
          cwd: "/",
          env: {},
          spawnProcess: () => {
            throw 42;
          },
        }),
    ).toThrow("Claude Code could not be started");
  });

  it("uses default process options and preserves bounded stderr across blank and CRLF lines", async () => {
    const child = fakeChild();
    let command: string | undefined;
    const process = new ClaudeCodeProcess({
      args: ["arg"],
      cwd: "/",
      env: {},
      maxStderrBytes: 3,
      spawnProcess: (value) => {
        command = value;
        return child;
      },
    });
    const messages: Readonly<Record<string, unknown>>[] = [];
    const run = process.execute({ type: "user" }, (message) => messages.push(message), new AbortController().signal);
    child.stderr.write("abcdef");
    child.stderr.write("ignored");
    child.stdout.write(`\n${JSON.stringify({ type: "status" })}\r\n${JSON.stringify({ type: "result" })}\n`);
    await process.interrupt();
    child.emit("exit", 0, null);

    await expect(run).resolves.toEqual({ stderr: "abc" });
    expect(messages.map((message) => message.type)).toEqual(["status", "result"]);
    expect(command).toBe("claude");
    await process.close();
    await process.interrupt();
  });

  it("propagates listener, child, and stdin write failures", async () => {
    for (const thrown of [new Error("listener failed"), 42]) {
      const child = fakeChild();
      const process = fakeProcess(child);
      const run = process.execute(
        { type: "user" },
        () => {
          throw thrown;
        },
        new AbortController().signal,
      );
      child.stdout.write(`${JSON.stringify({ type: "status" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "ignored" })}\n`);
      await expect(run).rejects.toBeInstanceOf(Error);
      child.emit("exit", 1, null);
      await process.close();
    }

    const erroredChild = fakeChild();
    const errored = fakeProcess(erroredChild);
    const erroredRun = errored.execute({ type: "user" }, () => undefined, new AbortController().signal);
    erroredChild.emit("error", new Error("child error"));
    erroredChild.emit("error", new Error("second error"));
    await expect(erroredRun).rejects.toMatchObject({ code: "spawn" });
    erroredChild.emit("exit", 1, null);
    await errored.close();

    const failedBeforeExecuteChild = fakeChild();
    const failedBeforeExecute = fakeProcess(failedBeforeExecuteChild);
    failedBeforeExecuteChild.emit("error", new Error("spawn failed before execute"));
    await expect(
      failedBeforeExecute.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "spawn" });
    failedBeforeExecuteChild.emit("exit", 1, null);
    await failedBeforeExecute.close();

    const startedChild = fakeChild();
    const started = fakeProcess(startedChild);
    startedChild.emit("spawn");
    const startedRun = started.execute({ type: "user" }, () => undefined, new AbortController().signal);
    startedChild.emit("error", new Error("child failed after spawn"));
    await expect(startedRun).rejects.toMatchObject({ code: "exited" });
    startedChild.emit("exit", 1, null);
    await started.close();

    const writeChild = fakeChild();
    writeChild.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof writeChild.stdin.write;
    const writeFailure = fakeProcess(writeChild);
    await expect(
      writeFailure.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "write" });
    writeChild.emit("exit", 1, null);
    await writeFailure.close();
  });

  it("maps active interrupt and close exits to aborted and rejects execution after an early exit", async () => {
    const interruptChild = fakeChild();
    const interrupted = fakeProcess(interruptChild);
    const interruptedRun = interrupted.execute({ type: "user" }, () => undefined, new AbortController().signal);
    await interrupted.interrupt();
    interruptChild.emit("exit", null, "SIGINT");
    await expect(interruptedRun).rejects.toMatchObject({ code: "aborted" });
    await interrupted.close();

    const closingChild = fakeChild();
    const closing = fakeProcess(closingChild);
    const closingRun = closing.execute({ type: "user" }, () => undefined, new AbortController().signal);
    const close = closing.close(100);
    closingChild.emit("exit", null, "SIGTERM");
    await close;
    await expect(closingRun).rejects.toMatchObject({ code: "aborted" });

    const exitedChild = fakeChild();
    const exited = fakeProcess(exitedChild);
    exitedChild.emit("exit", 0, null);
    await expect(exited.execute({ type: "user" }, () => undefined, new AbortController().signal)).rejects.toMatchObject(
      {
        code: "exited",
      },
    );
    await exited.close();

    const emptyExitChild = fakeChild();
    const emptyExit = fakeProcess(emptyExitChild);
    const emptyExitRun = emptyExit.execute({ type: "user" }, () => undefined, new AbortController().signal);
    emptyExitChild.emit("exit", 1, null);
    await expect(emptyExitRun).rejects.toThrow("exited before a result");
    await emptyExit.close();
  });

  it("fails when buffered output exceeds the bound without a newline", async () => {
    const child = fakeChild();
    const process = new ClaudeCodeProcess({
      args: [],
      cwd: "/",
      env: {},
      maxLineBytes: 1024,
      spawnProcess: () => child,
    });
    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    child.stdout.write("x".repeat(1025));
    await expect(run).rejects.toMatchObject({ code: "protocol" });
    child.emit("exit", 1, null);
    await process.close();
  });

  it("escalates close and reports a process tree that never exits", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    await expect(process.close(1)).rejects.toMatchObject({ code: "exited" });
    child.emit("exit", 1, null);
    await process.close();
  });
});

async function fixtureProcess(scenario: string, maxLineBytes?: number): Promise<ClaudeCodeProcess> {
  const cwd = await mkdtemp(join(tmpdir(), "opentag-claude-code-wire-"));
  directories.push(cwd);
  return new ClaudeCodeProcess({
    command: process.execPath,
    args: [fixture],
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CODE_FIXTURE_SCENARIO: scenario },
    maxLineBytes,
  });
}

const selfGeneratedResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  result: "",
  origin: { kind: "task-notification", producer: "session-task" },
};

function backgroundTasks(...tasks: Record<string, unknown>[]) {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task) => ({ task_type: "local_bash", ...task })),
  };
}

function fakeProcess(child: ChildProcessWithoutNullStreams): ClaudeCodeProcess {
  return new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, spawnProcess: () => child });
}

type FakeChildProcess = ChildProcessWithoutNullStreams & {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
};

function fakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    kill: () => true,
  });
  return child;
}
