import { type BotProfile, storedBotProfile } from "./bot-profile.js";

export function activeBindingValues(
  input: {
    agentId: string;
    provider: "feishu" | "slack";
    profile?: BotProfile;
    identity: {
      appId: string;
      teamId: string | null;
      enterpriseId: string | null;
      botId: string;
      teamBrand: string | null;
    };
    credential: { grantedScopes: string[] };
  },
  encryptedCredential: string,
  generation: number,
  now: Date,
) {
  return {
    agentId: input.agentId,
    provider: input.provider,
    status: "active" as const,
    externalAppId: input.identity.appId,
    externalTeamId: input.identity.teamId,
    externalEnterpriseId: input.identity.enterpriseId,
    externalBotId: input.identity.botId,
    externalTeamBrand: input.identity.teamBrand,
    ...storedBotProfile(input.profile),
    credentialSchemaVersion: 1,
    credentialGeneration: generation,
    encryptedCredential,
    grantedCapabilities: input.credential.grantedScopes,
    activatedAt: now,
    ...(input.provider === "slack" ? { observedAt: null, observedConnectedAt: null } : {}),
    disabledAt: null,
    lastErrorCode: null,
    updatedAt: now,
  };
}
