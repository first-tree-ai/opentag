import { TASK_AUTO_TITLE_MAX_GRAPHEMES } from "@opentag/shared";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fencedCodePattern = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const inlineCodePattern = /`([^`\n]+)`/g;
const mentionPattern = /(^|[\s([{])@[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}(?=$|[\s.,!?;:，。！？；：)\]}])/gu;
const urlPattern = /https?:\/\/[^\s<>"']+/giu;

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

/**
 * Derive the compact, deterministic title shown for a Task Session.
 *
 * The full inbound message remains available on the Turn. This projection only
 * removes routing/noise syntax and bounds the title for list and detail headers.
 */
export function deriveTaskTitle(value: string | null, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(fencedCodePattern, " ")
    .replace(inlineCodePattern, "$1")
    .replace(mentionPattern, "$1")
    .replace(urlPattern, stripUrlDetails)
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? truncateGraphemes(cleaned) : fallback;
}
