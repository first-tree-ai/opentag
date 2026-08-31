import { chmod } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { writeDurableFile } from "../../storage/durable-file.js";
import { assertIdentity, ProviderCliTurnPlanError } from "./turn-plan.js";
import type { ProviderCliProvider } from "./types.js";

const TURN_LAUNCHER_MARKER = "# opentag-provider-cli-turn-launcher: v1";

export interface ProviderCliTurnLauncherSpec {
  readonly provider: ProviderCliProvider;
  readonly runId: string;
  readonly planPath: string;
  /** Absolute argv that starts the current daemon Node and loads the runner module. */
  readonly runnerInvocation: readonly string[];
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function assertProviderCliTurnRunnerInvocation(invocation: readonly string[]): readonly string[] {
  if (invocation.length < 2) {
    throw new ProviderCliTurnPlanError(
      "invalid_identity",
      "The Provider CLI Turn runner invocation must include Node and the runner module",
    );
  }
  const nodePath = invocation[0];
  if (typeof nodePath !== "string" || !isAbsolute(nodePath)) {
    throw new ProviderCliTurnPlanError(
      "invalid_identity",
      "The Provider CLI Turn runner must use an absolute Node path",
    );
  }
  for (const argument of invocation) {
    assertIdentity("runnerInvocation", argument);
    if (argument.includes("\t")) {
      throw new ProviderCliTurnPlanError("invalid_identity", "The Provider CLI Turn runner invocation is unsafe");
    }
  }
  return invocation;
}

/**
 * Private native-name launcher. It only execs the injected daemon Node/module
 * invocation, then forwards user argv after `--` without interpreting it.
 */
export function renderProviderCliTurnLauncher(spec: ProviderCliTurnLauncherSpec): string {
  assertProviderCliTurnRunnerInvocation(spec.runnerInvocation);
  assertIdentity("runId", spec.runId);
  if (!isAbsolute(spec.planPath)) {
    throw new ProviderCliTurnPlanError("unsafe", "The Provider CLI Turn plan path must be absolute");
  }
  const argv = [
    ...spec.runnerInvocation,
    "--plan",
    spec.planPath,
    "--provider",
    spec.provider,
    "--run-id",
    spec.runId,
    "--",
  ];
  return [
    "#!/bin/sh",
    `${TURN_LAUNCHER_MARKER} provider=${spec.provider}`,
    "# OpenTag private Turn launcher. Published per Run; do not edit.",
    `exec ${argv.map(shellSingleQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

export async function writeProviderCliTurnLauncher(path: string, spec: ProviderCliTurnLauncherSpec): Promise<void> {
  const content = renderProviderCliTurnLauncher(spec);
  await writeDurableFile(path, content, 0o700);
  await chmod(path, 0o700);
}
