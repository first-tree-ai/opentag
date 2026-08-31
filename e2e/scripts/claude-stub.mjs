#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("9.9.9 (opentag-e2e-stub)\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write(
    "stream-json --session-id --resume --mcp-config --strict-mcp-config --allowedTools --append-system-prompt\n",
  );
  process.exit(0);
}
if (args[0] === "auth") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const sessionId = argValue("--session-id") ?? argValue("--resume");
if (!sessionId) {
  process.stderr.write("opentag e2e stub requires --session-id or --resume\n");
  process.exit(1);
}
const toolsIndex = args.indexOf("--tools");
if (toolsIndex < 0 || args[toolsIndex + 1] !== "") {
  process.stderr.write('opentag e2e runtime test requires --tools ""\n');
  process.exit(1);
}

const openTagHome = process.env.OPENTAG_HOME;
if (openTagHome) appendFileSync(join(openTagHome, "e2e-claude-started"), `${sessionId}\n`, "utf8");

let aborted = false;
const abort = () => {
  aborted = true;
  if (openTagHome) appendFileSync(join(openTagHome, "e2e-claude-cancelled"), `${sessionId}\n`, "utf8");
  process.exit(0);
};
process.on("SIGINT", abort);
process.on("SIGTERM", abort);

const input = await readStdinLine();
if (aborted) process.exit(0);
const sentinel = String(input).match(/exactly ([a-f0-9]{32})/)?.[1] ?? "";

while ((await currentMode()) === "hold") {
  if (aborted) process.exit(0);
  await sleep(100);
}
if (aborted) process.exit(0);

const mode = await currentMode();
const resultText = mode === "fail" || sentinel.length === 0 ? "opentag-e2e-not-the-sentinel" : sentinel;
const payload = `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}
${JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  is_error: false,
  result: resultText,
  permission_denials: [],
  usage: {},
})}
`;
await new Promise((resolve, reject) => {
  process.stdout.write(payload, (error) => {
    if (error) reject(error);
    else resolve(undefined);
  });
});
process.exit(0);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function currentMode() {
  const home = process.env.OPENTAG_HOME;
  if (!home) return "pass";
  try {
    const text = (await readFile(join(home, "e2e-claude-mode"), "utf8")).trim();
    if (text === "fail" || text === "hold" || text === "pass") return text;
  } catch {
    // Missing control file is the default happy path.
  }
  return "pass";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      process.stdin.off("data", onData);
      process.stdin.off("error", reject);
      resolve(buffer.slice(0, newline));
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("error", reject);
  });
}
