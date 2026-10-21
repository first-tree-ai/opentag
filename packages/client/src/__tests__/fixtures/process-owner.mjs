import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

if (mode === "descendant") {
  process.send({ pid: process.pid });
  setInterval(() => {}, 1_000);
} else {
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  setInterval(() => {}, 1_000);
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", ({ pid }) => {
    descendant.disconnect();
    descendant.unref();
    process.stdout.write(
      `${JSON.stringify({ type: "system", providerPid: process.pid, descendantPid: pid })}\n`,
      () => {
        if (mode === "completed") {
          process.stdout.write(`${JSON.stringify({ type: "result" })}\n`, () => process.exit(0));
        }
        if (mode === "chatty") {
          setInterval(() => {
            process.stdout.write("synthetic output\n");
            process.stderr.write("synthetic error output\n");
          }, 20);
        }
      },
    );
  });
  process.stdin.resume();
  process.stdin.once("end", () => {
    if (mode === "exit-on-eof") process.exit(0);
  });
}
