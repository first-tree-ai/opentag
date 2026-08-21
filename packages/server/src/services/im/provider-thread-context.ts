import type { ProviderInboundContext } from "@opentag/shared";

export function threadRootExternalId(context: ProviderInboundContext): string | null {
  return context.provider === "slack" ? (context.threadTs ?? null) : (context.rootId ?? null);
}
