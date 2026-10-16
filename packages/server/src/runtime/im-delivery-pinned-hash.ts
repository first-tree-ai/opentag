import {
  computeDirectInputHash,
  computeLegacyDirectInputHash,
  type DirectImMessageDeliveryRequest,
} from "@opentag/shared";

/** Frozen layouts that historical clients pinned before the current direct-input hash. */
const LEGACY_LAYOUTS = ["0.1.0", "self-configuration"] as const;

/**
 * Returns the hash of a pinned direct dispatch that matches `expected`, trying the current layout and
 * then each frozen historical layout. Returns `undefined` when no layout reproduces `expected`, so the
 * caller's equality check rejects the pinned payload.
 */
export function matchPinnedDirectInputHash(
  request: DirectImMessageDeliveryRequest,
  expected: string | null,
): string | undefined {
  if (computeDirectInputHash(request) === expected) return expected;
  for (const layout of LEGACY_LAYOUTS) {
    try {
      if (computeLegacyDirectInputHash(request, layout) === expected) return expected;
    } catch {
      // A layout that cannot represent this request is not a match; try the next one.
    }
  }
  return undefined;
}
