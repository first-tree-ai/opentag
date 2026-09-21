import type { ProviderOperation, ProviderOperationRewriteContext } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;

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
      rewritten[key] = context.createDownloadHandle(value);
    } else if (typeof value === "string" && key === "upload_url") {
      rewritten[key] = context.createUploadHandle(value);
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

function write(operationId: string, extra: Partial<ProviderOperation> = {}): ProviderOperation {
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
  }),
  read("bots.info"),
  read("team.info"),
  read("users.info"),
  read("users.list"),
  read("conversations.list"),
  read("conversations.info"),
  read("conversations.history", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("conversations.replies", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("conversations.members"),
  read("reactions.get", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("reactions.list"),
  read("files.info", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  read("chat.scheduledMessages.list", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.postMessage", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.update", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.delete"),
  write("chat.scheduleMessage", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("chat.deleteScheduledMessage"),
  write("conversations.join"),
  write("conversations.open"),
  write("reactions.add"),
  write("reactions.remove"),
  write("files.getUploadURLExternal", { rewriteResponseJson: rewriteSlackProtectedUrls }),
  write("files.completeUploadExternal", { rewriteResponseJson: rewriteSlackProtectedUrls }),
];
