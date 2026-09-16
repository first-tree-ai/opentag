import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES, RunnerPiConfigInputSchema } from "@opentag/shared";
import { z } from "zod";
import { runRunnerAcceptance } from "./acceptance.js";
import { copyIsolatedPiConfig } from "./config.js";
import { registerRunnerSignalCleanup } from "./signals.js";

/**
 * In-sandbox acceptance worker. Runs INSIDE the native sandbox (launched via `sandbox exec`).
 * The bounded stdin document is the only input: real-mode Pi credentials travel through stdin
 * and land only in a disposable Pi home inside the disposable sandbox filesystem — never in
 * argv, env, logs, or any parent-visible storage. stdout carries exactly one JSON result line;
 * the report is already redacted by the acceptance runner.
 */

export const WORKER_STDIN_MAX_BYTES = RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES;
export const WORKER_DEFAULT_WORKSPACE = "/workspace";

const WorkerRequestSchema = z
  .object({
    kind: z.literal("acceptance"),
    mode: z.enum(["offline", "real"]),
    piConfig: RunnerPiConfigInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "acceptance" && value.mode === "real" && !value.piConfig) {
      context.addIssue({ code: "custom", path: ["piConfig"], message: "Real acceptance requires piConfig" });
    }
    if (value.mode === "offline" && value.piConfig) {
      context.addIssue({ code: "custom", path: ["piConfig"], message: "Offline acceptance must not carry piConfig" });
    }
  });

export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

export interface WorkerIo {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  readonly env?: NodeJS.ProcessEnv;
}

export interface WorkerOptions {
  readonly workspace?: string;
  readonly runAcceptance?: typeof runRunnerAcceptance;
  readonly now?: () => number;
}

async function readStdinBounded(stdin: NodeJS.ReadStream, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > limit) {
        reject(new Error("Worker stdin payload exceeded bounds"));
        stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", (error) => reject(error));
  });
}

async function writeDisposablePiConfig(
  piHome: string,
  config: z.infer<typeof RunnerPiConfigInputSchema>,
): Promise<void> {
  // The worker trusts the parent-Runner's schema bounds but still writes each document as an
  // owned 0600 file inside the fresh 0700 home; nothing else in the sandbox can observe them.
  await writeFile(join(piHome, "auth.json"), config.authJson, { encoding: "utf8", mode: 0o600 });
  if (config.modelsJson !== undefined) {
    await writeFile(join(piHome, "models.json"), config.modelsJson, { encoding: "utf8", mode: 0o600 });
  }
  if (config.settingsJson !== undefined) {
    await writeFile(join(piHome, "settings.json"), config.settingsJson, { encoding: "utf8", mode: 0o600 });
  }
}

export async function runRunnerWorker(io: WorkerIo, options: WorkerOptions = {}): Promise<number> {
  const emit = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  let scratch: string | undefined;
  try {
    const raw = await readStdinBounded(io.stdin, WORKER_STDIN_MAX_BYTES);
    let parsed: WorkerRequest;
    try {
      parsed = WorkerRequestSchema.parse(JSON.parse(raw));
    } catch {
      emit({ kind: "error", code: "worker_request_invalid", message: "The worker stdin payload is invalid" });
      return 2;
    }
    // Everything disposable lives under one owned scratch root inside the sandbox filesystem.
    scratch = await mkdtemp(join(tmpdir(), "opentag-runner-worker-"));
    registerRunnerSignalCleanup(async () => {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    });
    const home = join(scratch, "home");
    let piHome = join(scratch, "pi-agent");
    const sessionDirectory = join(scratch, "sessions");
    if (parsed.piConfig) {
      await mkdir(piHome, { recursive: true, mode: 0o700 });
      await writeDisposablePiConfig(piHome, parsed.piConfig);
      piHome = await copyIsolatedPiConfig({
        source: piHome,
        destination: join(scratch, "filtered-pi"),
        providers: ["deepseek"],
      });
    }
    // Defensive: nothing in the run should see the sandbox container's ambient HOME.

    await mkdir(home, { recursive: true, mode: 0o700 });
    const runAcceptance = options.runAcceptance ?? runRunnerAcceptance;
    const report = await runAcceptance({
      mode: parsed.mode,
      piHome,
      runtimeHome: home,
      path: io.env?.PATH ?? process.env.PATH,
      sessionDirectory,
      workspace: options.workspace ?? WORKER_DEFAULT_WORKSPACE,
    });
    emit({ kind: "result", report });
    return report.failed ? 1 : 0;
  } catch {
    emit({ kind: "error", code: "worker_failed", message: "The in-sandbox worker failed" });
    return 1;
  } finally {
    registerRunnerSignalCleanup(undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
