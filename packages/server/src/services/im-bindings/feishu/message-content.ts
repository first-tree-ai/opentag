import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { NativeContent, nativeObject, nativeString } from "../native-content.js";

type Mention = { key: string; id: { open_id?: string; user_id?: string }; name: string };

function postField(content: Record<string, unknown>, key: string): unknown {
  if (content[key] !== undefined) return content[key];
  for (const value of Object.values(content)) {
    const nested = nativeObject(value)[key];
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function feishuMessageContent(type: string, raw: string, mentions: readonly Mention[] = []) {
  const state = new NativeContent();
  let content: Record<string, unknown>;
  try {
    content = nativeObject(JSON.parse(raw));
  } catch {
    return { text: `[unsupported:${type}]`, resources: [], truncated: false };
  }
  function resource(key: unknown, kind: "image" | "file" | "audio" | "video", filename?: unknown) {
    return typeof key === "string" && key
      ? state.resource({
          providerResourceKey: key,
          kind,
          filename: nativeString(filename) || null,
          mediaType: null,
          sizeBytes: null,
        })
      : `[${kind} unavailable; read the source message]`;
  }
  function mention(item: Record<string, unknown>): string {
    const id = nativeString(item.user_id);
    const found = id ? mentions.find((v) => v.id.open_id === id || v.id.user_id === id) : undefined;
    return found?.key ?? (nativeString(item.user_name) ? `@${nativeString(item.user_name)}` : id ? `@${id}` : "");
  }
  function element(value: unknown, depth = 0): string {
    if (!state.visit(depth)) return "[Content omitted; read the source message]";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => element(v, depth + 1)).join("\n");
    const item = nativeObject(value);
    const text = nativeString(item.text) || nativeString(item.content);
    switch (item.tag) {
      case "text":
      case "md":
      case "markdown":
      case "plain_text":
      case "lark_md":
        return text;
      case "at":
        return mention(item);
      case "a":
        return `[${text || nativeString(item.href)}](${nativeString(item.href)})`;
      case "img":
        return resource(item.image_key ?? item.img_key, "image");
      case "media":
        return [resource(item.file_key, "video"), item.image_key ? resource(item.image_key, "image") : ""]
          .filter(Boolean)
          .join(" ");
      case "code_block":
        return `\n\`\`\`${nativeString(item.language)}\n${text}\n\`\`\`\n`;
      case "hr":
        return "\n---\n";
      default:
        return visibleObject(item, depth);
    }
  }
  function visibleObject(item: Record<string, unknown>, depth: number): string {
    const parts: string[] = [];
    for (const key of ["title", "text", "content", "header", "body", "elements", "fields", "messages"]) {
      if (item[key] !== undefined) parts.push(element(item[key], depth + 1));
    }
    for (const key of ["url", "href", "chat_id", "user_id", "message_id", "sender", "create_time"]) {
      if (typeof item[key] === "string") parts.push(`${key}: ${item[key]}`);
    }
    if (parts.some(Boolean)) return parts.filter(Boolean).join("\n");
    return item.tag ? `[Unsupported Feishu element: ${nativeString(item.tag)}; read the source message]` : "";
  }
  function paragraphs(value: unknown): string {
    if (!Array.isArray(value)) return "";
    return value
      .map((row) => (Array.isArray(row) ? row.map((v) => element(v)).join("") : element(row)))
      .join("\n")
      .trim();
  }
  function post(): string {
    const tagged = paragraphs(postField(content, "content"));
    // Resource markers must not suppress the markdown copy when the tagged form has no prose.
    const hasProse = tagged.replace(/\[Attachment \d+(?::[^\]]*)?\]/g, "").trim().length > 0;
    const markdown = hasProse ? "" : paragraphs(postField(content, "content_v2"));
    const title = nativeString(postField(content, "title")).trim();
    return [title, markdown ? [markdown, tagged].filter(Boolean).join("\n") : tagged].filter(Boolean).join("\n");
  }
  function media(kind: "file" | "audio" | "video"): string {
    resource(content.file_key, kind, content.file_name);
    if (kind === "video" && content.image_key) resource(content.image_key, "image");
    return `[${type}]`;
  }
  function body(): string {
    switch (type) {
      case "text":
        return nativeString(content.text);
      case "post":
        return post();
      case "image":
        resource(content.image_key, "image", content.file_name);
        return "[image]";
      case "file":
        return media("file");
      case "audio":
        return media("audio");
      case "media":
      case "video":
        return media("video");
      case "interactive":
      case "share_chat":
      case "share_user":
      case "merge_forward":
        return element(content) || `[${type}; visible content unavailable, read the source message]`;
      default:
        return `[unsupported:${type}]`;
    }
  }
  const parsed = state.finish(body());
  const resources: NormalizedMessage["resources"] = parsed.resources.map((v) => ({
    type: v.kind,
    fileKey: v.providerResourceKey,
    ...(v.filename ? { fileName: v.filename } : {}),
  }));
  return { ...parsed, resources };
}
