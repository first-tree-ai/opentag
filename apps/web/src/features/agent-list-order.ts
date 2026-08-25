/**
 * Display order for the Agent list, held stable for as long as the list stays mounted.
 *
 * The list revalidates in the background every 30 seconds, and its status-first sort moves a
 * row the moment an Agent's availability changes. Because the whole row is a link, a row that
 * moves under the pointer opens a different Agent than the one that was pressed. Rows keep the
 * position they were first shown in, and an Agent that changes state turns amber where it
 * already is rather than jumping to the top unobserved. Agents added since the first render
 * join at the end, in the incoming order.
 *
 * The result is stable under reapplication, so re-rendering with an unchanged list is a no-op.
 */
export function orderAgentIds(currentIds: readonly string[], previousOrder: readonly string[]): string[] {
  const current = new Set(currentIds);
  const kept = previousOrder.filter((id) => current.has(id));
  const shown = new Set(kept);
  return [...kept, ...currentIds.filter((id) => !shown.has(id))];
}
