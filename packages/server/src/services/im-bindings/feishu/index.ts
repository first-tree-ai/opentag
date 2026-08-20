export type { VerifiedFeishuEnvelope } from "./adapter.js";
export { FeishuAdapter, mapFeishuError, normalizeFeishuMessage } from "./adapter.js";
export { FeishuConnectionManager } from "./connection-manager.js";
export {
  FeishuOperationError,
  type FeishuSafeErrorCode,
  safeFeishuConnectionErrorCode,
  safeFeishuSetupErrorCode,
} from "./errors.js";
export type {
  FeishuAppProfile,
  FeishuRegistration,
  FeishuRegistrationGateway,
  FeishuRegistrationResult,
} from "./registration.js";
export { DefaultFeishuRegistrationGateway, FEISHU_MESSAGE_BASE_SCOPES, feishuMessageScopes } from "./registration.js";
export type { FeishuBindingActivation } from "./setup-service.js";
export { FeishuSetupService } from "./setup-service.js";
