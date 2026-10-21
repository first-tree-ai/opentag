import {
  createPiDiagnosticReader,
  createPiDiagnosticStderrWriter,
  createPiDiagnosticWriter,
} from "../../observability/pi-diagnostics.js";

const write = createPiDiagnosticStderrWriter(process.stderr);
const reader = createPiDiagnosticReader(
  { turnId: "turn", sessionId: "session", resourceName: "instance", sandboxId: "sandbox", environmentGeneration: 1 },
  (record) => write(`${JSON.stringify(record)}\n`),
);
const writer = createPiDiagnosticWriter(
  process.argv[2] === "worker" ? write : (line) => reader.consume(Buffer.from(line)),
);
writer.emit({ phase: "get_state", event: "start", durationMs: 0 });
process.stdin.once("data", () => {
  writer.emit({ phase: "get_state", event: "end", durationMs: 1 });
  writer.finish();
  reader.finish({ severity: "INFO" });
  setTimeout(() => process.stdout.write("survived\n"), 100);
});
