export {
  FeishuAdapter,
  type FeishuBotProbe,
  type FeishuChannel,
  feishuEnvelopeEventId,
  normalizeFeishuMessage,
  type VerifiedFeishuEnvelope,
} from "./adapter.js";
export { FeishuConnectionManager } from "./connection-manager.js";
export {
  FeishuCandidateExpiredError,
  FeishuOperationError,
  type FeishuPublicFailure,
  type FeishuSafeErrorCode,
  feishuPublicFailure,
  feishuSetupFailureCode,
  safeFeishuActivationErrorCode,
  safeFeishuConnectionErrorCode,
  safeFeishuSetupErrorCode,
} from "./errors.js";
export {
  type FeishuInboundReceiptClaim,
  FeishuInboundReceiptError,
  type FeishuInboundReceiptInput,
  type FeishuInboundReceiptMetric,
  FeishuInboundReceiptStore,
} from "./inbound-receipt-store.js";
export type {
  FeishuAppProfile,
  FeishuRegistration,
  FeishuRegistrationGateway,
  FeishuRegistrationResult,
} from "./registration.js";
export { DefaultFeishuRegistrationGateway } from "./registration.js";
export type {
  FeishuCandidateCheckOutcome,
  FeishuCandidateWaitReason,
  FeishuClaimedCheckOutcome,
} from "./setup-check.js";
export {
  boundedMissingScopes,
  classifyFeishuCandidateFailure,
  classifyFeishuProbeFailure,
  feishuRetryAfterMs,
  missingRequiredScopes,
} from "./setup-check.js";
export {
  type DecodedFeishuSetupContext,
  decodeFeishuSetupContext,
  encodeFeishuSetupCandidate,
  encodeFeishuSetupQr,
  FEISHU_SETUP_CANDIDATE_KIND,
  FEISHU_SETUP_CANDIDATE_VERSION,
  type FeishuSetupCandidateContext,
  FeishuSetupCandidateContextSchema,
  type FeishuSetupCandidateObservation,
  FeishuSetupCandidateObservationSchema,
  type FeishuSetupQrContext,
  FeishuSetupQrContextSchema,
} from "./setup-context.js";
export type { FeishuBindingActivation, FeishuSetupTiming } from "./setup-service.js";
export { DEFAULT_FEISHU_CANDIDATE_TTL_MS, FeishuSetupService } from "./setup-service.js";
