import type { DatabaseClient } from "../db/client.js";
import { mcpServerAuthorizations } from "../db/schema/index.js";
import type { McpCredentialCipher } from "../services/mcp/mcp-credential-cipher.js";

/** Read-only downgrade admission; prints counts and never serializes credential material. */
export async function readMcpRolloutStatus(database: DatabaseClient, cipher: McpCredentialCipher) {
  const rows = await database
    .select({
      mcpServerId: mcpServerAuthorizations.mcpServerId,
      agentId: mcpServerAuthorizations.agentId,
      credentialSourceId: mcpServerAuthorizations.credentialSourceId,
      authorizationServer: mcpServerAuthorizations.authorizationServer,
      ciphertext: mcpServerAuthorizations.ciphertext,
      keyId: mcpServerAuthorizations.keyId,
      pkceCiphertext: mcpServerAuthorizations.pkceCiphertext,
      flowAuthorizationServer: mcpServerAuthorizations.flowAuthorizationServer,
    })
    .from(mcpServerAuthorizations);
  let referenceCount = 0;
  let versionedCredentialCount = 0;
  let versionedFlowCount = 0;
  let unreadableEnvelopeCount = 0;
  for (const row of rows) {
    if (row.credentialSourceId) referenceCount++;
    const credential = inspectCredential(row, cipher);
    const flow = inspectFlow(row, cipher);
    versionedCredentialCount += Number(credential.versioned);
    versionedFlowCount += Number(flow.versioned);
    unreadableEnvelopeCount += Number(credential.unreadable) + Number(flow.unreadable);
  }
  return {
    referenceCount,
    versionedCredentialCount,
    versionedFlowCount,
    unreadableEnvelopeCount,
    legacyDowngradeAllowed:
      referenceCount + versionedCredentialCount + versionedFlowCount + unreadableEnvelopeCount === 0,
  };
}

type RolloutAuthorization = Pick<
  typeof mcpServerAuthorizations.$inferSelect,
  | "mcpServerId"
  | "agentId"
  | "authorizationServer"
  | "ciphertext"
  | "keyId"
  | "pkceCiphertext"
  | "flowAuthorizationServer"
>;
function inspectCredential(row: RolloutAuthorization, cipher: McpCredentialCipher) {
  if (!row.ciphertext || !row.keyId) return { versioned: false, unreadable: false };
  try {
    const credential = cipher.decryptAuthorizationCredential(
      { mcpServerId: row.mcpServerId, agentId: row.agentId, authorizationServer: row.authorizationServer },
      { ciphertext: row.ciphertext, keyId: row.keyId },
    );
    return { versioned: Boolean(credential.clientId), unreadable: false };
  } catch {
    return { versioned: false, unreadable: true };
  }
}
function inspectFlow(row: RolloutAuthorization, cipher: McpCredentialCipher) {
  if (!row.pkceCiphertext) return { versioned: false, unreadable: false };
  try {
    const keyId = /^v2\.([a-z0-9][a-z0-9-]{0,62})\./.exec(row.pkceCiphertext)?.[1];
    if (!keyId) throw new Error("Unreadable flow envelope");
    const flow = cipher.decryptPkceFlow(
      { mcpServerId: row.mcpServerId, agentId: row.agentId, authorizationServer: row.flowAuthorizationServer },
      { ciphertext: row.pkceCiphertext, keyId },
    );
    return { versioned: "version" in flow, unreadable: false };
  } catch {
    return { versioned: false, unreadable: true };
  }
}
