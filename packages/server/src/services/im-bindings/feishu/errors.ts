import { ImBindingServiceError } from "../im-binding-service.js";

export type FeishuSafeErrorCode =
  | "FEISHU_ADMISSION_NOT_READY"
  | "FEISHU_APP_IDENTITY_MISMATCH"
  | "FEISHU_BINDING_NOT_ACTIVE"
  | "FEISHU_BOT_IDENTITY_MISMATCH"
  | "FEISHU_CONNECTION_LEASE_STALE"
  | "FEISHU_CONNECTION_LEASE_UNAVAILABLE"
  | "FEISHU_RUNTIME_TOOL_UNAVAILABLE"
  | "FEISHU_SCOPE_REAUTH_REQUIRED"
  | "FEISHU_SETUP_FAILED"
  | "FEISHU_SETUP_FENCE_STALE";

export class FeishuOperationError extends Error {
  constructor(readonly code: FeishuSafeErrorCode) {
    super(code);
    this.name = "FeishuOperationError";
  }
}

export function safeFeishuConnectionErrorCode(error: unknown): string {
  return error instanceof FeishuOperationError ? error.code : "FEISHU_CONNECTION_ERROR";
}

export function safeFeishuSetupErrorCode(error: unknown): string {
  if (error instanceof FeishuOperationError) return error.code;
  if (error instanceof ImBindingServiceError && error.code === "FEISHU_APP_ALREADY_BOUND") return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return "FEISHU_SETUP_FAILED";
  if (error.code === "access_denied") return "FEISHU_SETUP_DENIED";
  if (error.code === "expired_token") return "FEISHU_SETUP_EXPIRED";
  if (error.code === "abort") return "FEISHU_SETUP_CANCELED";
  return "FEISHU_SETUP_FAILED";
}
