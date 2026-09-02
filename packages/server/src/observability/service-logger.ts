import { redactForLog } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";

export interface ServiceLogger {
  debug(bindings: Record<string, unknown>, message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

interface LevelAwareLogger {
  isLevelEnabled(level: string): boolean;
}

function isLevelAware(logger: FastifyBaseLogger): logger is FastifyBaseLogger & LevelAwareLogger {
  return typeof (logger as Partial<LevelAwareLogger>).isLevelEnabled === "function";
}

export function createServiceLoggerPort(getLogger: () => FastifyBaseLogger | undefined, module: string): ServiceLogger {
  const write = (level: "debug" | "info" | "warn" | "error", bindings: Record<string, unknown>, message: string) => {
    try {
      const logger = getLogger();
      if (!logger) return;
      // Same reason as the client logger: redaction rewrites every string, so a discarded level must
      // not pay for it. FastifyBaseLogger does not declare isLevelEnabled even though the Pino
      // instance behind it has one, so the capability is detected rather than assumed.
      if (isLevelAware(logger) && !logger.isLevelEnabled(level)) return;
      const payload = redactForLog({ ...bindings, module }) as Record<string, unknown>;
      // The message is the second Pino argument and crosses the same boundary, so it is redacted
      // and byte-capped too: an adoption lane passing a provider or exception message here must not
      // be able to write a credential or an unbounded string through the seam advertised as safe.
      logger[level](payload, redactForLog(message));
    } catch {
      // Logging failures must never replace the observed business failure.
    }
  };

  return {
    debug: (bindings, message) => write("debug", bindings, message),
    info: (bindings, message) => write("info", bindings, message),
    warn: (bindings, message) => write("warn", bindings, message),
    error: (bindings, message) => write("error", bindings, message),
  };
}
