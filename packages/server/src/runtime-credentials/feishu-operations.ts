import { FEISHU_TENANT_TOKEN_LOCAL_SENTINEL } from "@opentag/shared";
import type { ProviderOperation } from "./operation-registry.js";

const JSON_BODY = 128 * 1024;
const JSON_RESPONSE = 2 * 1024 * 1024;

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
