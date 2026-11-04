import { vi } from "vitest";
import type { FeishuRegistration } from "../../services/im-bindings/feishu/registration.js";
import { deferred } from "./deferred.js";

export function abortableMockFeishuRegistration(registration: FeishuRegistration): FeishuRegistration {
  const canceled = deferred<never>();
  const result = Promise.race([registration.result, canceled.promise]);
  void result.catch(() => undefined);
  return {
    ...registration,
    qrReady: Promise.race([registration.qrReady, canceled.promise]),
    result,
    abort: vi.fn(() => {
      try {
        registration.abort();
      } finally {
        canceled.reject(Object.assign(new Error("Registration canceled"), { code: "abort" }));
      }
    }),
  };
}
