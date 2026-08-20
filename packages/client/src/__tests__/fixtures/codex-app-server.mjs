import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const scenario = process.env.CODEX_FIXTURE_SCENARIO ?? "normal";
let pendingApproval;
let pendingHostedTool;
let threadSequence = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "codex-fixture/1",
        codexHome: process.env.CODEX_FIXTURE_HOME ?? process.cwd(),
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
  if (message.id === "approval-1") {
    send({ id: pendingApproval, result: message.result });
    return;
  }
  if (message.method === "fixture/unknown-request") {
    send({ id: "unknown-1", method: "fixture/unsupported", params: {} });
    return;
  }
  if (message.method === "fixture/hosted-tool") {
    pendingHostedTool = message.id;
    send({
      id: "hosted-tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "opentag_message_send",
        arguments: { requestId: "11111111-1111-4111-8111-111111111111", text: "hello" },
      },
    });
    return;
  }
  if (message.id === "hosted-tool-1") {
    send({ id: pendingHostedTool, result: message.result });
  }
});
