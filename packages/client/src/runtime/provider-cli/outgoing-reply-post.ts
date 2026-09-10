function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function postToPlainText(post: unknown): string {
  if (!isRecord(post)) return "";
  const body = unwrapPostLocale(post);
  const parts: string[] = [];
  if (body) {
    if (typeof body.title === "string" && body.title !== "") parts.push(body.title);
    for (const paragraph of selectContentBlocks(body)) {
      parts.push(Array.isArray(paragraph) ? paragraph.map(renderPostElem).join("") : "");
    }
  }
  const attachments = renderPostAttachments(post);
  if (attachments.length === 0) return parts.join("\n");
  if (parts.length === 0) return attachments;
  return `${parts.join("\n")}\n${attachments}`;
}

function unwrapPostLocale(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  if ("content" in parsed || "content_v2" in parsed || "title" in parsed) return parsed;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const value = parsed[locale];
    if (isRecord(value)) return value;
  }
  for (const value of Object.values(parsed)) {
    if (isRecord(value) && (Array.isArray(value.content) || Array.isArray(value.content_v2))) return value;
  }
  return undefined;
}

function selectContentBlocks(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.content_v2) && body.content_v2.length > 0) return body.content_v2;
  return Array.isArray(body.content) ? body.content : [];
}

function renderPostElem(element: unknown): string {
  if (!isRecord(element)) return "";
  const tag = typeof element.tag === "string" ? element.tag : "";
  const text = typeof element.text === "string" ? element.text : "";
  if (tag === "text" || tag === "md") return text;
  if (tag === "a") return renderPostLink(text, typeof element.href === "string" ? element.href : "");
  if (tag === "at") return renderPostMention(element);
  return renderPostMediaElem(tag, element, text);
}

function renderPostMediaElem(tag: string, element: Record<string, unknown>, text: string): string {
  if (tag === "emotion" || tag === "img" || tag === "media") return renderPostEmbed(tag, element);
  if (tag === "code_block") return renderPostCode(text, typeof element.language === "string" ? element.language : "");
  if (tag === "hr") return "\n---\n";
  return text;
}

function renderPostEmbed(tag: string, element: Record<string, unknown>): string {
  if (tag === "emotion") {
    return typeof element.emoji_type === "string" && element.emoji_type ? `:${element.emoji_type}:` : "";
  }
  if (tag === "img") {
    return typeof element.image_key === "string" && element.image_key ? `![Image](${element.image_key})` : "[Image]";
  }
  return typeof element.file_key === "string" && element.file_key ? `[Media: ${element.file_key}]` : "[Media]";
}

function renderPostLink(text: string, href: string): string {
  if (href && text) return `[${text}](${href})`;
  return href || text;
}

function renderPostMention(element: Record<string, unknown>): string {
  const userId = typeof element.user_id === "string" ? element.user_id : "";
  const name = typeof element.user_name === "string" ? element.user_name : "";
  if (userId === "@_all" || userId === "all") return '<at user_id="all"></at>';
  if (name) return userId.startsWith("ou") ? `<at user_id="${userId}">${name}</at>` : `@${name}`;
  return userId ? `@${userId}` : "@mention";
}

function renderPostCode(code: string, language: string): string {
  return language ? `\n\`\`\`${language}\n${code}\n\`\`\`\n` : `\n\`\`\`\n${code}\n\`\`\`\n`;
}

function renderPostAttachments(parsed: Record<string, unknown>): string {
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) return "";
  const lines: string[] = [];
  for (const raw of parsed.files) {
    if (!isRecord(raw)) continue;
    const key = typeof raw.file_key === "string" ? raw.file_key : "";
    if (!key) continue;
    const tag = raw.is_folder === true ? "folder" : "file";
    const name = typeof raw.file_name === "string" ? raw.file_name : "";
    lines.push(name ? `<${tag} key="${key}" name="${name}"/>` : `<${tag} key="${key}"/>`);
  }
  return lines.join("\n");
}
