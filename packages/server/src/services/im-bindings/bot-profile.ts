import { ImBindingSummarySchema } from "@opentag/shared";
import type { z } from "zod";

export const BotProfileSchema = ImBindingSummarySchema.shape.bot;
export type BotProfile = z.infer<typeof BotProfileSchema>;

export function httpsAvatar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Failed enrichment may reuse a profile only for the verified provider identity. */
export function storedBotProfile(
  profile: BotProfile | undefined,
  previous?: { botDisplayName: string | null; botAvatarUrl: string | null },
  sameIdentity = false,
) {
  if (profile) return { botDisplayName: profile.displayName, botAvatarUrl: profile.avatarUrl };
  if (sameIdentity && previous) return { botDisplayName: previous.botDisplayName, botAvatarUrl: previous.botAvatarUrl };
  return { botDisplayName: null, botAvatarUrl: null };
}

export function sameBotProfileIdentity(
  previous: { externalAppId: string | null; externalTeamId: string | null; externalBotId: string | null } | undefined,
  identity: { appId: string; teamId: string | null; botId: string },
): boolean {
  return (
    previous?.externalAppId === identity.appId &&
    previous.externalTeamId === identity.teamId &&
    previous.externalBotId === identity.botId
  );
}
