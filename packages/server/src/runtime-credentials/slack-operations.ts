import type {
  ProviderOperation,
  ProviderOperationRewriteContext,
  ProviderPassthroughRule,
} from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;
const PASSTHROUGH_BODY = 1024 * 1024;
const PASSTHROUGH_JSON_RESPONSE = 10 * 1024 * 1024;
/** Slack Web API method names: dot-separated words, e.g. `admin.conversations.create`. */
const SLACK_METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
/** Credential issuance, user sign-in, and revocation stay refused even with passthrough on. */
const PASSTHROUGH_DENIED_PREFIXES = ["oauth.", "openid."];
const PASSTHROUGH_DENIED_METHODS = new Set(["auth.revoke"]);
const READ_METHOD_VERBS = new Set([
  "list",
  "info",
  "history",
  "replies",
  "members",
  "get",
  "test",
  "conversations",
  "identity",
]);
/** Compound read verbs such as `dnd.teamInfo`, `team.billableInfo`, or `team.accessLogs`. */
const READ_VERB_SUFFIXES = ["info", "logs"];
const READ_VERB_PREFIXES = ["get", "lookup"];

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
    // Legacy read endpoints such as files.info ignore application/json parameters.
    // Accept native JSON input, but serialize these reads as urlencoded forms upstream.
    body: "form",
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
 * Explicit Slack operations on the fixed `/api/<method>` shape and `https://slack.com` origin.
 * They match before the passthrough rule: `auth.test` is the only validation-purpose call,
 * `chat.postMessage` feeds the outbound capture, and file URLs are rewritten to handles.
 */
export const SLACK_OPERATIONS: readonly ProviderOperation[] = [
  read("auth.test", {
    validationAllowed: true,
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

const EXPLICIT_METHOD_NAMES = new Set(
  SLACK_OPERATIONS.map((operation) => operation.pathTemplate.slice("/api/".length).toLowerCase()),
);

/**
 * Write-outcome classification only (request encoding does not depend on it): a method is a read
 * when its lowercased final verb is a known read (`*.list`, `*.info`, `users.conversations`),
 * ends in a read suffix (`dnd.teamInfo`, `team.accessLogs`), starts with `get`/`lookup`, or it is
 * any `search.*` method. A misclassified read only loses the unknown-outcome reporting of writes.
 */
function slackMethodKind(lowered: string): ProviderOperation["kind"] {
  const parts = lowered.split(".");
  const verb = parts.at(-1) ?? "";
  const read =
    parts[0] === "search" ||
    READ_METHOD_VERBS.has(verb) ||
    READ_VERB_SUFFIXES.some((suffix) => verb.endsWith(suffix)) ||
    READ_VERB_PREFIXES.some((prefix) => verb.startsWith(prefix));
  return read ? "read" : "write";
}

/**
 * Generic Slack operation for any other Web API method when passthrough is enabled. The App's own
 * scopes are the only limit, except for `oauth.*`, `openid.*`, and `auth.revoke`. Bodies accept
 * form or JSON input and are always sent upstream as a form (multipart is not accepted), the
 * caller's token is always stripped, and JSON responses keep the protected-URL rewriting.
 */
export const SLACK_PASSTHROUGH: ProviderPassthroughRule = {
  resolve(method, path) {
    if (method !== "POST" && method !== "GET") return undefined;
    const [, prefix, name, ...rest] = path.split("/");
    if (prefix !== "api" || !name || rest.length > 0 || !SLACK_METHOD_NAME.test(name)) return undefined;
    const lowered = name.toLowerCase();
    if (PASSTHROUGH_DENIED_METHODS.has(lowered) || PASSTHROUGH_DENIED_PREFIXES.some((p) => lowered.startsWith(p))) {
      return undefined;
    }
    // Slack accepts GET and any casing for a method, so another spelling of an explicit method
    // would skip its validation scope, capture, or rewriting; only the explicit entry may serve it.
    if (EXPLICIT_METHOD_NAMES.has(lowered)) return undefined;
    const kind = slackMethodKind(lowered);
    return {
      operationId: "slack.passthrough",
      provider: "slack",
      method,
      pathTemplate: "/api/{method}",
      kind,
      // Every Web API method accepts form parameters while legacy ones ignore JSON, so JSON input
      // is always normalized to a form upstream.
      body: method === "GET" ? "none" : "form",
      response: "auto",
      passthrough: true,
      maxBodyBytes: PASSTHROUGH_BODY,
      maxResponseBytes: PASSTHROUGH_JSON_RESPONSE,
      rewriteResponseJson: rewriteSlackProtectedUrls,
      // `/api/<method>` carries no identifiers; keep the method name and drop the query.
      auditPath: (requestPath) => requestPath.split("?", 1)[0] ?? "",
    };
  },
};
