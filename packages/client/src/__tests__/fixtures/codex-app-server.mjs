import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const scenario = process.env.CODEX_FIXTURE_SCENARIO ?? "normal";
let pendingApproval;

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
  }
});
