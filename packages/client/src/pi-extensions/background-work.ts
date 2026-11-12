/**
 * OpenTag background work Pi extension (trusted built artifact).
 *
 * Pi deliberately has no background shell, and a process started with `&` in its bash tool escapes to
 * its own process group, where nothing can see or stop it. This extension gives the model a tool whose
 * work OpenTag can follow, with the same experience as native Claude Code: the Run stays open while the
 * work is live, and the model is woken with the result when it ends.
 *
 * - The child stays in Pi's process group, so stopping the Run stops the child.
 * - The list goes to OpenTag over `setStatus`, Pi's fire-and-forget channel, as JSON under
 *   `BACKGROUND_WORK_STATUS_KEY`.
 * - Waking uses `sendMessage` with `triggerTurn`, which Pi turns into a new agent run when idle and a
 *   queued continuation when busy, so `agent_settled` never precedes it.
 *
 * This module is intentionally self-contained (Node builtins only, no package imports): it runs inside
 * the Pi process and must never resolve workspace dependencies.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BACKGROUND_WORK_STATUS_KEY = "opentag-background-work";
export const BACKGROUND_WORK_TOOL = "background_bash";
const OUTPUT_TAIL_BYTES = 4_000;

export interface BackgroundWorkStatusItem {
  readonly id: string;
  readonly label: string;
  readonly outputPath: string;
}

export interface BackgroundWorkFinish {
  readonly id: string;
  readonly status: "completed" | "failed";
  readonly detail: string;
  readonly outputPath: string;
}

export interface BackgroundWorkStatus {
  readonly live: readonly BackgroundWorkStatusItem[];
  readonly finished?: BackgroundWorkFinish;
}

interface ExtensionContext {
  readonly cwd: string;
  readonly ui: { setStatus(key: string, text: string | undefined): void };
}

interface ExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: { command: string; description?: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
  }): void;
  on(event: "session_shutdown", handler: () => void): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { triggerTurn: boolean; deliverAs: "followUp" },
  ): void;
}

export default function backgroundWorkExtension(pi: ExtensionApi): void {
  const live = new Map<string, { item: BackgroundWorkStatusItem; child: ChildProcess }>();
  let outputDirectory: string | undefined;
  // The whole process group gets the signal, so a child can end before Pi reports its shutdown. Work the
  // Run is stopping must not wake the model; OpenTag reports it as stopped itself.
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  const publish = (ctx: ExtensionContext, finished?: BackgroundWorkFinish) => {
    const status: BackgroundWorkStatus = {
      live: [...live.values()].map(({ item }) => item),
      ...(finished ? { finished } : {}),
    };
    ctx.ui.setStatus(BACKGROUND_WORK_STATUS_KEY, JSON.stringify(status));
  };

  pi.on("session_shutdown", () => {
    stopping = true;
    for (const { child } of live.values()) child.kill("SIGTERM");
  });

  pi.registerTool({
    name: BACKGROUND_WORK_TOOL,
    label: "Background",
    description:
      "Start a shell command in the background and return at once. The current Run stays open while it runs, you may end your turn, and you are told its exit code and output when it ends. It stops if the Run reaches its limit.",
    promptSnippet: "Start a shell command in the background; you are told when it ends",
    promptGuidelines: [
      "Use background_bash for any command you do not want to wait for. Never background with bash using &, nohup or setsid: nothing would tell you when such a process ends, and it may stop without notice.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        description: { type: "string", description: "A few words naming the work" },
      },
      required: ["command"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      outputDirectory ??= mkdtempSync(join(tmpdir(), "opentag-background-"));
      const outputPath = join(outputDirectory, `${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.log`);
      const output = openSync(outputPath, "a");
      // Not detached: the child must stay in Pi's process group, so that stopping the Run stops it.
      const child = spawn(existsSync("/bin/bash") ? "/bin/bash" : "sh", ["-c", params.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", output, output],
      });
      closeSync(output);
      const item = { id: toolCallId, label: params.description || params.command, outputPath };
      const finish = (status: BackgroundWorkFinish["status"], detail: string) => {
        if (stopping || !live.delete(toolCallId)) return;
        publish(ctx, { id: toolCallId, status, detail, outputPath });
        pi.sendMessage(
          { customType: BACKGROUND_WORK_STATUS_KEY, content: finishNotice(item, detail), display: false },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      };
      live.set(toolCallId, { item, child });
      publish(ctx);
      child.once("error", (error) => finish("failed", `could not start: ${error.message}`));
      child.once("close", (code, signal) =>
        finish(code === 0 ? "completed" : "failed", signal ? `killed by ${signal}` : `exit code ${code}`),
      );
      return {
        content: [
          {
            type: "text",
            text: `Started in the background. Output goes to ${outputPath}. You will be told when it ends; you may end your turn.`,
          },
        ],
        details: {},
      };
    },
  });
}

function finishNotice(item: BackgroundWorkStatusItem, detail: string): string {
  const tail = readTail(item.outputPath);
  return [
    `[openTag notice] A background command you started has finished: ${item.label} (${detail}). Full output: ${item.outputPath}`,
    tail ? `Output (tail):\n${tail}` : "It produced no output.",
  ].join("\n");
}

function readTail(path: string): string {
  const file = openSync(path, "r");
  try {
    const { size } = fstatSync(file);
    const tail = Buffer.alloc(Math.min(size, OUTPUT_TAIL_BYTES));
    readSync(file, tail, 0, tail.length, size - tail.length);
    return tail.toString("utf8");
  } finally {
    closeSync(file);
  }
}
