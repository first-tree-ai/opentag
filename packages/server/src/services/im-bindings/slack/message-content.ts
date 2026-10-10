import { NativeContent, nativeHttpUrl, nativeObject, nativeString } from "../native-content.js";

function mediaKind(mime: string): "image" | "audio" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function mentionIdsFromText(text: string, priorityId?: string): string[] {
  const ids = [
    ...new Set([...text.matchAll(/<@([A-Z0-9]{1,255})>/g)].flatMap((match) => (match[1] ? [match[1]] : []))),
  ];
  if (priorityId && ids.includes(priorityId)) ids.splice(ids.indexOf(priorityId), 1);
  if (priorityId && text.includes(`<@${priorityId}>`)) ids.unshift(priorityId);
  return ids.slice(0, 256);
}

export function slackMessageContent(message: Record<string, unknown>, priorityMentionId?: string) {
  const state = new NativeContent();
  const files = Array.isArray(message.files) ? message.files.map(nativeObject) : [];
  const filesById = new Map(files.map((item) => [nativeString(item.id), item]));
  function file(value: unknown): string {
    const reference = nativeObject(value);
    const item = { ...filesById.get(nativeString(reference.id)), ...reference };
    const id = nativeString(item.id);
    if (!id) return "[Slack file reference unavailable; read the source message]";
    const existing = state.resources.findIndex((v) => v.providerResourceKey === id);
    if (existing >= 0) return `[Attachment ${existing + 1}]`;
    const mime = nativeString(item.mimetype);
    return state.resource({
      providerResourceKey: id,
      kind: mediaKind(mime),
      filename: nativeString(item.name) || null,
      mediaType: mime || null,
      sizeBytes: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
    });
  }

  function renderArray(value: unknown, depth: number, separator: string): string {
    return Array.isArray(value)
      ? value
          .slice(0, 4096)
          .map((item) => render(item, depth + 1))
          .join(separator)
      : "";
  }
  function image(item: Record<string, unknown>): string {
    if (item.slack_file) return file(item.slack_file);
    const url = nativeHttpUrl(item.image_url);
    if (!url) return "[Image unavailable; read the source message]";
    return state.resource({
      providerResourceKey: url,
      kind: "image",
      filename: nativeString(item.alt_text) || null,
      mediaType: null,
      sizeBytes: null,
    });
  }
  function richList(item: Record<string, unknown>, depth: number): string {
    if (!Array.isArray(item.elements)) return "";
    return item.elements
      .map((v, i) => `${item.style === "ordered" ? `${i + 1}.` : "-"} ${render(v, depth + 1)}`)
      .join("\n");
  }
  function section(item: Record<string, unknown>, depth: number): string {
    return [render(item.text, depth + 1), renderArray(item.fields, depth, "\n"), render(item.accessory, depth + 1)]
      .filter(Boolean)
      .join("\n");
  }
  function imageBlock(item: Record<string, unknown>, depth: number): string {
    return [render(item.title, depth + 1), image(item), nativeString(item.alt_text)].filter(Boolean).join(" ");
  }
  function table(item: Record<string, unknown>, depth: number): string {
    return Array.isArray(item.rows) ? item.rows.map((row) => renderArray(row, depth, " | ")).join("\n") : "";
  }
  function render(value: unknown, depth = 0): string {
    if (!state.visit(depth)) return "[Content omitted; read the source message]";
    if (typeof value === "string") return value;
    const item = nativeObject(value);
    const text = nativeString(item.text);
    const elements = () => renderArray(item.elements, depth, "");
    switch (item.type) {
      case "text":
      case "raw_text":
      case "plain_text":
      case "mrkdwn":
        return text;
      case "user":
        return `<@${nativeString(item.user_id)}>`;
      case "channel":
        return `<#${nativeString(item.channel_id)}>`;
      case "usergroup":
        return `<!subteam^${nativeString(item.usergroup_id)}>`;
      case "broadcast":
        return `<!${nativeString(item.range)}>`;
      case "emoji":
        return `:${nativeString(item.name)}:`;
      case "link":
        return `[${text || nativeString(item.url)}](${nativeString(item.url)})`;
      case "rich_text_section":
        return elements();
      case "rich_text":
        return renderArray(item.elements, depth, "\n");
      case "rich_text_list":
        return richList(item, depth);
      case "rich_text_quote":
        return elements()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "rich_text_preformatted":
        return `\`\`\`\n${elements()}\n\`\`\``;
      case "section":
        return section(item, depth);
      case "header":
        return `# ${render(item.text, depth + 1)}`;
      case "context":
      case "actions":
        return renderArray(item.elements, depth, "\n");
      case "divider":
        return "---";
      case "image":
        return imageBlock(item, depth);
      case "file":
        if (item.file_id) return file({ id: item.file_id });
        return item.slack_file ? file(item.slack_file) : "[Remote file; read the source message]";
      case "video":
        return [
          render(item.title, depth + 1),
          render(item.description, depth + 1),
          nativeString(item.video_url),
          nativeString(item.title_url),
        ]
          .filter(Boolean)
          .join("\n");
      case "button":
        return [render(item.text, depth + 1), nativeString(item.url)].filter(Boolean).join(" ");
      case "table":
        return table(item, depth);
      case undefined:
        return "";
      default:
        return `[Unsupported Slack block: ${nativeString(item.type)}; read the source message]`;
    }
  }
  function attachment(value: unknown): string {
    const item = nativeObject(value);
    const title = nativeString(item.title);
    const parts = [
      nativeString(item.pretext),
      item.title_link ? `[${title}](${nativeString(item.title_link)})` : title,
      nativeString(item.text),
    ];
    if (Array.isArray(item.fields))
      parts.push(
        ...item.fields.map((field) => {
          const v = nativeObject(field);
          return `${nativeString(v.title)}: ${nativeString(v.value)}`;
        }),
      );
    parts.push(renderArray(item.blocks, 0, "\n"));
    if (item.image_url) parts.push(image(item));
    if (item.thumb_url) parts.push(image({ image_url: item.thumb_url }));
    return parts.filter(Boolean).join("\n") || nativeString(item.fallback);
  }
  const blocks = renderArray(message.blocks, 0, "\n");
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(attachment).filter(Boolean).join("\n")
    : "";
  const body = blocks || nativeString(message.text);
  // Inline references define appearance order; append files without an inline occurrence afterwards.
  files.forEach(file);
  const text = [body, attachments].filter(Boolean).join("\n");
  // Routing identity must survive the visible text budget, including a bot mention at the end.
  return { ...state.finish(text), mentionIds: mentionIdsFromText(text, priorityMentionId) };
}
