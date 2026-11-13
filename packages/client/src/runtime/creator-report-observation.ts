import { hashTuple, SessionCliCommandResponseSchema, SessionCliSendRequestSchema } from "@opentag/shared";
import type { AgentRuntimeEvent, JsonValue } from "../agent-runtime/types.js";

type Delivery = "accepted" | "failed" | "unknown";

/** Observe receipts for literal invocations of the managed CLI, without running or evaluating shell code. */
export class CreatorReportObservation {
  readonly #attempts = new Map<string, Delivery>();
  readonly #invocation: readonly string[];
  readonly #creatorSessionId: string;

  constructor(cliCommand: string, creatorSessionId: string) {
    this.#invocation = literalArguments(cliCommand) ?? [];
    this.#creatorSessionId = creatorSessionId;
  }

  observe(event: Extract<AgentRuntimeEvent, { type: "tool_completed" }>): void {
    const item = object(event.output);
    if (item?.type !== "commandExecution" || (item.status !== "completed" && item.status !== "failed")) return;
    const input = this.#sendInput(item.command);
    if (!input) return;
    const receipt = readReceipt(item, input.json, this.#creatorSessionId);
    if (!receipt || (input.messageId !== undefined && input.messageId.toLowerCase() !== receipt.messageId)) return;
    const request = SessionCliSendRequestSchema.safeParse({
      messageId: receipt.messageId,
      targetSessionId: this.#creatorSessionId,
      message: input.message,
    });
    if (!request.success) return;
    const key = hashTuple([receipt.messageId, request.data.message]);
    const previous = this.#attempts.get(key);
    // A later rejection cannot resolve a lost response from an earlier attempt.
    if (previous === "accepted" || (previous === "unknown" && receipt.status === "failed")) return;
    this.#attempts.set(key, receipt.status);
  }

  #sendInput(command: JsonValue | undefined) {
    const args = commandArguments(command);
    if (
      !args ||
      !this.#invocation[0]?.startsWith("/") ||
      !this.#invocation.every((word, index) => args[index] === word)
    )
      return undefined;
    const [group, action, target, ...flags] = args.slice(this.#invocation.length);
    if (group !== "session" || action !== "send" || target?.toLowerCase() !== this.#creatorSessionId) return undefined;
    return sendFlags(flags);
  }

  unresolved(): "failed" | "unknown" | undefined {
    let uncertain = false;
    for (const status of this.#attempts.values()) {
      if (status === "failed") return "failed";
      if (status === "unknown") uncertain = true;
    }
    return uncertain ? "unknown" : undefined;
  }
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function commandArguments(command: JsonValue | undefined): string[] | undefined {
  const args =
    typeof command === "string"
      ? literalArguments(command)
      : Array.isArray(command) && command.every((arg) => typeof arg === "string")
        ? command
        : undefined;
  if (!args) return undefined;
  const [program, flag, script] = args;
  if (
    program &&
    /^(?:\/bin\/|\/usr\/bin\/)(?:bash|zsh|sh)$/.test(program) &&
    (flag === "-c" || flag === "-lc") &&
    script !== undefined &&
    args.length === 3
  ) {
    return literalArguments(script);
  }
  return args;
}

function literalArguments(command: string): string[] | undefined {
  // Shell operators, expansions and redirections are intentionally outside the literal grammar.
  const word = /(?:'([^']*)'|"((?:[^"\x24`\\]|\\["\x24`\\])*)"|([a-zA-Z0-9_./:=+@%,-]+)|\\(['"]))/y;
  const args: string[] = [];
  let position = 0;
  while (position < command.length) {
    if (command[position] === " " || command[position] === "\t") {
      position += 1;
      continue;
    }
    let arg = "";
    while (position < command.length && command[position] !== " " && command[position] !== "\t") {
      word.lastIndex = position;
      const part = word.exec(command);
      if (!part) return undefined;
      arg += part[1] ?? part[2]?.replaceAll(/\\(["\x24`\\])/g, "$1") ?? part[3] ?? part[4] ?? "";
      position = word.lastIndex;
    }
    args.push(arg);
  }
  return args;
}

function sendFlags(args: readonly string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flags.has(flag)) return undefined;
    if (flag === "--json" && equals < 0) {
      flags.set(flag, "");
      continue;
    }
    if (flag !== "--message" && flag !== "--message-id") return undefined;
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (value === undefined) return undefined;
    flags.set(flag, value);
  }
  return { message: flags.get("--message"), messageId: flags.get("--message-id"), json: flags.has("--json") };
}

function readReceipt(item: Record<string, JsonValue>, json: boolean, creatorSessionId: string) {
  const { aggregatedOutput, exitCode } = item;
  if (typeof aggregatedOutput !== "string" || aggregatedOutput.length > 4096) return undefined;
  const text = aggregatedOutput.trim();
  const parsed = SessionCliCommandResponseSchema.safeParse(json ? jsonReceipt(text) : textReceipt(text));
  if (!parsed.success) return undefined;
  const { status, sessionId, code } = parsed.data;
  const messageId = parsed.data.messageId.toLowerCase();
  if (sessionId && sessionId.toLowerCase() !== creatorSessionId) return undefined;
  if (status === "accepted") return sessionId && exitCode === 0 ? { messageId, status } : undefined;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode <= 0 || !code) return undefined;
  // The Server's generic exception response does not prove that dispatch never started.
  const uncertain = status === "unknown" || (status === "unreachable" && !sessionId && code === "runtime_unavailable");
  const delivery: Delivery = uncertain ? "unknown" : "failed";
  return { messageId, status: delivery };
}

function jsonReceipt(text: string): unknown {
  try {
    const { message, ...receipt } = JSON.parse(text);
    if (message !== undefined && (typeof message !== "string" || receipt.status === "accepted")) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function textReceipt(text: string): unknown {
  const match =
    /^status=(\w+) messageId=([\w-]+)(?: sessionId=([\w-]+))?(?: code=([\w-]+))?(?: message="(?:[^"\\\r\n]|\\.)*")?$/.exec(
      text,
    );
  if (!match) return undefined;
  const [, status, messageId, sessionId, code] = match;
  return { status, messageId, ...(sessionId ? { sessionId } : {}), ...(code ? { code } : {}) };
}
