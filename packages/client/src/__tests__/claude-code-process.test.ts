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

  it("keeps the Run open while background work is live, and ends it at the turn after the work finished", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: [unknown, boolean | undefined][] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message, terminal) => seen.push([message.type, terminal]),
      new AbortController().signal,
    );
    // The order and fields Claude Code 2.1.319 sends for a background Bash call.
    const frames = [
      backgroundTasks({ task_id: "a", description: "Run the suite" }),
      toolOutput("a"),
      { type: "result", result: "started", user_message_uuids: ["prompt"] },
    ];
    for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
    await process.steer({ type: "user", uuid: "while-waiting" }).then((handle) => expect(handle.started()).toBe(false));
    child.stdout.write('{"type":"command_lifecycle","command_uuid":"while-waiting","state":"started"}\n');
    child.stdout.write('{"type":"result","result":"answered","user_message_uuids":["while-waiting"]}\n');
    const later = [
      {
        type: "system",
        subtype: "task_notification",
        task_id: "a",
        status: "completed",
        output_file: "/out",
        summary: "ok",
      },
      backgroundTasks(),
      { type: "result", result: "woken", origin: { kind: "task-notification" } },
    ];
    for (const frame of later) child.stdout.write(`${JSON.stringify(frame)}\n`);
    expect(seen.filter(([type]) => type === "result")).toEqual([
      ["result", false],
      ["result", false],
      ["result", true],
    ]);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "" });
  });

  it("reports background work as it changes, once per change, and what finished", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const frames: Record<string, unknown>[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message) => {
        if (String(message.type).startsWith("opentag/")) frames.push({ ...message });
      },
      new AbortController().signal,
    );
    const sent = [
      backgroundTasks({ task_id: "a", description: "Run the suite" }, { task_id: "b" }),
      backgroundTasks({ task_id: "a", description: "Run the suite" }, { task_id: "b" }),
      toolOutput("a"),
      // A foreground tool reports its end the same way.
      { type: "system", subtype: "task_notification", task_id: "foreground", status: "completed" },
      { type: "system", subtype: "task_notification", task_id: "a", status: "stopped", output_file: "" },
      {
        type: "system",
        subtype: "task_notification",
        task_id: "b",
        status: "completed",
        output_file: "/b",
        summary: "ok",
      },
      backgroundTasks(),
      { type: "result", user_message_uuids: ["prompt"] },
    ];
    for (const frame of sent) child.stdout.write(`${JSON.stringify(frame)}\n`);
    expect(frames).toEqual([
      {
        type: "opentag/background_work",
        items: [
          { id: "a", label: "Run the suite (local_bash)" },
          { id: "b", label: "local_bash" },
        ],
      },
      {
        type: "opentag/background_work",
        items: [
          { id: "a", label: "Run the suite (local_bash)", outputPath: "/tmp/a.output" },
          { id: "b", label: "local_bash" },
        ],
      },
      { type: "opentag/background_finished", id: "a", status: "stopped", outputPath: "/tmp/a.output" },
      { type: "opentag/background_finished", id: "b", status: "completed", detail: "ok", outputPath: "/b" },
      { type: "opentag/background_work", items: [] },
    ]);
    child.emit("exit", 143, null);
    await run;
  });

  it("does not take a stopped notice about the previous process's task as a fact", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const types: unknown[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message) => types.push(message.type),
      new AbortController().signal,
    );
    child.stdout.write(
      `${JSON.stringify({ type: "system", subtype: "task_notification", task_id: "old", status: "stopped" })}\n`,
    );
    child.stdout.write('{"type":"result","user_message_uuids":["prompt"]}\n');
    expect(types).toEqual(["system", "result"]);
    child.emit("exit", 143, null);
    await run;
  });

  it("still ends the Run on an error result while background work is live", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message, terminal) => {
        if (message.type === "result") seen.push(terminal);
      },
      new AbortController().signal,
    );
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdout.write('{"type":"result","is_error":true}\n');
    expect(seen).toEqual([true]);
    child.emit("exit", 1, null);
    await run;
  });

  it("says so when the turn that failed is one Claude Code started after answering the input", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message, terminal) => {
        if (message.type === "result") seen.push(terminal);
      },
      new AbortController().signal,
    );
    const frames = [
      backgroundTasks({ task_id: "a" }),
      { type: "result", user_message_uuids: ["prompt"] },
      backgroundTasks(),
      { ...selfGeneratedResult, is_error: true },
    ];
    for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
    expect(seen).toEqual([false, true]);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "", followUpFailed: true });
  });

  it("does not call it a follow-up when input steered into the wake turn fails with it", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const run = process.execute({ type: "user", uuid: "prompt" }, () => undefined, new AbortController().signal);
    for (const frame of [backgroundTasks({ task_id: "a" }), { type: "result", user_message_uuids: ["prompt"] }])
      child.stdout.write(`${JSON.stringify(frame)}\n`);
    await process.steer({ type: "user", uuid: "new-request" });
    const frames = [
      { type: "command_lifecycle", command_uuid: "new-request", state: "started" },
      { ...selfGeneratedResult, is_error: true },
    ];
    for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "" });
  });

  it("writes a notice during the wait, whose result holds nothing back and whose failure is a follow-up failure", async () => {
    const child = fakeChild();
    const writes: { uuid: string; message: { content: [{ text: string }] } }[] = [];
    child.stdin.on("data", (line) => writes.push(JSON.parse(line.toString())));
    const process = fakeProcess(child);
    await process.notice("too early");
    expect(writes).toEqual([]);
    const seen: (boolean | undefined)[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message, terminal) => {
        if (message.type === "result") seen.push(terminal);
      },
      new AbortController().signal,
    );
    for (const frame of [backgroundTasks({ task_id: "a" }), { type: "result", user_message_uuids: ["prompt"] }])
      child.stdout.write(`${JSON.stringify(frame)}\n`);
    await process.notice("quiet for a while");
    const notice = writes.at(-1) as (typeof writes)[number];
    expect(notice.message.content[0].text).toBe("quiet for a while");
    child.stdout.write(`${JSON.stringify({ type: "result", user_message_uuids: [notice.uuid] })}\n`);
    expect(seen).toEqual([false, false]);
    await process.notice("again");
    const again = writes.at(-1) as (typeof writes)[number];
    child.stdout.write(`${JSON.stringify({ type: "result", is_error: true, user_message_uuids: [again.uuid] })}\n`);
    child.emit("exit", 143, null);
    await expect(run).resolves.toEqual({ stderr: "", followUpFailed: true });
    await process.notice("too late");
    expect(writes.at(-1)).toBe(again);
  });

  it("fails a notice it cannot write", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const run = process.execute({ type: "user", uuid: "prompt" }, () => undefined, new AbortController().signal);
    child.stdin.write = ((_line: string, callback: (error: Error) => void) => {
      callback(new Error("closed"));
      return false;
    }) as never;
    await expect(process.notice("quiet")).rejects.toMatchObject({ code: "write" });
    child.emit("exit", 143, null);
    await run.catch(() => undefined);
  });

  it("is stopped by an interrupt while it waits for background work", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const controller = new AbortController();
    const run = process.execute({ type: "user", uuid: "prompt" }, () => undefined, controller.signal);
    child.stdout.write(`${JSON.stringify(backgroundTasks({ task_id: "a" }))}\n`);
    child.stdout.write('{"type":"result","user_message_uuids":["prompt"]}\n');
    await process.interrupt();
    child.emit("exit", 130, null);
    await expect(run).rejects.toMatchObject({ code: "aborted" });
  });

  it("ignores an output path it cannot read from a tool result", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const frames: Record<string, unknown>[] = [];
    const run = process.execute(
      { type: "user", uuid: "prompt" },
      (message) => {
        if (message.type === "opentag/background_work") frames.push({ ...message });
      },
      new AbortController().signal,
    );
    const sent = [
      backgroundTasks({ task_id: "a" }),
      { type: "user", message: { content: "text" } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text" }] }, { type: "text" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "plain output" }] } },
      { type: "system", subtype: "task_notification", task_id: "a", status: "completed" },
      backgroundTasks(),
      { type: "result", user_message_uuids: ["prompt"] },
    ];
    for (const frame of sent) child.stdout.write(`${JSON.stringify(frame)}\n`);
    expect(frames).toEqual([
      { type: "opentag/background_work", items: [{ id: "a", label: "local_bash" }] },
      { type: "opentag/background_work", items: [] },
    ]);
    child.emit("exit", 143, null);
    await run;
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

    /** Runs the frames, then the Run's own result; returns what stayed live and whether that ended the Run. */
    async function runWith(frames: Record<string, unknown>[]) {
      const child = fakeChild();
      const process = fakeProcess(child);
      let live: readonly { label: string }[] = [];
      let ended: boolean | undefined;
      const run = process.execute(
        { type: "user", uuid: "prompt" },
        (message, terminal) => {
          if (message.type === "opentag/background_work") live = message.items as { label: string }[];
          if (message.type === "result") ended = terminal;
        },
        new AbortController().signal,
      );
      for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
      child.stdout.write('{"type":"assistant","message":{}}\n{"type":"result","user_message_uuids":["prompt"]}\n');
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("exit", 143, null);
      if (ended) await run;
      else await run.catch(() => undefined);
      return { live: live.map((item) => item.label), ended };
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
      ).resolves.toEqual({
        live: ["CronCreate job job-1", "ScheduleWakeup timer", "CronCreate job c"],
        ended: false,
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
      ).resolves.toEqual({ live: [], ended: true });
    });

    it("does not count a cron job written to disk", async () => {
      await expect(
        runWith([toolUse("a", "CronCreate"), toolResult("a", {}, { id: "job-1", durable: true })]),
      ).resolves.toEqual({ live: [], ended: true });
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
      ).resolves.toEqual({ live: ["CronCreate job job-2"], ended: false });
    });

    it("stops counting a wakeup once it is stopped", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a"),
          toolUse("b", "ScheduleWakeup", { stop: true }),
          toolResult("b"),
        ]),
      ).resolves.toEqual({ live: [], ended: true });
    });

    const fired = (uuid: string, source: string, state = "started") => ({
      type: "command_lifecycle",
      command_uuid: uuid,
      state,
      wakeup_source: source,
      scheduled_for: 1000,
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
          toolResult("a", {}, { scheduledFor: 1000 }),
          ...firedTurn("w", "loop_wakeup"),
        ]),
      ).resolves.toEqual({ live: [], ended: true });
    });

    it("counts a wakeup set again after one fired", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a", {}, { scheduledFor: 1000 }),
          ...firedTurn("w", "loop_wakeup"),
          toolUse("b", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("b"),
        ]),
      ).resolves.toEqual({ live: ["ScheduleWakeup timer"], ended: false });
    });

    const recurring = (id: string) => [
      toolUse(id, "CronCreate"),
      toolResult(id, {}, { id, recurring: true, durable: false, nextFireAt: 0 }),
    ];

    it("does not count the only cron job once it fired and is one-shot and due", async () => {
      await expect(
        runWith([...oneShot("job"), fired("q", "schedule_wakeup", "queued"), ...firedTurn("c", "schedule_wakeup")]),
      ).resolves.toEqual({ live: [], ended: true });
    });

    it("keeps a one-shot job when a recurring job fired and was then deleted", async () => {
      await expect(
        runWith([
          ...recurring("every"),
          ...oneShot("nearby", Date.now() + 90_000),
          ...firedTurn("c", "schedule_wakeup"),
          toolUse("d", "CronDelete", { id: "every" }),
          toolResult("d", {}, { id: "every" }),
        ]),
      ).resolves.toEqual({ live: ["CronCreate job nearby"], ended: false });
    });

    it("retires every due one-shot job on a cron firing, so none holds the Run to its limit, and keeps the rest", async () => {
      await expect(
        runWith([...recurring("every"), ...oneShot("due", 1000), ...firedTurn("c", "schedule_wakeup")]),
      ).resolves.toEqual({ live: ["CronCreate job every"], ended: false });
      await expect(
        runWith([...oneShot("first", 1000), ...oneShot("second", 2000), ...firedTurn("c", "schedule_wakeup")]),
      ).resolves.toEqual({ live: [], ended: true });
    });

    it("keeps a wakeup when a firing does not name its time", async () => {
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a", {}, { scheduledFor: 2000 }),
          ...firedTurn("w", "loop_wakeup"),
        ]),
      ).resolves.toEqual({ live: ["ScheduleWakeup timer"], ended: false });
    });

    it("keeps a one-shot job not yet due when a durable job fired", async () => {
      await expect(
        runWith([
          toolUse("a", "CronCreate"),
          toolResult("a", {}, { id: "disk", durable: true }),
          ...oneShot("job", Date.now() + 90_000),
          ...firedTurn("c", "schedule_wakeup"),
        ]),
      ).resolves.toEqual({ live: ["CronCreate job job"], ended: false });
    });

    it("keeps the only cron job when it is recurring or not due", async () => {
      await expect(runWith([...recurring("every"), ...firedTurn("c", "schedule_wakeup")])).resolves.toEqual({
        live: ["CronCreate job every"],
        ended: false,
      });
      await expect(
        runWith([...oneShot("future", Date.now() + 90_000), ...firedTurn("c", "schedule_wakeup")]),
      ).resolves.toEqual({ live: ["CronCreate job future"], ended: false });
    });

    it("keeps timers on a firing it does not recognize, and a cron frame leaves a wakeup alone", async () => {
      await expect(runWith([...oneShot("job", 1000), ...firedTurn("c", "something_new")])).resolves.toEqual({
        live: ["CronCreate job job"],
        ended: false,
      });
      await expect(
        runWith([
          toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
          toolResult("a", {}, { scheduledFor: 1000 }),
          ...firedTurn("c", "schedule_wakeup"),
        ]),
      ).resolves.toEqual({ live: ["ScheduleWakeup timer"], ended: false });
    });

    it("waits for a timer to fire, and ends the Run at the result of the turn it started", async () => {
      const child = fakeChild();
      const process = fakeProcess(child);
      const seen: (boolean | undefined)[] = [];
      const run = process.execute(
        { type: "user", uuid: "prompt" },
        (message, terminal) => {
          if (message.type === "result") seen.push(terminal);
        },
        new AbortController().signal,
      );
      const frames = [
        toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
        toolResult("a", {}, { scheduledFor: 1000 }),
        { type: "result", user_message_uuids: ["prompt"] },
        fired("w", "loop_wakeup"),
        { type: "result", result: "WAKE-OK", num_turns: 1 },
        fired("w", "loop_wakeup", "completed"),
      ];
      for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
      expect(seen).toEqual([false, true]);
      child.emit("exit", 143, null);
      await expect(run).resolves.toEqual({ stderr: "" });
    });

    it("keeps waiting when the turn a timer started sets another timer", async () => {
      const child = fakeChild();
      const process = fakeProcess(child);
      const seen: (boolean | undefined)[] = [];
      const run = process.execute(
        { type: "user", uuid: "prompt" },
        (message, terminal) => {
          if (message.type === "result") seen.push(terminal);
        },
        new AbortController().signal,
      );
      const frames = [
        toolUse("a", "ScheduleWakeup", { delaySeconds: 60 }),
        toolResult("a", {}, { scheduledFor: 1000 }),
        { type: "result", user_message_uuids: ["prompt"] },
        fired("w", "loop_wakeup"),
        toolUse("b", "ScheduleWakeup", { delaySeconds: 60 }),
        toolResult("b"),
        { type: "result", result: "again", num_turns: 1 },
      ];
      for (const frame of frames) child.stdout.write(`${JSON.stringify(frame)}\n`);
      expect(seen).toEqual([false, false]);
      child.emit("exit", 143, null);
      await expect(run).rejects.toMatchObject({ code: "exited" });
    });
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

function toolOutput(id: string) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output. You will be notified when it completes.`,
        },
      ],
    },
  };
}

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
