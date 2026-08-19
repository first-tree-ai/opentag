import type { ClientLogBindings, ClientLogger } from "../observability/logger.js";

export interface RecordedLog {
  fields: ClientLogBindings;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

export function recordingLogger(entries: RecordedLog[], bindings: ClientLogBindings = {}): ClientLogger {
  const record = (level: RecordedLog["level"], fields: ClientLogBindings, message: string) => {
    entries.push({ fields: { ...bindings, ...fields }, level, message });
  };
  return {
    child: (childBindings) => recordingLogger(entries, { ...bindings, ...childBindings }),
    debug: (fields, message) => record("debug", fields, message),
    error: (fields, message) => record("error", fields, message),
    info: (fields, message) => record("info", fields, message),
    warn: (fields, message) => record("warn", fields, message),
  };
}
