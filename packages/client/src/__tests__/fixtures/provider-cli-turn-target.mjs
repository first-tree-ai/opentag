#!/usr/bin/env node
import { readFileSync } from "node:fs";

const mode = process.env.OPENTAG_TEST_TARGET_MODE ?? "echo";

if (mode === "sleep") {
  process.stderr.write("ready\n");
  const finish = (signal) => {
    process.stderr.write(`got ${signal}\n`);
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGTERM", () => finish("SIGTERM"));
  process.on("SIGINT", () => finish("SIGINT"));
  setInterval(() => undefined, 60_000);
} else {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  const payload = {
    argv: process.argv.slice(2),
    stdin,
    env: {
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER ?? null,
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: process.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER ?? null,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write("target-stderr\n");
  process.exit(Number(process.env.OPENTAG_TEST_TARGET_EXIT ?? "0"));
}
