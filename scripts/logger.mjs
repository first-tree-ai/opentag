const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = "info";
const DEFAULT_PREFIX = "[script]";

/**
 * Normalizes an arbitrary level string, falling back to `info` so a typo in the
 * workflow environment degrades to the default instead of silencing the sweep.
 */
export function resolveLogLevel(rawLevel) {
  const normalized = String(rawLevel ?? "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(LEVELS, normalized) ? normalized : DEFAULT_LEVEL;
}

function formatDetails(details) {
  if (details === undefined) {
    return "";
  }
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return " [unserializable details]";
  }
}

/**
 * Creates a level-aware logger shared by the repository automation scripts.
 * Production runs stay at `info`; re-running a workflow with debug logging
 * enabled raises it to `debug`, which prints every per-item decision and the
 * API rate-limit budget. `prefix` names the script in the run log.
 */
export function createLogger({ level = DEFAULT_LEVEL, prefix = DEFAULT_PREFIX, sink = console } = {}) {
  const resolved = resolveLogLevel(level);
  const threshold = LEVELS[resolved];

  const emit = (name, write, message, details) => {
    if (LEVELS[name] > threshold) {
      return;
    }
    write(`${prefix} ${name.toUpperCase()} ${message}${formatDetails(details)}`);
  };

  const log = (...args) => sink.log(...args);
  const warn = typeof sink.warn === "function" ? (...args) => sink.warn(...args) : log;
  const error = typeof sink.error === "function" ? (...args) => sink.error(...args) : log;

  return {
    level: resolved,
    error: (message, details) => emit("error", error, message, details),
    warn: (message, details) => emit("warn", warn, message, details),
    info: (message, details) => emit("info", log, message, details),
    debug: (message, details) => emit("debug", log, message, details),
  };
}
