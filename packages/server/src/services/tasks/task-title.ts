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

function truncateGraphemes(value: string): string {
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  let title = "";
  for (let index = 0; index < TASK_AUTO_TITLE_MAX_GRAPHEMES; index += 1) {
    const next = segments.next();
    if (next.done) break;
    title += next.value.segment;
  }
  return title;
}

function titleTextFromStructuredBlocks(input: TaskTitleInput): string | undefined {
  if (!input.addressedExternalId) return undefined;
  const hasAddressedMention = input.blocks?.some(
    (block) => block.type === "mention" && block.externalId === input.addressedExternalId,
  );
  if (!hasAddressedMention) return undefined;

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
