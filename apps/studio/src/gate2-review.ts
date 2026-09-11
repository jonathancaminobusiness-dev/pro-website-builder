/**
 * What the Gate 2 screen may offer the captain, derived from the evidence the
 * run actually produced. The stage measures the viewports it was able to, and
 * that set can be a subset of the declared widths, so the A/B view never opens
 * at a width nothing was captured at.
 */
export function measuredViewport(measured: number[], current: number | null): number | null {
  if (measured.length === 0) return null;
  if (current !== null && measured.includes(current)) return current;
  return Math.max(...measured);
}

/**
 * The findings still waiting for the captain. The gate closes on a reviewed
 * set, so approval is offered only when nothing here is left.
 */
export function pendingFindingIds(
  issues: ReadonlyArray<{ id: string }>,
  decisions: ReadonlyArray<{ findingId: string }>,
): string[] {
  const decided = new Set(decisions.map((entry) => entry.findingId));
  return issues.filter((issue) => !decided.has(issue.id)).map((issue) => issue.id);
}
