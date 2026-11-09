import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
let marker;
process.on("message", (message) => {
  const { id, command } = message;
  if (command === "hang") return;
  if (command === "reject") {
    process.send({ id, error: "injected_model_rejection" });
    return;
  }
  if (command === "prompt") marker = message.marker;
  let result = marker;
  if (command === "tool") result = hash(marker);
  if (command === "get_state") result = "fixture-ready";
  if (command === "mcp") result = ["fixture_hash"];
  if (command === "shutdown") {
    process.send({ id, result, cpu: process.cpuUsage() }, () => process.disconnect());
    return;
  }
  process.send({ id, result });
});
