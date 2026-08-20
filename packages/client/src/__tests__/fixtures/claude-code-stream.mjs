import process from "node:process";

const scenario = process.argv[2] ?? process.env.CLAUDE_CODE_FIXTURE_SCENARIO ?? "normal";
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const line = buffer.slice(0, newline);
  buffer = buffer.slice(newline + 1);
  if (scenario === "foreign-init") {
    process.stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "22222222-2222-4222-8222-222222222222",
      })}\n`,
    );
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (scenario === "non-object") {
    process.stdout.write("[]\n");
    return;
  }
  if (scenario === "oversized") {
    process.stdout.write(`${JSON.stringify({ type: "event", value: "x".repeat(2048) })}\n`);
    return;
  }
  if (scenario === "truncated") {
    process.stdout.write('{"type":"event"');
    process.exit(0);
  }
  if (scenario === "exit") {
    process.stderr.write("fixture failure");
    process.exit(1);
  }
  const input = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "11111111-1111-4111-8111-111111111111",
      input,
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "11111111-1111-4111-8111-111111111111",
      is_error: false,
      result: "ok",
      permission_denials: [],
      usage: {},
    })}\n`,
  );
});

setInterval(() => undefined, 1000);
