/**
 * Process-level signal lifecycle for the Runner CLI. The CLI usually runs as PID 1 in the
 * container, where SIGTERM/SIGINT are ignored unless a handler is installed; the entrypoint
 * registers handlers through `installRunnerSignalHandlers` (bin only) and the accept flow
 * registers its scoped cleanup (copied config, sessions) so `docker stop` ends in a prompt,
 * clean exit code instead of a SIGKILL escalation.
 */

export type RunnerSignalCleanup = () => Promise<void>;

let signalCleanup: RunnerSignalCleanup | undefined;

export function registerRunnerSignalCleanup(cleanup: RunnerSignalCleanup | undefined): void {
  signalCleanup = cleanup;
}

export function installRunnerSignalHandlers(
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
): void {
  let stopping = false;
  const signals = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const;
  for (const [signal, code] of signals) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const cleanup = signalCleanup;
      signalCleanup = undefined;
      Promise.resolve()
        .then(() => cleanup?.())
        .catch((error: unknown) => {
          process.stderr.write(
            `[opentag-runner] signal cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        })
        .finally(() => exit(code));
    });
  }
}
