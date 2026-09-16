import type { ProviderOperation, ProviderOperationRewriteContext } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(body: unknown, key: string): string | undefined {
  const value = asRecord(body)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function channelResource(_params: Record<string, string>, body: unknown, query: URLSearchParams): string | undefined {
  const channel = stringField(body, "channel") ?? stringField(body, "channel_id") ?? query.get("channel");
  return channel ? `channel:${channel}` : undefined;
}

function userResource(_params: Record<string, string>, body: unknown, query: URLSearchParams): string | undefined {
  const user = stringField(body, "user") ?? query.get("user");
  return user ? `user:${user}` : undefined;
}

/**
 * Slack file-object fields that require the caller token: private download URLs and the
 * authenticated thumbnails documented at https://docs.slack.dev/reference/objects/file-object/.
 * Dimensions (`thumb_*_w`/`_h`), `thumb_tiny` base64 data, and ordinary text stay untouched.
 */
const SLACK_THUMBNAIL_URL_FIELD = /^thumb_\d+(?:_gif)?$/;

function isSlackDownloadUrlField(key: string): boolean {
  return (
    key === "url_private" ||
    key === "url_private_download" ||
    key === "thumb_pdf" ||
    key === "thumb_video" ||
    SLACK_THUMBNAIL_URL_FIELD.test(key)
  );
}

/** Rewrites Slack signed/private URLs to Server-held execution handles; never returns them natively. */
export function rewriteSlackProtectedUrls(body: unknown, context: ProviderOperationRewriteContext): unknown {
  if (Array.isArray(body)) return body.map((item) => rewriteSlackProtectedUrls(item, context));
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && isSlackDownloadUrlField(key)) {
      rewritten[key] = context.createDownloadHandle(value, stringField(record, "id"));
    } else if (typeof value === "string" && key === "upload_url") {
      rewritten[key] = context.createUploadHandle(value, stringField(record, "file_id") ?? stringField(record, "id"));
    } else {
      rewritten[key] = rewriteSlackProtectedUrls(value, context);
    }
  }
  return rewritten;
}

function read(operationId: string, extra: Partial<ProviderOperation> = {}): ProviderOperation {
  return {
    operationId,
    provider: "slack",
    method: "POST",
    pathTemplate: `/api/${operationId}`,
    kind: "read",
    body: "json",
    response: "json",
    maxBodyBytes: JSON_BODY,
    maxResponseBytes: JSON_RESPONSE,
    ...extra,
  };
}

function write(
  operationId: string,
  resource: ProviderOperation["resource"],
  extra: Partial<ProviderOperation> = {},
): ProviderOperation {
  return {
    operationId,
    provider: "slack",
    method: "POST",
    pathTemplate: `/api/${operationId}`,
    kind: "write",
    body: "json",
    response: "json",
    maxBodyBytes: JSON_BODY,
    maxResponseBytes: JSON_RESPONSE,
    resource,
    ...extra,
  };
}

/**
 * Slack operation table covering the official CLI instruction business domains. Paths are the
 * fixed `/api/<method>` shape on the fixed `https://slack.com` origin; OAuth, admin, app
 * management, revocation, and user-login domains are deliberately absent and therefore rejected.
 */
export const SLACK_OPERATIONS: readonly ProviderOperation[] = [
  read("auth.test", {
    validationAllowed: true,
    body: "json",
    // Read-only identity probe: no protected resource output to record.
    sourceRecord: "exempt",
    resource: () => "self",
  }),
  read("bots.info", { resource: (_p, body, query) => stringField(body, "bot") ?? query.get("bot") ?? "bot" }),
  read("team.info", { resource: () => "team" }),
  read("users.info", { resource: userResource }),
  read("users.list", { resource: () => "users" }),
  read("conversations.list", { resource: () => "conversations" }),
  read("conversations.info", { resource: channelResource }),
  read("conversations.history", { resource: channelResource, rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("conversations.replies", { resource: channelResource, rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("conversations.members", { resource: channelResource }),
  read("reactions.get", { resource: channelResource, rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("reactions.list", { resource: () => "reactions" }),
  read("files.info", {
    resource: (_p, body, query) => {
      const file = stringField(body, "file") ?? query.get("file");
      return file ? `file:${file}` : undefined;
    },
    rewriteResponseJson: rewriteSlackProtectedUrls,
  }),
  read("chat.scheduledMessages.list", { resource: channelResource, rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.postMessage", channelResource, { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.update", channelResource, { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.delete", channelResource),
  write("chat.scheduleMessage", channelResource, { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.deleteScheduledMessage", channelResource),
  write("conversations.join", channelResource),
  write("conversations.open", (_p, body) => {
    const users = stringField(body, "users");
    return users ? `users:${users}` : undefined;
  }),
  write("reactions.add", channelResource),
  write("reactions.remove", channelResource),
  write("files.getUploadURLExternal", (_p, body) => stringField(body, "filename") ?? "upload", {
    rewriteResponseJson: rewriteSlackProtectedUrls,
  }),
  write(
    "files.completeUploadExternal",
    (_p, body) => {
      const channel = stringField(body, "channel_id");
      return channel ? `channel:${channel}` : "files";
    },
    { rewriteResponseJson: rewriteSlackProtectedUrls },
  ),
];
