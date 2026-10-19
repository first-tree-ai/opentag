import { redactForLog } from "@opentag/shared";
import { parseDatabaseConfig } from "../config.js";
import { createDatabaseClient } from "../db/client.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import { transferAgent } from "./transfer-agent.js";

/**
 * Operator CLI for `transferAgent`. It does NOT migrate the database, unlike `bootstrap-cli`: this
 * command moves live rows, and running a migration as a side effect of an ownership change is not a
 * step the operator asked for.
 */
function createStderrLogger(): ServiceLogger {
  const write = (level: "debug" | "info" | "warn" | "error", bindings: Record<string, unknown>, message: string) => {
    const payload = redactForLog({ level, module: "admin.transfer-agent", ...bindings, message });
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };
  return {
    debug: (bindings, message) => write("debug", bindings, message),
    info: (bindings, message) => write("info", bindings, message),
    warn: (bindings, message) => write("warn", bindings, message),
    error: (bindings, message) => write("error", bindings, message),
  };
}

const config = parseDatabaseConfig(process.env);
const { database, sql } = createDatabaseClient(config.databaseUrl);

try {
  const result = await transferAgent(
    database,
    {
      agentId: process.env.OPENTAG_TRANSFER_AGENT_ID,
      targetAccountId: process.env.OPENTAG_TRANSFER_TARGET_ACCOUNT_ID,
      slack: process.env.OPENTAG_TRANSFER_SLACK,
    },
    { logger: createStderrLogger() },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await sql.end();
}
