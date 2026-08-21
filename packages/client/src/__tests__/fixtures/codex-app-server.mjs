import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.CODEX_FIXTURE_SCENARIO ?? "normal";
if (process.env.CODEX_FIXTURE_PID_FILE) writeFileSync(process.env.CODEX_FIXTURE_PID_FILE, String(process.pid));
let pendingApproval;
let pendingHostedTool;
let pendingHostedToolRequestId;
let hostedToolSequence = 0;
let threadSequence = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "codex-fixture/1",
        codexHome: process.env.CODEX_FIXTURE_HOME ?? process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
      },
    });
    return;
  }
  if (message.method === "initialized") {
    if (scenario === "malformed") process.stdout.write("not-json\n");
    else if (scenario === "oversized") process.stdout.write("x".repeat(2048));
    else if (scenario === "truncated") {
      process.stdout.write('{"method":"fixture/truncated"');
      process.exit(0);
    } else if (scenario === "process-tree" || scenario === "process-tree-exit") {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
      const message = `${JSON.stringify({ method: "fixture/processTree", params: { pid: descendant.pid } })}\n`;
      process.stdout.write(message, () => {
        if (scenario === "process-tree-exit") setTimeout(() => process.exit(23), 10);
      });
    } else send({ method: "fixture/initialized", params: {} });
    return;
  }
  if (message.method === "fixture/echo") {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "probe-hang") return;
    threadSequence += 1;
    send({ id: message.id, result: { thread: { id: `thread-${threadSequence}` } } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn-fixture", status: "inProgress", items: [] };
    send({ id: message.id, result: { turn } });
    queueMicrotask(() => {
      send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
      if (scenario === "hosted-tool-run" || scenario === "hosted-tool-duplicate-run") {
        pendingHostedTool = { threadId: message.params.threadId, turn, responses: 0 };
        pendingHostedToolRequestId = `hosted-tool-${++hostedToolSequence}`;
        setTimeout(() => {
          send({
            id: pendingHostedToolRequestId,
            method: "item/tool/call",
            params: {
              threadId: message.params.threadId,
              turnId: turn.id,
              callId: "call-1",
              namespace: null,
              tool: "example_tool",
              arguments: { text: "hello" },
            },
          });
          if (scenario === "hosted-tool-duplicate-run") {
            send({
              id: pendingHostedToolRequestId,
              method: "item/tool/call",
              params: {
                threadId: message.params.threadId,
                turnId: turn.id,
                callId: "call-2",
                namespace: null,
                tool: "example_tool",
                arguments: { text: "duplicate" },
              },
            });
          }
        }, 10);
        return;
      }
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: {
            id: turn.id,
            status: "completed",
            items: [{ id: "message-fixture", type: "agentMessage", phase: "final_answer", text: "fixture answer" }],
          },
        },
      });
    });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "fixture/approval") {
    pendingApproval = message.id;
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
    return;
  }
  if (message.method === "fixture/duplicate-approval") {
    send({ id: "approval-duplicate", method: "item/commandExecution/requestApproval", params: {} });
    send({ id: "approval-duplicate", method: "item/commandExecution/requestApproval", params: {} });
    return;
  }
  if (message.id === "approval-1") {
    send({ id: pendingApproval, result: message.result });
    return;
  }
  if (message.method === "fixture/unknown-request") {
    send({ id: "unknown-1", method: "fixture/unsupported", params: {} });
    return;
  }
  if (message.method === "fixture/hosted-tool" || message.method === "fixture/hosted-tool-invalid-namespace") {
    pendingHostedTool = message.id;
    pendingHostedToolRequestId = `hosted-tool-${++hostedToolSequence}`;
    send({
      id: pendingHostedToolRequestId,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: message.method === "fixture/hosted-tool" ? null : 42,
        tool: "example_tool",
        arguments: { text: "hello" },
      },
    });
    return;
  }
  if (message.id === pendingHostedToolRequestId) {
    if (process.env.CODEX_FIXTURE_RESPONSE_LOG) {
      appendFileSync(process.env.CODEX_FIXTURE_RESPONSE_LOG, `${JSON.stringify(message)}\n`);
    }
    if (typeof pendingHostedTool === "object") {
      pendingHostedTool.responses += 1;
      send({
        method: "turn/completed",
        params: {
          threadId: pendingHostedTool.threadId,
          turn: {
            ...pendingHostedTool.turn,
            status: "completed",
            items: [
              {
                id: "message-fixture",
                type: "agentMessage",
                phase: "final_answer",
                text: JSON.stringify({ responses: pendingHostedTool.responses, toolResult: message.result }),
              },
            ],
          },
        },
      });
      return;
    }
    send({ id: pendingHostedTool, result: message.result });
  }
});
