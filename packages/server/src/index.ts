import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

export { createApp } from "./app.js";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid OPENTAG_PORT: ${value ?? ""}`);
  }
  return port;
}

export async function startServer(): Promise<void> {
  const app = createApp();

  try {
    const host = process.env.OPENTAG_HOST ?? "127.0.0.1";
    const port = readPort(process.env.OPENTAG_PORT);
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error, "Failed to start OpenTag server");
    process.exitCode = 1;
  }
}

const isProcessEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isProcessEntry) {
  await startServer();
}
