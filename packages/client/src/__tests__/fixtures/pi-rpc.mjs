import { spawn } from "node:child_process";

const scenarios = new Set([
  "command-error",
  "event-failure-before-response",
  "exit",
  "invalid-response",
  "invalid-utf8",
  "malformed",
  "missing-id",
  "missing-type",
  "non-object",
  "normal",
  "oversized",
  "process-tree",
  "process-tree-exit",
  "truncated",
  "unknown-id",
  "wrong-command",
]);
const scenarioFromArgument = scenarios.has(process.argv[2]) ? process.argv[2] : undefined;
const scenario = scenarioFromArgument ?? process.env.PI_RPC_FIXTURE_SCENARIO ?? "normal";
const sessionId =
  (scenarioFromArgument ? process.argv[3] : undefined) ??
  process.env.PI_RPC_FIXTURE_SESSION_ID ??
  "11111111-1111-4111-8111-111111111111";
const sessionFile = (scenarioFromArgument ? process.argv[4] : undefined) ?? `/tmp/${sessionId}.jsonl`;
let buffer = Buffer.alloc(0);

if (scenario === "malformed") {
  process.stdout.write("{bad json}\n");
} else if (scenario === "non-object") {
  process.stdout.write("[]\n");
} else if (scenario === "invalid-utf8") {
  process.stdout.write(
    Buffer.concat([Buffer.from('{"type":"event","value":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
  );
} else if (scenario === "missing-type") {
  process.stdout.write('{"value":1}\n');
} else if (scenario === "oversized") {
  process.stdout.write(`${JSON.stringify({ type: "event", value: "x".repeat(2048) })}\n`);
} else if (scenario === "truncated") {
  process.stdout.write('{"type":"event"');
  process.exit(0);
} else if (scenario === "exit") {
  process.stderr.write("fixture failure");
  process.exit(1);
} else if (scenario === "process-tree" || scenario === "process-tree-exit") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore",
  });
  setTimeout(() => send({ type: "fixture_process_tree", pid: child.pid }), 10);
  if (scenario === "process-tree-exit") setTimeout(() => process.exit(1), 30);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) break;
    const raw = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (!raw) continue;
    const command = JSON.parse(raw);
    handle(command);
  }
});

function handle(command) {
  if (scenario === "unknown-id") {
    send({ id: "unknown", type: "response", command: command.type, success: true });
    return;
  }
  if (scenario === "missing-id") {
    send({ type: "response", command: command.type, success: true });
    return;
  }
  if (scenario === "wrong-command") {
    send({ id: command.id, type: "response", command: "other", success: true });
    return;
  }
  if (scenario === "invalid-response") {
    send({ id: command.id, type: "response", command: command.type, success: "yes" });
    return;
  }
  if (scenario === "command-error") {
    send({ id: command.id, type: "response", command: command.type, success: false, error: "rejected" });
    return;
  }
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { id: "fixture-model", provider: "fixture" },
        sessionId,
        sessionFile,
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        thinkingLevel: "off",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    return;
  }
  if (command.type === "prompt") {
    if (scenario === "event-failure-before-response") {
      send({ type: "turn_end" });
      return;
    }
    send({ id: command.id, type: "response", command: "prompt", success: true });
    emitCompletedRun();
    return;
  }
  if (command.type === "abort" || command.type === "steer") {
    send({ id: command.id, type: "response", command: command.type, success: true });
    return;
  }
  send({ id: command.id, type: "response", command: command.type, success: true, data: command });
}

function emitCompletedRun() {
  const user = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
  const pending = {
    role: "assistant",
    content: [],
    provider: "fixture",
    model: "fixture-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "pending",
    timestamp: 2,
  };
  const assistant = {
    ...pending,
    content: [{ type: "text", text: "fixture answer" }],
    usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
    stopReason: "stop",
  };
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: user });
  send({ type: "message_end", message: user });
  send({ type: "message_start", message: pending });
  send({ type: "message_update", assistantMessageEvent: { type: "start" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "fixture answer" },
  });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "fixture answer" },
  });
  send({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
  send({ type: "message_end", message: assistant });
  send({ type: "turn_end", message: assistant, toolResults: [] });
  send({ type: "agent_end", messages: [user, assistant], willRetry: false });
  send({ type: "agent_settled" });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
