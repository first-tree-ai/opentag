import type {
  ListAccountComputersResponse,
  LocalComputerPreparationResult,
  LocalPreparationAction,
  LocalPreparationCheck,
  LocalPreparationComponent,
} from "@opentag/shared";

export function formatComputerList(response: ListAccountComputersResponse): string {
  if (response.computers.length === 0) return "No Computers registered";
  return response.computers
    .map((computer) =>
      [
        computer.displayName,
        computer.computerId,
        computer.connectionStatus,
        computer.platform,
        computer.lastSeenAt,
      ].join("\t"),
    )
    .join("\n");
}

function actionText(action: LocalPreparationAction): string {
  return action.command ?? action.instruction ?? "";
}

/**
 * One-line row summary shared by the connect preparation output and `computer runtime-inspect`.
 * `(blocking)` marks every non-ready row that gates the local-ready verdict, and the inline message
 * or version keeps the row self-contained.
 */
export function formatPreparationCheckLine(check: LocalPreparationCheck): string {
  const blocking = check.blocking ? " (blocking)" : "";
  const detail = [check.version, check.message].filter((value) => value !== undefined).join(" — ");
  return `[${check.id}] ${check.status}${blocking}${detail ? ` — ${detail}` : ""}`;
}

function formatActionLines(check: LocalPreparationCheck, indent: string): string[] {
  const lines: string[] = [];
  for (const warning of check.warnings ?? []) {
    lines.push(`${indent}warning (non-blocking): ${warning.code}${warning.message ? ` — ${warning.message}` : ""}`);
  }
  if (check.nextAction) lines.push(`${indent}next: ${actionText(check.nextAction)}`);
  if (check.verifyAction) lines.push(`${indent}verify: ${actionText(check.verifyAction)}`);
  return lines;
}

/** Human projection of one Component: summary, child Checks, warnings, and repair/verify actions. */
export function formatPreparationComponentLines(component: LocalPreparationComponent): string[] {
  const lines = [formatPreparationCheckLine(component)];
  for (const child of component.checks ?? []) {
    lines.push(`  ${formatPreparationCheckLine(child)}`);
    lines.push(...formatActionLines(child, "    "));
  }
  lines.push(...formatActionLines(component, "  "));
  return lines;
}

/**
 * The shared human verdict for one local computer preparation result. The human summary and the
 * JSON envelope both project this same value, so they cannot disagree on blockers or next actions.
 */
export function formatPreparationResultLines(result: LocalComputerPreparationResult): string[] {
  const lines = [
    `Local computer preparation: ${result.status === "ready" ? "READY" : "NEEDS_ATTENTION"}`,
    `${result.readyCount} / ${result.requiredCount} ready`,
  ];
  for (const component of result.components) {
    lines.push(...formatPreparationComponentLines(component));
  }
  return lines;
}
