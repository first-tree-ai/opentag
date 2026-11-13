import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import type { ProviderOperation, ProviderPassthroughRule } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;
const PASSTHROUGH_BODY = 1024 * 1024;
const PASSTHROUGH_JSON_RESPONSE = 10 * 1024 * 1024;
const PASSTHROUGH_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** `/open-apis/<domain>/...` domains the passthrough refuses: token issuance and user login. */
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
 * Generic Feishu operation for any other `/open-apis/` call when passthrough is enabled. The App's
 * own scopes are the only limit, except for the `auth` and `authen` domains, which stay refused
 * (the tenant token endpoint keeps its explicit local answer). GET is a read; every other method
 * is a write with one upstream attempt and no replay.
 */
export const FEISHU_PASSTHROUGH: ProviderPassthroughRule = {
  resolve(method, path) {
    if (!PASSTHROUGH_METHODS.has(method)) return undefined;
    const [, prefix, domain] = path.split("/");
    // A plain domain word only: an encoded or odd segment could alias a denied domain upstream.
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
      maxBodyBytes: PASSTHROUGH_BODY,
      maxResponseBytes: PASSTHROUGH_JSON_RESPONSE,
    };
  },
};
