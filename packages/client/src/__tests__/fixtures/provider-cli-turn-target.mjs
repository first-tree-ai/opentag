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
} else if (mode === "large-stdout") {
  const bytes = Number(process.env.OPENTAG_TEST_TARGET_BYTES ?? String(5 * 1024 * 1024));
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let remaining = Number.isFinite(bytes) && bytes > 0 ? bytes : 5 * 1024 * 1024;
  while (remaining > 0) {
    const next = remaining > chunk.length ? chunk : chunk.subarray(0, remaining);
    if (!process.stdout.write(next)) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    remaining -= next.length;
  }
  process.exit(0);
} else if (mode === "lark-cli") {
  const argv = process.argv.slice(2);
  const messagePath = argv.find((argument) => argument.includes("/open-apis/im/v1/messages/"));
  const isGet = argv.includes("GET") && Boolean(messagePath);
  const messageId = messagePath ? messagePath.split("/").pop() : "";
  if (isGet && process.env.OPENTAG_TEST_LARK_REQUIRE_BOT_JSON === "1") {
    if (!argv.includes("--as") || !argv.includes("bot") || !argv.includes("--json")) {
      process.exit(2);
    }
  }
  if (
    isGet &&
    (process.env.OPENTAG_TEST_LARK_GET_HANG === "1" || process.env[`OPENTAG_TEST_LARK_GET_HANG_${messageId}`] === "1")
  ) {
    setInterval(() => undefined, 60_000);
  } else if (isGet) {
    const namedDelay = process.env[`OPENTAG_TEST_LARK_GET_DELAY_${messageId}`];
    const delay = Number(namedDelay ?? process.env.OPENTAG_TEST_LARK_GET_DELAY_MS ?? "0");
    if (delay > 0) {
      const end = Date.now() + delay;
      while (Date.now() < end) {
        /* bounded test delay */
      }
    }
    const envelope = process.env.OPENTAG_TEST_LARK_GET_ENVELOPE;
    if (envelope) process.stdout.write(envelope.endsWith("\n") ? envelope : `${envelope}\n`);
    process.exit(Number(process.env.OPENTAG_TEST_LARK_GET_EXIT ?? "0"));
  } else {
    const envelope =
      process.env.OPENTAG_TEST_LARK_ENVELOPE ??
      JSON.stringify({
        ok: true,
        identity: "bot",
        data: { message_id: "om_sent", chat_id: "oc_chat", create_time: "2026-09-08 16:33:38" },
      });
    process.stdout.write(envelope.endsWith("\n") ? envelope : `${envelope}\n`);
    process.stderr.write("target-stderr\n");
    process.exit(Number(process.env.OPENTAG_TEST_TARGET_EXIT ?? "0"));
  }
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
