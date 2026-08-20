import { imAttrs, outcomeAttrs } from "./attributes.js";
import { setActiveSpanAttributes, withRootSpan } from "./otel-helpers.js";

export type FeishuInboundFailureCode =
  | "FEISHU_INBOUND_ADMISSION_FAILED"
  | "FEISHU_INBOUND_DATABASE_FAILED"
  | "FEISHU_INBOUND_FAILED"
  | "FEISHU_INBOUND_FENCE_STALE"
  | "FEISHU_INBOUND_IDENTITY_MISMATCH"
  | "FEISHU_INBOUND_NORMALIZE_FAILED";

export async function traceFeishuInbound<T>(
  fn: (setFailureCode: (code: FeishuInboundFailureCode) => void) => Promise<T> | T,
): Promise<T> {
  return withRootSpan("im.inbound.process", imAttrs({ provider: "feishu" }), async () => {
    let failureCode: FeishuInboundFailureCode = "FEISHU_INBOUND_FAILED";
    try {
      return await fn((code) => {
        failureCode = code;
      });
    } catch (error) {
      setActiveSpanAttributes(outcomeAttrs("failed", failureCode));
      throw error;
    }
  });
}
