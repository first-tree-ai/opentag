import { type ImContentV1, truncateImText } from "@opentag/shared";

export function nativeObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function nativeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Preserve provider inline formatting in model-visible Markdown, including literal code ticks. */
export function nativeInlineStyles(text: string, style: unknown): string {
  if (!text) return text;
  const allowed = Array.isArray(style)
    ? ["bold", "italic", "lineThrough", "underline"]
    : ["bold", "italic", "strike", "code"];
  const flags = new Set(
    (Array.isArray(style)
      ? style
      : Object.entries(nativeObject(style))
          .filter(([, value]) => value === true)
          .map(([key]) => key)
    ).filter((key) => allowed.includes(key)),
  );
  if (flags.has("code")) text = nativeInlineCode(text);
  if (flags.has("bold")) text = `**${text}**`;
  if (flags.has("italic")) text = `*${text}*`;
  if (flags.has("strike") || flags.has("lineThrough")) text = `~~${text}~~`;
  if (flags.has("underline")) text = `<u>${text}</u>`;
  return text;
}

function nativeInlineCode(text: string): string {
  let fence = "`";
  for (const run of text.matchAll(/`+/g)) {
    if (run[0].length >= fence.length) fence = "`".repeat(run[0].length + 1);
  }
  const padding = /^`|`$/.test(text) || (text.startsWith(" ") && text.endsWith(" ") && text.trim()) ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

export function nativeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A bounded native message walk; it never resolves a URL or downloads a resource. */
export class NativeContent {
  readonly resources: NonNullable<ImContentV1["resources"]> = [];
  truncated = false;
  #nodes = 0;

  visit(depth: number): boolean {
    if (depth > 12 || ++this.#nodes > 4096) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  resource(resource: NonNullable<ImContentV1["resources"]>[number]): string {
    if (!resource.providerResourceKey || resource.providerResourceKey.length > 2048) {
      this.truncated = true;
      return "[Invalid resource reference; read the source message]";
    }
    const existing = this.resources.findIndex(
      (item) => item.providerResourceKey === resource.providerResourceKey && item.kind === resource.kind,
    );
    if (existing >= 0) return `[Attachment ${existing + 1}]`;
    if (this.resources.length === 16) {
      this.truncated = true;
      return "[Additional attachment; read the source message]";
    }
    const filename = resource.filename ? truncateImText(resource.filename, 512) : null;
    const mediaType = resource.mediaType ? truncateImText(resource.mediaType, 255) : null;
    if (filename !== resource.filename || mediaType !== resource.mediaType) this.truncated = true;
    this.resources.push({ ...resource, filename, mediaType });
    return `[Attachment ${this.resources.length}${filename ? `: ${filename}` : ""}]`;
  }

  finish(text: string): { text: string; resources: NonNullable<ImContentV1["resources"]>; truncated: boolean } {
    const bounded = truncateImText(text, 24 * 1024);
    return { text: bounded, resources: this.resources, truncated: this.truncated || bounded !== text };
  }
}
