import { spawn } from "node:child_process";

export async function spawnInheritedProcess(options: {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(options.file, [...options.args], {
      env: options.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (child.killed || child.exitCode !== null) return;
      child.kill(signal);
    };
    const onSigterm = (): void => forward("SIGTERM");
    const onSigint = (): void => forward("SIGINT");
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
    const stopListening = (): void => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };
    child.once("error", (error) => {
      stopListening();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      stopListening();
      if (code !== null) {
        resolveExit(code);
        return;
      }
      if (signal === "SIGTERM") {
        resolveExit(143);
        return;
      }
      if (signal === "SIGINT") {
        resolveExit(130);
        return;
      }
      resolveExit(1);
    });
  });
}

export async function flushStdout(): Promise<void> {
  const stdout = process.stdout;
  if (!stdout.writable || stdout.destroyed) return;
  if (typeof stdout.writableLength === "number" && stdout.writableLength === 0 && !stdout.writableNeedDrain) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    stdout.once("drain", finish);
    if (stdout.write(Buffer.alloc(0))) {
      stdout.off("drain", finish);
      resolve();
    }
  });
}

export async function spawnCapturedProcess(options: {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBytes: number;
  readonly forward: boolean;
}): Promise<{ code: number; stdout: Buffer; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.file, [...options.args], {
      env: options.env,
      shell: false,
      stdio: options.forward ? ["inherit", "pipe", "inherit"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = createStdoutCapture(options.maxBytes, options.forward, {
      pause: () => child.stdout?.pause(),
      resume: () => child.stdout?.resume(),
    });
    let exitCode = 1;
    let timedOut = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      stopListening();
      resolve({
        code: exitCode,
        stdout: Buffer.concat(capture.chunks),
        truncated: capture.truncated,
        timedOut,
      });
    };
    const stopListening = (): void => {
      if (options.forward) {
        process.off("SIGTERM", onSigterm);
        process.off("SIGINT", onSigint);
      }
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (child.killed || child.exitCode !== null) return;
      child.kill(signal);
    };
    const onSigterm = (): void => forwardSignal("SIGTERM");
    const onSigint = (): void => forwardSignal("SIGINT");
    if (options.forward) {
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);
    }
    child.stdout?.on("data", capture.onChunk);
    child.stdout?.on("error", () => undefined);
    if (!options.forward) child.stderr?.resume();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      stopListening();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== null) exitCode = code;
      else if (signal === "SIGTERM") exitCode = 143;
      else if (signal === "SIGINT") exitCode = 130;
      else exitCode = 1;
    });
    child.once("close", () => settle());
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
            forceTimer = setTimeout(settle, 50);
            forceTimer.unref();
          }, options.timeoutMs);
    timer?.unref();
  });
}

function createStdoutCapture(
  maxBytes: number,
  forward: boolean,
  flow: { pause(): void; resume(): void },
): { chunks: Buffer[]; truncated: boolean; onChunk(chunk: Buffer | string): void } {
  const chunks: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  let waitingForDrain = false;
  return {
    chunks,
    get truncated() {
      return truncated;
    },
    onChunk(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (forward) {
        const ok = process.stdout.write(buf);
        if (!ok && !waitingForDrain) {
          waitingForDrain = true;
          flow.pause();
          process.stdout.once("drain", () => {
            waitingForDrain = false;
            flow.resume();
          });
        }
      }
      if (truncated) return;
      const next = appendCapturedChunk(chunks, captured, buf, maxBytes);
      captured = next.captured;
      truncated = next.truncated;
    },
  };
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function appendCapturedChunk(
  chunks: Buffer[],
  captured: number,
  buf: Buffer,
  maxBytes: number,
): { captured: number; truncated: boolean } {
  if (captured + buf.length <= maxBytes) {
    chunks.push(buf);
    return { captured: captured + buf.length, truncated: false };
  }
  const take = maxBytes - captured;
  if (take > 0) chunks.push(buf.subarray(0, take));
  return { captured: maxBytes, truncated: true };
}
