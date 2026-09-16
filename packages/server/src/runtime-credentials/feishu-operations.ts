import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import type { ProviderOperation } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(body: unknown, key: string): string | undefined {
  const value = asRecord(body)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function receiveIdResource(_params: Record<string, string>, body: unknown): string | undefined {
  const receiveId = stringField(body, "receive_id");
  return receiveId ? `chat:${receiveId}` : undefined;
}

function messageParamResource(params: Record<string, string>): string | undefined {
  return params.message_id ? `message:${params.message_id}` : undefined;
}

function chatContainerResource(_params: Record<string, string>, _body: unknown, query: URLSearchParams) {
  const container = query.get("container_id");
  return container ? `chat:${container}` : "messages";
}

interface FeishuOperationShape {
  operationId: string;
  method: ProviderOperation["method"];
  pathTemplate: string;
  kind: ProviderOperation["kind"];
  body?: ProviderOperation["body"];
  response?: ProviderOperation["response"];
  validationAllowed?: boolean;
  resource?: ProviderOperation["resource"];
  sourceRecord?: ProviderOperation["sourceRecord"];
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
    ...(shape.sourceRecord ? { sourceRecord: shape.sourceRecord } : {}),
    ...(shape.resource ? { resource: shape.resource } : {}),
    ...(shape.localResponse ? { localResponse: shape.localResponse } : {}),
  };
}

/**
 * Feishu/Lark operation table covering the official CLI instruction business domains. The origin
 * is fixed by the bound brand; SSO/login (`/open-apis/authen/*`), event, and admin domains are
 * deliberately absent and therefore rejected. The tenant token endpoint is answered locally and
 * never exposes the real platform token.
 */
export const FEISHU_OPERATIONS: readonly ProviderOperation[] = [
  op({
    operationId: "feishu.auth.tenant_access_token",
    method: "POST",
    pathTemplate: "/open-apis/auth/v3/tenant_access_token/internal",
    kind: "read",
    resource: () => "self",
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
    // Read-only identity probe: no protected resource output to record.
    sourceRecord: "exempt",
    resource: () => "self",
  }),
  op({
    operationId: "feishu.metadata.api_definition",
    method: "GET",
    pathTemplate: "/api/tools/open/api_definition",
    kind: "read",
    // Public CLI schema discovery: no protected resource output to record.
    sourceRecord: "exempt",
    resource: () => "metadata",
  }),
  op({
    operationId: "feishu.im.messages.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages",
    kind: "write",
    resource: receiveIdResource,
  }),
  op({
    operationId: "feishu.im.messages.reply",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reply",
    kind: "write",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.messages.update",
    method: "PUT",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "write",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.messages.delete",
    method: "DELETE",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "write",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.messages.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}",
    kind: "read",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.messages.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages",
    kind: "read",
    resource: chatContainerResource,
  }),
  op({
    operationId: "feishu.im.reactions.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions",
    kind: "write",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.reactions.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions",
    kind: "read",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.reactions.delete",
    method: "DELETE",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}",
    kind: "write",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.im.chats.list",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats",
    kind: "read",
    resource: () => "chats",
  }),
  op({
    operationId: "feishu.im.chats.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats/{chat_id}",
    kind: "read",
    resource: (params) => (params.chat_id ? `chat:${params.chat_id}` : undefined),
  }),
  op({
    operationId: "feishu.im.chats.members",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/chats/{chat_id}/members",
    kind: "read",
    resource: (params) => (params.chat_id ? `chat:${params.chat_id}` : undefined),
  }),
  op({
    operationId: "feishu.im.images.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/images",
    kind: "write",
    body: "stream",
    resource: () => "images",
  }),
  op({
    operationId: "feishu.im.files.create",
    method: "POST",
    pathTemplate: "/open-apis/im/v1/files",
    kind: "write",
    body: "stream",
    resource: () => "files",
  }),
  op({
    operationId: "feishu.im.message_resources.get",
    method: "GET",
    pathTemplate: "/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
    kind: "read",
    response: "stream",
    resource: messageParamResource,
  }),
  op({
    operationId: "feishu.docx.documents.get",
    method: "GET",
    pathTemplate: "/open-apis/docx/v1/documents/{document_id}",
    kind: "read",
    resource: (params) => (params.document_id ? `document:${params.document_id}` : undefined),
  }),
  op({
    operationId: "feishu.docx.documents.raw_content",
    method: "GET",
    pathTemplate: "/open-apis/docx/v1/documents/{document_id}/raw_content",
    kind: "read",
    resource: (params) => (params.document_id ? `document:${params.document_id}` : undefined),
  }),
  op({
    operationId: "feishu.drive.files.list",
    method: "GET",
    pathTemplate: "/open-apis/drive/v1/files",
    kind: "read",
    resource: () => "drive",
  }),
  op({
    operationId: "feishu.drive.files.download",
    method: "GET",
    pathTemplate: "/open-apis/drive/v1/files/{file_token}/download",
    kind: "read",
    response: "stream",
    resource: (params) => (params.file_token ? `file:${params.file_token}` : undefined),
  }),
  op({
    operationId: "feishu.drive.files.upload_all",
    method: "POST",
    pathTemplate: "/open-apis/drive/v1/files/upload_all",
    kind: "write",
    body: "stream",
    resource: () => "drive",
  }),
];
