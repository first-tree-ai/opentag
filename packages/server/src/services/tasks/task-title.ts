import { type ImContentV1, TASK_AUTO_TITLE_MAX_GRAPHEMES } from "@opentag/shared";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fencedCodePattern = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const inlineCodePattern = /`([^`\n]+)`/g;
const urlPattern = /https?:\/\/[^\s<>"']+/giu;

export interface TaskTitleInput {
  fallbackText: string | null;
  fallbackTitle: string;
  provider: "feishu" | "slack";
  addressedExternalId: string | null;
  blocks: ImContentV1["blocks"] | null;
}

function stripUrlDetails(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Bound the title, and mark a cut with an ellipsis so it never reads as a sentence that just stops. */
function truncateGraphemes(value: string): string {
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  let title = "";
  for (let index = 0; index < TASK_AUTO_TITLE_MAX_GRAPHEMES; index += 1) {
    const next = segments.next();
    if (next.done) return title;
    title += next.value.segment;
  }
  return segments.next().done ? title : `${title.trimEnd()}…`;
}

/**
 * Resolve the stored mention facts, whoever this message addresses.
 *
 * A Task is titled from its latest inbound message, and a follow-up rarely mentions the
 * Agent again, so gating this on the addressed mention would leave those Sessions titled
 * from raw provider text — a Feishu `@_user_2` placeholder key names nobody.
 */
function titleTextFromStructuredBlocks(input: TaskTitleInput): string | undefined {
  if (!input.blocks?.some((block) => block.type === "mention")) return undefined;

  return input.blocks
    ?.map((block) => {
      if (block.type === "text" || block.type === "quote") return block.text;
      if (block.type === "mention") return block.externalId === input.addressedExternalId ? " " : block.label;
      if (block.type === "link") return block.label || block.url;
      if (block.type === "image" || block.type === "file") return block.label;
      return " ";
    })
    .join("");
}

/**
 * The text a Turn shows for a message that carries mentions. The stored fallback keeps the
 * provider's routing syntax (Feishu writes a mention as `@_user_1`), while the blocks carry each
 * mention's display label. Only a message tokenised into text and mention blocks is rendered from
 * them, so no other block kind can lose content; every other message keeps its lossless fallback.
 */
export function messageTextFromBlocks(blocks: ImContentV1["blocks"] | undefined): string | undefined {
  if (!blocks?.some((block) => block.type === "mention")) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "mention") parts.push(block.label);
    else return undefined;
  }
  return parts.join("");
}

function providerAwareFallback(input: TaskTitleInput): string {
  const value = input.fallbackText ?? "";
  if (input.provider !== "slack" || !input.addressedExternalId) return value;
  return value.replaceAll(`<@${input.addressedExternalId}>`, " ");
}

/**
 * Derive the compact, deterministic title shown for a Task Session.
 *
 * The full inbound message remains available on the Turn. This projection only
 * removes routing/noise syntax and bounds the title for list and detail headers.
 */
export function deriveTaskTitle(input: TaskTitleInput): string {
  const source = titleTextFromStructuredBlocks(input) ?? providerAwareFallback(input);
  const cleaned = source
    .replace(fencedCodePattern, " ")
    .replace(inlineCodePattern, "$1")
    .replace(urlPattern, stripUrlDetails)
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? truncateGraphemes(cleaned) : input.fallbackTitle;
}
