/**
 * Leveled logging for the Git hook scripts.
 *
 * Hook output is interleaved with Git's own output, so the default level stays quiet enough to read
 * while `OPENTAG_HOOKS_LOG_LEVEL=debug` exposes every decision the scripts make.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"];

export const DEFAULT_LOG_LEVEL = "info";

export function resolveLogLevel(rawLevel) {
  const normalized = rawLevel?.trim().toLowerCase();
  return normalized && LOG_LEVELS.includes(normalized) ? normalized : DEFAULT_LOG_LEVEL;
}

export function createLogger({ scope, env = process.env, streams = {} } = {}) {
  const level = resolveLogLevel(env.OPENTAG_HOOKS_LOG_LEVEL);
  const threshold = LOG_LEVELS.indexOf(level);
  const out = streams.out ?? ((line) => console.log(line));
  const error = streams.error ?? ((line) => console.error(line));

  const emit = (messageLevel, message) => {
    if (LOG_LEVELS.indexOf(messageLevel) > threshold) {
      return;
    }
    const line = `[${scope}] ${message}`;
    if (messageLevel === "error" || messageLevel === "warn") {
      error(line);
      return;
    }
    out(line);
  };

  return {
    level,
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}
