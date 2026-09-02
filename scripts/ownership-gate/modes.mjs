export const MODE_GATE = "gate";
export const MODE_TERRITORY = "territory";
export const MODE_EXEMPT = "exempt";

export const MODES = new Set([MODE_GATE, MODE_TERRITORY, MODE_EXEMPT]);

/**
 * Mode is a second source of truth living outside CODEOWNERS: the check keys it
 * by rule pattern, so the two files can drift apart. Both drift directions are
 * closed deliberately. Forward drift (a CODEOWNERS rule with no mode entry)
 * resolves to `gate` here, so an edit made by someone who never read this file
 * still fails safe. Reverse drift (a mode entry whose pattern no longer exists)
 * is how an exemption list quietly grows back, and is rejected offline by
 * `scripts/check-ownership-policy.mjs`, which also requires every rule to carry
 * an explicit entry.
 */
export const DEFAULT_MODE = MODE_GATE;

export class ModeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModeConfigError";
  }
}

function assertRuleShape(entry, index) {
  if (typeof entry?.pattern !== "string" || entry.pattern.length === 0) {
    throw new ModeConfigError(`rules[${index}] must have a non-empty string "pattern"`);
  }
  if (!MODES.has(entry.mode)) {
    throw new ModeConfigError(
      `rules[${index}] ("${entry.pattern}") has mode ${JSON.stringify(entry.mode)}; expected one of ${[...MODES].join(", ")}`,
    );
  }
}

function assertPinShape(entry, index) {
  if (typeof entry?.pattern !== "string" || entry.pattern.length === 0) {
    throw new ModeConfigError(`pins[${index}] must have a non-empty string "pattern"`);
  }
  if (typeof entry.reason !== "string" || entry.reason.length === 0) {
    throw new ModeConfigError(`pins[${index}] ("${entry.pattern}") must explain itself in "reason"`);
  }
}

/**
 * Validates the parsed `.github/ownership-modes.json` payload and indexes it by
 * pattern. Throws rather than defaulting, because a malformed mode table means
 * the gate cannot answer the question it exists to answer.
 */
export function parseModeConfig(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ModeConfigError("The mode table must be a JSON object");
  }
  if (!Array.isArray(payload.rules)) {
    throw new ModeConfigError('The mode table must have a "rules" array');
  }
  const pins = payload.pins ?? [];
  if (!Array.isArray(pins)) {
    throw new ModeConfigError('"pins" must be an array when present');
  }

  const byPattern = new Map();
  const duplicates = [];
  payload.rules.forEach((entry, index) => {
    assertRuleShape(entry, index);
    if (byPattern.has(entry.pattern)) {
      duplicates.push(entry.pattern);
    }
    byPattern.set(entry.pattern, entry.mode);
  });
  if (duplicates.length > 0) {
    throw new ModeConfigError(`The mode table declares a pattern more than once: ${duplicates.join(", ")}`);
  }
  pins.forEach(assertPinShape);

  return { version: payload.version ?? 1, byPattern, pins };
}

/** The declared mode for a rule pattern, falling back to the fail-safe default. */
export function modeForPattern(config, pattern) {
  return config.byPattern.get(pattern) ?? DEFAULT_MODE;
}

/** True when the pattern has no entry at all, i.e. it only got a mode by falling back. */
export function isUndeclaredPattern(config, pattern) {
  return !config.byPattern.has(pattern);
}
