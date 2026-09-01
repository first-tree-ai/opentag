import { redactForLog } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";

export interface ServiceLogger {
  debug(bindings: Record<string, unknown>, message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createServiceLoggerPort(getLogger: () => FastifyBaseLogger | undefined, module: string): ServiceLogger {
  const write = (level: "debug" | "info" | "warn" | "error", bindings: Record<string, unknown>, message: string) => {
    try {
      const logger = getLogger();
      if (!logger) return;
      const payload = redactForLog({ ...bindings, module }) as Record<string, unknown>;
      logger[level](payload, message);
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
