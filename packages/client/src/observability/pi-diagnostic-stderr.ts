export const PI_STARTUP_TIMING_PREFIX = "opentag-pi-startup:";

interface PiDiagnosticStderr {
  write(line: string, callback?: (error?: Error | null) => void): unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

const stderrStates = new WeakMap<PiDiagnosticStderr, { failed: boolean }>();

export function createPiDiagnosticStderrWriter(stderr: PiDiagnosticStderr): (line: string) => void {
  let state = stderrStates.get(stderr);
  if (!state) {
    state = { failed: false };
    stderrStates.set(stderr, state);
    const shared = state;
    try {
      stderr.on?.("error", () => {
        shared.failed = true;
      });
    } catch {
      shared.failed = true;
    }
  }
  const shared = state;
  return (line) => {
    if (shared.failed) throw new Error("Pi diagnostic stderr is unavailable");
    stderr.write(line, (error) => {
      if (error) shared.failed = true;
    });
  };
}
