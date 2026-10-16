import { SlackConfigurationViewSchema } from "@opentag/shared/browser";
import type { SlackSetupApi } from "../im/slack-custom-app.js";
import type { MemorySetupAdapter } from "./setup-memory-adapter.js";

/** Dedicated-App previews stay inside the Lab model and never contact Slack or the Server. */
export function createLabSlackSetup(memory: MemorySetupAdapter): SlackSetupApi {
  const read: SlackSetupApi["slackConfiguration"] = async (agentId) => {
    const snapshot = await memory.adapter.readSnapshot(agentId);
    const messaging = snapshot.messaging;
    const bound = "bindingId" in messaging && messaging.provider === "slack";
    const verified = messaging.kind === "ready";
    const expectedMessaging = bound
      ? {
          kind: "bound",
          provider: "slack",
          bindingId: messaging.bindingId,
          credentialGeneration: messaging.credentialGeneration,
        }
      : { kind: "unbound" };
    return SlackConfigurationViewSchema.parse({
      agentDisplayName: snapshot.agent.displayName,
      eventsUrl: `https://preview.invalid/api/v1/im/slack/${agentId}/events`,
      allowedIntent: bound ? "reauthorize" : "create",
      blockedReason: null,
      expectedMessaging,
      preferredRecovery: "credentials",
      binding: bound
        ? {
            id: messaging.bindingId,
            agentId,
            provider: "slack",
            bindingState: "active",
            bot: { displayName: snapshot.agent.displayName, avatarUrl: null },
            receiveMode: "mention_only",
            lastInboundAt: null,
            lastValidatedAt: null,
            lastRuntimeObservationAt: null,
            credentialGeneration: messaging.credentialGeneration,
            grantedCapabilities: [],
            reauthorizationRequired: messaging.kind === "blocked" && messaging.code === "reauthorization-required",
            lastErrorCode: null,
            identity: {
              provider: "slack",
              appId: "A_LAB",
              teamId: "T_LAB",
              botUserId: "U_LAB",
              enterpriseId: null,
              appIdEvidence: "configured",
            },
          }
        : null,
      identityClosure: bound
        ? verified
          ? { status: "verified", verifiedAt: snapshot.observedAt }
          : { status: "pending", verifiedAt: null }
        : null,
      handoff: bound ? { bindingState: "active", handoffReady: verified } : null,
    });
  };
  const connect = async (agentId: string) => {
    const view = await read(agentId);
    if (!view.expectedMessaging || !view.allowedIntent) throw new Error("Lab messaging setup is unavailable");
    await memory.adapter.startSlackInstall(agentId, view.allowedIntent, view.expectedMessaging);
    memory.controls.completeSlackInstall();
    const saved = await read(agentId);
    if (saved.binding?.identity.provider !== "slack" || !saved.identityClosure)
      throw new Error("Lab messaging binding missing");
    return {
      imBindingId: saved.binding.id,
      agentId,
      ...saved.binding.identity,
      credentialGeneration: saved.binding.credentialGeneration,
      bindingState: "active" as const,
      identityClosure: saved.identityClosure,
    };
  };
  return {
    slackConfiguration: read,
    // Form credentials are deliberately neither retained nor logged by the Lab.
    saveSlackConfiguration: (agentId) => connect(agentId),
    autoSetupSlack: async (agentId, input) => {
      if (input.action === "authorize") return { status: "authorization_required", ticket: "review-lab" };
      await connect(agentId);
      return { status: "connected" };
    },
  };
}
