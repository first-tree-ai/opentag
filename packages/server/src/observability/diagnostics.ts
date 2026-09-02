import { redactForLog } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";
import { outcomeAttrs, safeDiagnosticCode } from "./attributes.js";
import { emitRootSpan } from "./otel-helpers.js";

export function createServerDiagnosticReporter(
  logger: () => FastifyBaseLogger | undefined,
): (code: string, context?: Record<string, unknown>) => void {
  return (rawCode, context) => {
    const code = safeDiagnosticCode(rawCode);
    try {
      logger()?.error(redactForLog({ ...context, code }), "Server diagnostic");
    } catch {
      // A diagnostic logger is never allowed to break the observed operation.
    }
    emitRootSpan("server.diagnostic", outcomeAttrs("failed", code), new Error(code));
  };
}
