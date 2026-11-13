import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import type { ProviderOperation, ProviderPassthroughRule } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;
const PASSTHROUGH_BODY = 1024 * 1024;
const PASSTHROUGH_JSON_RESPONSE = 10 * 1024 * 1024;
const PASSTHROUGH_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** `/open-apis/<domain>/...` domains the passthrough refuses: token issuance and user login. */
/**
 * RFC 3986 path characters except `;` (matrix parameters some servers strip before routing) and
 * `%`-escapes, which are checked separately. Sheets A1 ranges such as `sheet!A1:B2` need `!`/`:`.
 */
const PASSTHROUGH_SEGMENT = /^(?:[A-Za-z0-9_.~!$&'()*+,=:@-]|%[0-9A-Fa-f]{2})+$/;
/** Escapes of unreserved characters and `;` are equivalent to (or route like) the raw byte. */
const ALIASING_ESCAPE = /%(?:[46][1-9A-Fa-f]|[57][0-9Aa]|3[0-9Bb]|2[DEde]|5[Ff]|7[Ee])/;
const PASSTHROUGH_DENIED_DOMAINS = new Set(["auth", "authen"]);

interface FeishuOperationShape {
  operationId: string;
  method: ProviderOperation["method"];
  pathTemplate: string;
  kind: ProviderOperation["kind"];
  body?: ProviderOperation["body"];
  response?: ProviderOperation["response"];
  validationAllowed?: boolean;
  localResponse?: ProviderOperation["localResponse"];
}

function op(shape: FeishuOperationShape): ProviderOperation {
  return {
    provider: "feishu",
    body: shape.body ?? (shape.method === "GET" || shape.method === "DELETE" ? "none" : "json"),
    response: shape.response ?? "json",
    maxBodyBytes: JSON_BODY,
    maxResponseBytes: JSON_RESPONSE,
    operationId: shape.operationId,
    method: shape.method,
    pathTemplate: shape.pathTemplate,
    kind: shape.kind,
    ...(shape.validationAllowed ? { validationAllowed: true } : {}),
    ...(shape.localResponse ? { localResponse: shape.localResponse } : {}),
  };
}

/**
 * Explicit Feishu/Lark operations. They match before the passthrough rule and carry behavior the
 * generic operation lacks: the tenant token endpoint is answered locally and never exposes the
 * real platform token, bot info is allowed for validation, and message create/reply feed the
 * outbound capture. The origin is fixed by the bound brand.
 */
export const FEISHU_OPERATIONS: readonly ProviderOperation[] = [
  op({
    operationId: "feishu.auth.tenant_access_token",
    method: "POST",
    pathTemplate: "/open-apis/auth/v3/tenant_access_token/internal",
    kind: "read",
    localResponse: (_body, context) => ({
      code: 0,
      msg: "ok",
      // Never the real tenant token (and never the Runner capability). The trusted Runner
      // replaces this sentinel with its Sandbox-local handle before the native CLI sees it.
      tenant_access_token: FEISHU_TENANT_TOKEN_LOCAL_SENTINEL,
      expire: context.capabilityTtlSeconds,
    }),
  }),
  op({
    operationId: "feishu.bot.info",
    method: "GET",
    pathTemplate: "/open-apis/bot/v3/info",
    kind: "read",
    validationAllowed: true,
  }),
  op({
    operationId: "feishu.metadata.api_definition",
    method: "GET",
    pathTemplate: "/api/tools/open/api_definition",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.messages.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.messages.reply",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reply",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.messages.update",
    method: "PUT",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.messages.delete",
    method: "DELETE",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.messages.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.messages.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.reactions.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.reactions.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.reactions.delete",
    method: "DELETE",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}",
    kind: "write",
  }),
  op({
    operationId: "feishu.im.chats.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.chats.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats/{chat_id}",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.chats.members",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats/{chat_id}/members",
    kind: "read",
  }),
  op({
    operationId: "feishu.im.images.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/images",
    kind: "write",
    body: "stream",
  }),
  op({
    operationId: "feishu.im.files.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/files",
    kind: "write",
    body: "stream",
  }),
  op({
    operationId: "feishu.im.message_resources.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
    kind: "read",
    response: "stream",
  }),
  op({
    operationId: "feishu.docx.documents.get",
    method: "GET",
    pathTemplate: "/open-apis/docx/v1/documents/{document_id}",
    kind: "read",
  }),
  op({
    operationId: "feishu.docx.documents.raw_content",
    method: "GET",
    pathTemplate: "/open-apis/docx/v1/documents/{document_id}/raw_content",
    kind: "read",
  }),
  op({
    operationId: "feishu.drive.files.list",
    method: "GET",
    pathTemplate: "/open-apis/drive/v1/files",
    kind: "read",
  }),
  op({
    operationId: "feishu.drive.files.download",
    method: "GET",
    pathTemplate: "/open-apis/drive/v1/files/{file_token}/download",
    kind: "read",
    response: "stream",
  }),
  op({
    operationId: "feishu.drive.files.upload_all",
    method: "POST",
    pathTemplate: "/open-apis/drive/v1/files/upload_all",
    kind: "write",
    body: "stream",
  }),
];

/**
 * A segment Feishu routes exactly as written: no empty (trailing) segment, no `;`, and no escape
 * of a character that URL normalization or the provider could decode back into a route byte.
 */
function isPlainSegment(segment: string): boolean {
  return PASSTHROUGH_SEGMENT.test(segment) && !ALIASING_ESCAPE.test(segment);
}

/**
 * Words that appear as fixed segments of Feishu Open API routes. The audit log keeps only these;
 * any other segment, whatever its shape, may be an identifier and is redacted.
 */
const FEISHU_ROUTE_WORDS = new Set(
  `
  announcement app apps approvals approve attachments attendees attendance batch batch_create batch_delete
  batch_get batch_get_id batch_query batch_update blocks calendar calendars chat_tabs chats children
  collaborators comments conditions contact convert copy create create_folder dashboards data_validation
  delete departments dimension_range doc_wiki documents download drive events explorer export_tasks fields
  file files filter filter_views find find_by_department float_images folders followers forms freebusy
  get get_node groups images import_tasks info instances job_titles list mailgroups managers medias
  meetings members menu_tree merge_cells message messages meta metainfo metas move move_docs_to_wiki
  nodes patch permissions pins primary protected_dimension public public_mailboxes query raw_content
  reactions read_users records reject replace replies reply reserves resources roles rooms root_folder
  scopes search sections sheets sheets_batch_update spaces spreadsheets statistics style subscribe
  subscriptions subtasks tables task tasklists tasks top_notice unmerge_cells units unsubscribe update
  upload upload_all upload_finish upload_part upload_prepare urgent_app user_groups user_mailboxes users
  values values_append values_batch_get values_batch_update values_prepend versions views wiki
  `
    .trim()
    .split(/\s+/),
);

/**
 * Feishu path for the passthrough audit log: `open-apis`, the domain word, the version, and known
 * route words are kept; every other segment becomes `{id}`, and so does every segment of a path
 * without a version. Never includes the query.
 */
export function redactFeishuPath(path: string): string {
  const [pathname = ""] = path.split("?", 1);
  const segments = pathname.split("/").slice(1);
  const versionIndex = segments.findIndex((segment) => /^v\d+$/.test(segment));
  const redacted = segments.map((segment, index) => {
    if (index === 0 && segment === "open-apis") return segment;
    if (versionIndex < 0) return "{id}";
    if (index === versionIndex || (index === 1 && /^[a-z][a-z0-9_]*$/.test(segment))) return segment;
    return FEISHU_ROUTE_WORDS.has(segment) ? segment : "{id}";
  });
  return `/${redacted.join("/")}`;
}

/**
 * Generic Feishu operation for any other `/open-apis/` call when passthrough is enabled. The App's
 * own scopes are the only limit, except for the `auth` and `authen` domains, which stay refused
 * (the tenant token endpoint keeps its explicit local answer). GET is a read; every other method
 * is a write with one upstream attempt and no replay.
 */
export const FEISHU_PASSTHROUGH: ProviderPassthroughRule = {
  resolve(method, path) {
    if (!PASSTHROUGH_METHODS.has(method)) return undefined;
    const segments = path.split("/").slice(1);
    // Plain segments only: a percent-encoding or an empty (trailing) segment could make the path
    // Feishu routes differ from the one checked here and against the explicit table.
    if (!segments.every(isPlainSegment)) return undefined;
    const [prefix, domain] = segments;
    if (prefix !== "open-apis" || !domain || !/^[a-z][a-z0-9_-]*$/i.test(domain)) return undefined;
    if (PASSTHROUGH_DENIED_DOMAINS.has(domain.toLowerCase())) return undefined;
    return {
      operationId: "feishu.passthrough",
      provider: "feishu",
      method: method as ProviderOperation["method"],
      pathTemplate: "/open-apis/{path}",
      kind: method === "GET" ? "read" : "write",
      body: method === "GET" ? "none" : "auto",
      response: "auto",
      passthrough: true,
      auditPath: redactFeishuPath,
      maxBodyBytes: PASSTHROUGH_BODY,
      maxResponseBytes: PASSTHROUGH_JSON_RESPONSE,
    };
  },
};
