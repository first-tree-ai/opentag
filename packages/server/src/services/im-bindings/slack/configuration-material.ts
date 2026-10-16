import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { imBindings, slackInstallations } from "../../../db/schema/index.js";
import type { ApplicationCipher } from "../../crypto.js";
import { decodeSlackCredential } from "../credential-material.js";
import type { SlackInstallationIngress } from "../im-binding-service.js";

/** Called only after management authorization. Includes revoked/pending installs; never a runtime grant. */
export async function readSlackConfigurationMaterial(
  database: DatabaseClient,
  cipher: ApplicationCipher | undefined,
  agentId: string,
): Promise<(SlackInstallationIngress & { observedConnectedAt: Date | null }) | undefined> {
  if (!cipher) return undefined;
  const [row] = await database
    .select({ installation: slackInstallations, bindingId: imBindings.id })
    .from(imBindings)
    .innerJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
    .where(
      and(
        eq(imBindings.agentId, agentId),
        eq(imBindings.provider, "slack"),
        ne(imBindings.status, "disabled"),
        eq(slackInstallations.agentId, agentId),
        ne(slackInstallations.status, "disabled"),
        eq(slackInstallations.credentialGeneration, imBindings.credentialGeneration),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const credential = decodeSlackCredential(cipher, row.installation.encryptedCredential, {
    bindingId: row.bindingId,
    slackInstallationId: row.installation.id,
  });
  if (!credential) return undefined;
  return {
    installationId: row.installation.id,
    generation: row.installation.credentialGeneration,
    agentId,
    appId: row.installation.externalAppId,
    teamId: row.installation.externalTeamId,
    botUserId: row.installation.externalBotId,
    botId: credential.botId,
    botAccessToken: credential.botAccessToken,
    signingSecret: credential.signingSecret,
    observedConnectedAt: row.installation.observedConnectedAt,
  };
}
