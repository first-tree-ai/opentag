import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";
import { type BotProfile, sameBotProfileIdentity, storedBotProfile } from "./bot-profile.js";
import type { FeishuCredential } from "./credential-material.js";
import { ImBindingServiceError } from "./errors.js";

export interface ActivatedFeishuBinding {
  id: string;
  agentId: string;
  provider: "feishu";
  appId: string;
  teamId: string | null;
  botId: string;
  credentialGeneration: number;
}

export interface FeishuActivationInput {
  agentId: string;
  provider: "feishu";
  profile?: BotProfile;
  identity: {
    appId: string;
    teamId: string | null;
    enterpriseId: string | null;
    botId: string;
    teamBrand: string | null;
  };
  credential: FeishuCredential;
}

export function activeBindingValues(
  input: {
    agentId: string;
    provider: "feishu";
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
    disabledAt: null,
    lastErrorCode: null,
    updatedAt: now,
  };
}

export function resolveFeishuActivationInput(
  input: FeishuActivationInput,
  current: typeof imBindings.$inferSelect | undefined,
): FeishuActivationInput {
  const activationInput =
    input.identity.teamId === null && current?.externalAppId === input.identity.appId && current.externalTeamId
      ? { ...input, identity: { ...input.identity, teamId: current.externalTeamId } }
      : input;
  const sameProviderApp = current?.externalAppId === activationInput.identity.appId;
  if (
    current &&
    current.status !== "provisioning" &&
    sameProviderApp &&
    (current.externalTeamId !== activationInput.identity.teamId ||
      current.externalBotId !== activationInput.identity.botId)
  ) {
    throw new ImBindingServiceError(
      "FEISHU_BINDING_IDENTITY_MISMATCH",
      409,
      "The authorized Feishu Bot identity does not match the current App binding",
    );
  }
  return activationInput;
}

export async function persistFeishuActivation(
  transaction: DatabaseTransaction,
  current: typeof imBindings.$inferSelect | undefined,
  activationInput: FeishuActivationInput,
  profile: BotProfile | undefined,
  encryptFor: (bindingId: string) => string,
  now: Date,
): Promise<ActivatedFeishuBinding> {
  const activated = (id: string, credentialGeneration: number): ActivatedFeishuBinding => ({
    id,
    agentId: activationInput.agentId,
    provider: activationInput.provider,
    appId: activationInput.identity.appId,
    teamId: activationInput.identity.teamId,
    botId: activationInput.identity.botId,
    credentialGeneration,
  });
  if (current) {
    const nextGeneration = current.credentialGeneration + 1;
    const [updated] = await transaction
      .update(imBindings)
      .set({
        ...activeBindingValues(activationInput, encryptFor(current.id), nextGeneration, now),
        ...storedBotProfile(profile, current, sameBotProfileIdentity(current, activationInput.identity)),
        setupAttemptId: current.setupAttemptId,
        setupIntent: current.setupIntent,
        setupState: current.setupState,
        setupOwnerInstanceId: current.setupOwnerInstanceId,
        setupOwnerHeartbeatAt: current.setupOwnerHeartbeatAt,
        encryptedSetupContext: current.encryptedSetupContext,
        setupExpiresAt: current.setupExpiresAt,
      })
      .where(eq(imBindings.id, current.id))
      .returning({ id: imBindings.id });
    if (!updated) throw new Error("IM binding activation update did not return an id");
    return activated(updated.id, nextGeneration);
  }
  const createdId = randomUUID();
  const [created] = await transaction
    .insert(imBindings)
    .values({ id: createdId, ...activeBindingValues(activationInput, encryptFor(createdId), 1, now) })
    .returning({ id: imBindings.id });
  if (!created) throw new Error("IM binding insert did not return an id");
  return activated(created.id, 1);
}
