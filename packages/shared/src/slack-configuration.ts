import { z } from "zod";
import {
  ImBindingAdminDetailSchema,
  ImBindingHandoffStatusSchema,
  ImBindingMessagingExpectationSchema,
  SlackIdentityClosureSchema,
} from "./im-binding.js";

const BotTokenSchema = z.string().trim().max(4096);
const SigningSecretSchema = z.string().trim().max(512);

export const SaveSlackConfigurationRequestSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("create"),
      expectedMessaging: z.object({ kind: z.literal("unbound") }).strict(),
      botAccessToken: BotTokenSchema.min(1),
      signingSecret: SigningSecretSchema.min(1),
    })
    .strict(),
  z
    .object({
      intent: z.literal("reauthorize"),
      expectedMessaging: z
        .object({
          kind: z.literal("bound"),
          provider: z.literal("slack"),
          bindingId: z.string().uuid(),
          credentialGeneration: z.number().int().positive(),
        })
        .strict(),
      botAccessToken: BotTokenSchema.optional(),
      signingSecret: SigningSecretSchema.optional(),
    })
    .strict()
    .refine((input) => Boolean(input.botAccessToken || input.signingSecret), {
      message: "Provide at least one changed credential",
    }),
]);

/** Derived configuration for this request only; none of these choices adds persisted installation state. */
export const SlackConfigurationViewSchema = z
  .object({
    agentDisplayName: z.string(),
    eventsUrl: z.string().url(),
    allowedIntent: z.enum(["create", "reauthorize"]).nullable(),
    blockedReason: z.string().nullable(),
    expectedMessaging: ImBindingMessagingExpectationSchema.nullable(),
    preferredRecovery: z.enum(["oauth", "credentials"]),
    binding: ImBindingAdminDetailSchema.nullable(),
    identityClosure: SlackIdentityClosureSchema.nullable(),
    handoff: ImBindingHandoffStatusSchema.nullable(),
  })
  .strict();

export type SaveSlackConfigurationRequest = z.infer<typeof SaveSlackConfigurationRequestSchema>;
export type SlackConfigurationView = z.infer<typeof SlackConfigurationViewSchema>;
