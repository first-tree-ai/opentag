import type { SessionMessageDeliveryRequestV3 } from "@opentag/shared";
import type { AgentSteerOutcome, AgentSteerReceipt } from "../agent-runtime/types.js";
import { MAX_RECORDED_STEERS } from "./interruption-retry.js";
import type { JoinableRuns } from "./session-message-inbox.js";

/** How long a retry waits for steers still in flight before it gives up. */
const STEER_SETTLE_TIMEOUT_MS = 10_000;

const RUN_ID_PREFIX = "session-message-";

/** The Run of a Session message running on its own; messages steered into it record this id. */
export function sessionMessageRunId(messageId: string): string {
  return `${RUN_ID_PREFIX}${messageId}`;
}

/** The message whose own Run this is, or undefined for another kind of Run, such as an IM Turn. */
export function sessionMessageOfRun(runId: string): string | undefined {
  return runId.startsWith(RUN_ID_PREFIX) ? runId.slice(RUN_ID_PREFIX.length) : undefined;
}

/**
 * The messages steered into one Session message Run. They have no retry count of their own: they
 * retry with the Run, in order, and end with it.
 */
export class SessionMessageRun implements JoinableRuns {
  readonly id: string;
  readonly #settle: (message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome) => Promise<void>;
  /** Messages an earlier attempt held; the current attempt's input replays them. */
  #carried: SessionMessageDeliveryRequestV3[] = [];
  /** Messages steered into the current attempt, in order, with what the provider did with them. */
  readonly #joined = new Map<string, { message: SessionMessageDeliveryRequestV3; receipt: AgentSteerReceipt }>();
  /** Messages being steered: how to end each one's place in `#steering`. */
  readonly #joining = new Map<string, () => void>();
  readonly #steering = new Set<Promise<void>>();
  #attemptEnded = false;
  #settled = false;

  constructor(
    id: string,
    settle: (message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome) => Promise<void>,
  ) {
    this.id = id;
    this.#settle = settle;
  }

  get carried(): readonly SessionMessageDeliveryRequestV3[] {
    return this.#carried;
  }

  reserve(message: SessionMessageDeliveryRequestV3): boolean {
    if (this.#attemptEnded || this.#settled) return false;
    if (this.#carried.length + this.#joined.size + this.#joining.size >= MAX_RECORDED_STEERS) return false;
    let done!: () => void;
    const steering = new Promise<void>((resolve) => {
      done = () => {
        this.#steering.delete(steering);
        resolve();
      };
    });
    this.#steering.add(steering);
    this.#joining.set(message.messageId, done);
    return true;
  }

  release(message: SessionMessageDeliveryRequestV3): void {
    this.#joining.get(message.messageId)?.();
    this.#joining.delete(message.messageId);
  }

  steered(message: SessionMessageDeliveryRequestV3, _runId: string, receipt: AgentSteerReceipt): void {
    // Acknowledged after the Run was decided: nothing will settle it but its own receipt.
    if (this.#settled) void receipt.outcome.then((outcome) => this.#settle(message, outcome));
    else this.#joined.set(message.messageId, { message, receipt });
    this.release(message);
  }

  /**
   * The attempt ended: no new message joins, those still being steered finish, and any the provider
   * never began goes back to the FIFO. False means a steer never finished, so no retry can know what
   * it would carry.
   */
  async endAttempt(): Promise<boolean> {
    this.#attemptEnded = true;
    const settled = await steersSettled(this.#steering);
    if (!settled) return false;
    for (const [id, { message, receipt }] of [...this.#joined]) {
      if ((await receipt.outcome) !== "not_started") continue;
      this.#joined.delete(id);
      await this.#settle(message, "not_started");
    }
    return true;
  }

  /** The next attempt replays every message held so far, and new messages may join it. */
  startRetry(): void {
    this.#carried = [...this.#carried, ...[...this.#joined.values()].map(({ message }) => message)];
    this.#joined.clear();
    this.#attemptEnded = false;
  }

  /** Every message in the Run ends with it; resolves once their outcomes are durable. */
  async settle(completed: boolean): Promise<void> {
    this.#settled = true;
    await Promise.allSettled([
      ...this.#carried.map((message) => this.#settle(message, completed ? "processed" : "interrupted")),
      ...[...this.#joined.values()].map(async ({ message, receipt }) => {
        const outcome = await receipt.outcome;
        await this.#settle(message, outcome === "processed" && !completed ? "interrupted" : outcome);
      }),
    ]);
  }
}

async function steersSettled(steering: ReadonlySet<Promise<void>>): Promise<boolean> {
  if (steering.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), STEER_SETTLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.all(steering).then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
