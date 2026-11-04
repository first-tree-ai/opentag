import type { SlackBindingActivation } from "@opentag/shared";
import { and, eq, gt } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";
import { ImBindingServiceError } from "./errors.js";

export async function assertSlackIdentity(
  transaction: DatabaseTransaction,
  input: SlackBindingActivation,
  currentRoute: typeof imBindings.$inferSelect | undefined,
): Promise<void> {
  if (!currentRoute || currentRoute.status === "provisioning") {
    await assertNoPreviousMessagingIdentity(transaction, input.agentId);
    return;
  }
  if (currentRoute.provider !== "slack") return;
  if (
    currentRoute.externalAppId !== input.appId ||
    currentRoute.externalTeamId !== input.teamId ||
    currentRoute.externalBotId !== input.botUserId
  ) {
    throw new ImBindingServiceError(
      "IM_BINDING_CONFIGURATION_CONFLICT",
      409,
      "An Agent's messaging identity cannot be replaced. Create a new Agent instead.",
    );
  }
}

export async function assertFeishuIdentity(
  transaction: DatabaseTransaction,
  agentId: string,
  current: typeof imBindings.$inferSelect | undefined,
  appId: string,
): Promise<void> {
  if (!current || current.status === "provisioning") {
    await assertNoPreviousMessagingIdentity(transaction, agentId);
    return;
  }
  if (current.provider !== "feishu") return;
  if (current.externalAppId !== appId)
    throw new ImBindingServiceError(
      "IM_BINDING_CONFIGURATION_CONFLICT",
      409,
      "An Agent's messaging App cannot be replaced. Create a new Agent instead.",
    );
}

async function assertNoPreviousMessagingIdentity(transaction: DatabaseTransaction, agentId: string): Promise<void> {
  const [previous] = await transaction
    .select({ id: imBindings.id })
    .from(imBindings)
    .where(
      and(eq(imBindings.agentId, agentId), eq(imBindings.status, "disabled"), gt(imBindings.credentialGeneration, 0)),
    )
    .limit(1);
  if (previous)
    throw new ImBindingServiceError(
      "IM_BINDING_CONFIGURATION_CONFLICT",
      409,
      "An Agent's messaging identity cannot be replaced after disconnecting it. Create a new Agent instead.",
    );
}

export function disconnectedSetupBinding(row: typeof imBindings.$inferSelect) {
  return {
    row,
    binding: {
      bindingId: row.id,
      provider: row.provider,
      credentialGeneration: row.credentialGeneration,
      errorCode: "IM_BINDING_IDENTITY_DISCONNECTED",
      handoff: { bindingState: "disabled" as const, handoffReady: false as const },
    },
  };
}
