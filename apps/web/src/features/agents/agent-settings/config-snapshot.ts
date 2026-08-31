import type { AgentAdminConfig } from "@opentag/shared/browser";
import { useRef } from "react";

/**
 * The newer of two readings of one Agent's configuration.
 *
 * A revision only moves forward, so a reading behind one already in hand is a late answer to an
 * older question rather than news. Ordering by revision instead of by arrival is what lets one
 * record be edited from several places on the same screen: an out-of-order refresh cannot walk an
 * editor back to a revision the next write would then be refused for.
 */
export function newerConfig(current: AgentAdminConfig | undefined, candidate: AgentAdminConfig): AgentAdminConfig {
  if (!current || current.id !== candidate.id || candidate.revision >= current.revision) return candidate;
  return current;
}

/**
 * Follows a configuration as it is re-read, without ever moving back to an older revision.
 *
 * The high-water mark is a ref rather than state because it is derived from the prop rather than
 * held against it: `newerConfig` is monotonic and idempotent, so recomputing it during a render --
 * including a repeated one -- lands on the same answer, and reading it here means a refreshed
 * config is in hand on the render that delivered it rather than one render later.
 */
export function useLatestConfig(incoming: AgentAdminConfig): AgentAdminConfig {
  const latest = useRef(incoming);
  latest.current = newerConfig(latest.current, incoming);
  return latest.current;
}
