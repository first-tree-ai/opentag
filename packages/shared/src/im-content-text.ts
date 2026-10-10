import type { ImContentV1 } from "./im-message.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Truncate at a UTF-8 character boundary, never introducing a replacement character. */
export function truncateImText(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function imBlockText(block: ImContentV1["blocks"][number]): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "mention":
      return block.label;
    case "link":
      return `[${block.label || block.url}](${block.url})`;
    case "code":
      return `\n\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\`\n`;
    case "quote":
      return block.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "image":
    case "file":
      return `[Attachment ${block.resourceOrdinal + 1}${block.label ? `: ${block.label}` : ""}]`;
    case "unsupported":
      return `[Unsupported message content: ${block.providerType}; read the source message when needed.]`;
  }
}

type StoredImContent = Pick<ImContentV1, "fallbackText"> & Partial<Omit<ImContentV1, "fallbackText">>;

/** Pure, bounded text projection shared by current delivery, steer, and history. */
export function renderImContentText(input: {
  content: StoredImContent;
  provider: "slack" | "feishu";
  maxBytes: number;
  deleted?: boolean;
}): string {
  if (input.deleted) return "[deleted]";
  const { content, maxBytes } = input;
  const body = content.blocks?.length ? content.blocks.map(imBlockText).join("") : content.fallbackText;
  const resources = content.resources ?? [];
  const lines = resources.slice(0, 16).map((resource, index) => {
    const keyName = /^https?:\/\//.test(resource.providerResourceKey ?? "")
      ? "url"
      : input.provider === "slack"
        ? "file_id"
        : "file_key";
    return `Attachment ${(resource.ordinal ?? index) + 1}: ${JSON.stringify({
      [keyName]: resource.providerResourceKey,
      kind: resource.kind,
      filename: resource.filename ? truncateImText(resource.filename, 256) : resource.filename,
      mediaType: resource.mediaType,
      sizeBytes: resource.sizeBytes,
      availability: resource.availability ?? "available",
    })}`;
  });
  const readHint =
    "Read attachments on demand with the configured provider CLI. Source message identifiers are in providerRef.";
  let metadata = lines.length ? `\n\n${lines.join("\n")}\n${readHint}` : "";
  const omitted =
    "\n[Content omitted by the input budget; read the original provider message for the complete content/resources.]";
  // Reserve room for a useful body and a visible omission notice even for very long resource keys.
  const metadataBudget = Math.max(0, maxBytes - encoder.encode(omitted).length - 256);
  const metadataTruncated = encoder.encode(metadata).length > metadataBudget;
  while (encoder.encode(metadata).length > metadataBudget && lines.length > 0) {
    lines.pop();
    metadata = lines.length ? `\n\n${lines.join("\n")}\n${readHint}` : "";
  }
  const limited =
    content.truncated ||
    resources.length > 16 ||
    resources.some((resource) => resource.filename !== null && encoder.encode(resource.filename ?? "").length > 256) ||
    metadataTruncated ||
    encoder.encode(body + metadata).length > maxBytes;
  const suffix = limited ? omitted : "";
  const bodyBudget = Math.max(0, maxBytes - encoder.encode(metadata + suffix).length);
  return `${truncateImText(body, bodyBudget)}${metadata}${suffix}`.trim();
}
