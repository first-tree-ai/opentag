#!/usr/bin/env node
import { createInterface } from "node:readline";

const [command, subcommand] = process.argv.slice(2);
if (command === "--version") {
  process.stdout.write(`${process.env.CODEX_FIXTURE_VERSION ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}
if (command === "login" && subcommand === "status") {
  process.stdout.write("Logged in\n");
  process.exit(0);
}
if (command !== "app-server") process.exit(64);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "codex-readiness-fixture/1",
        codexHome: process.env.CODEX_HOME,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform,
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    const tools = message.params?.dynamicTools;
    if (!Array.isArray(tools) || tools.length !== 3) {
      send({ id: message.id, result: { unsupported: true } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "readiness-thread" } } });
  }
});
