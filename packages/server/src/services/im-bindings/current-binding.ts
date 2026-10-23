import { and, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { imBindings } from "../../db/schema/index.js";

/**
 * Setup outcomes that end an attempt without activating its binding. A row that never activated and
 * carries one of these is a finished attempt, not a connection: `currentBindingOf` hides it from the
 * binding reads and `releaseNeverActivatedSlots` gives its slot back.
 */
export const TERMINAL_SETUP_STATES = ["canceled", "expired", "failed"] as const;

/**
 * The current-binding predicate: a non-disabled row for this Agent that is still a connection.
 *
 * A first-time setup inserts the row as `provisioning` before anything is authorized, so the row's
 * existence alone is not a connection. `provisioning` keeps counting while an attempt is in flight
 * (`awaiting_user`, `validating`, `pending_activation`); once that attempt ends `canceled`, `expired`
 * or `failed` the row is only a reusable slot and must not read back as connected.
 *
 * `provisioning` is part of that exclusion on purpose: a reauthorization attempt on a working binding
 * also ends `canceled`, and the `active` connection must keep being reported. A null `setup_state`
 * counts as current, so a row without setup fields never silently disappears.
 */
export function currentBindingOf(agentId: string) {
  return and(
    eq(imBindings.agentId, agentId),
    ne(imBindings.status, "disabled"),
    or(
      ne(imBindings.status, "provisioning"),
      isNull(imBindings.setupState),
      notInArray(imBindings.setupState, [...TERMINAL_SETUP_STATES]),
    ),
  );
}
