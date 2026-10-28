import { parseCredentialEncryptionConfig, parseDatabaseConfig } from "../config.js";
import { createDatabaseClient } from "../db/client.js";
import { ApplicationCipher } from "../services/crypto.js";
import { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";
import { readMcpRolloutStatus } from "./mcp-rollout-status.js";

const config = parseDatabaseConfig(process.env);
const encryption = parseCredentialEncryptionConfig(process.env);
const cipher = encryption instanceof Uint8Array ? new ApplicationCipher(encryption) : new ApplicationCipher(encryption);
const { database, sql } = createDatabaseClient(config.databaseUrl);
try {
  const status = await readMcpRolloutStatus(database, new McpCredentialCipher(cipher));
  process.stdout.write(`${JSON.stringify(status)}\n`);
  if (!status.legacyDowngradeAllowed) process.exitCode = 1;
} finally {
  await sql.end();
}
