import type { ImContentV1 } from "@opentag/shared";

export interface StructuredMention {
  token: string;
  externalId: string;
  label: string;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Preserve provider mention identity alongside the lossless fallback text. */
export function contentBlocksWithMentions(
  value: string,
  mentions: readonly StructuredMention[],
): ImContentV1["blocks"] {
  const mentionsByToken = new Map(
    mentions.filter(({ token, externalId }) => token && externalId).map((mention) => [mention.token, mention]),
  );
  if (mentionsByToken.size === 0) return [{ type: "text", text: value }];

  const pattern = new RegExp(
    [...mentionsByToken.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapePattern)
      .join("|"),
    "g",
  );
  const blocks: ImContentV1["blocks"] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    const mention = mentionsByToken.get(match[0]);
    if (index === undefined || !mention) continue;
    if (blocks.length >= 510) break;
    if (index > cursor) blocks.push({ type: "text", text: value.slice(cursor, index) });
    blocks.push({ type: "mention", externalId: mention.externalId, label: mention.label });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) blocks.push({ type: "text", text: value.slice(cursor) });
  return blocks.length > 0 ? blocks : [{ type: "text", text: value }];
}
