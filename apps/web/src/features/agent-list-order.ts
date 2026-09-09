/**
 * Display order for the Agent list, held stable for as long as the list stays mounted.
 *
 * The Server orders Agents by creation time ascending, then ID ascending. Status, activity,
 * usage, and names do not affect that order. Because the whole row is a link, background
 * revalidation must also preserve the positions already shown under the viewer's pointer.
 * Surviving rows keep their relative order, and newly observed Agents join at the end in the
 * Server's order. Remounting the list starts from the same canonical Server order.
 *
 * The result is stable under reapplication, so re-rendering with an unchanged list is a no-op.
 */
export function orderAgentIds(currentIds: readonly string[], previousOrder: readonly string[]): string[] {
  const current = new Set(currentIds);
  const kept = previousOrder.filter((id) => current.has(id));
  const shown = new Set(kept);
  return [...kept, ...currentIds.filter((id) => !shown.has(id))];
}
