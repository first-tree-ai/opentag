import { resolve } from "node:path";
import type { DirectImMessageDeliveryRequest, RuntimeImOutboxContext } from "@opentag/shared";
import { createLogger } from "../observability/logger.js";
import { ensurePrivateDirectory, readDurableJson, writeDurableJson } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { deriveRuntimeKey } from "./runtime-paths.js";

const logger = createLogger("channel-idle-compaction");

/** A Channel Session idle for more than this compacts its provider context on its next Turn. */
export const CHANNEL_IDLE_COMPACTION_MS = 8 * 60 * 60 * 1000;

/** Exactly the threshold is not yet idle. An unknown or future activity time never compacts. */
export function channelIdleExceeded(lastActivityAt: string | undefined, now: number): boolean {
  if (lastActivityAt === undefined) return false;
  const last = Date.parse(lastActivityAt);
  return Number.isFinite(last) && now - last > CHANNEL_IDLE_COMPACTION_MS;
}

/**
 * Whether an IM delivery belongs to a Channel Session. A Thread Session exists only for an event
 * with a provider thread, and an observer copy of a thread message always goes to the Channel.
 */
export function isChannelDelivery(request: Pick<DirectImMessageDeliveryRequest, "content" | "replyRole">): boolean {
  if (request.replyRole === "observer") return true;
  const reference = request.content.providerRef;
  return reference.provider === "feishu" ? !reference.threadId : !reference.threadTs;
}

/** Whether a Session message's visible target is a Channel Session; internal Sessions have no outbox. */
export function isChannelOutbox(outboxContext: RuntimeImOutboxContext | undefined): boolean {
  return outboxContext?.sessionKind === "channel";
}

function parseActivity(value: unknown): string {
  const lastActivityAt = (value as { lastActivityAt?: unknown } | null)?.lastActivityAt;
  if (typeof lastActivityAt !== "string") throw new Error("Session activity record is invalid");
  return lastActivityAt;
}

/**
 * When each Channel Session last ran a Turn on this Computer. It lives beside the native conversation
 * it describes, not on the Server: a new placement starts from its own native history. One small
 * private file per Channel Session. Activity is an optimization signal, so a storage failure is
 * logged and the Turn runs without compaction.
 */
export class ChannelActivityStore {
  readonly #root: string;
  readonly #directory: string;

  constructor(root: string, directory = resolve(root, "channel-activity")) {
    this.#root = root;
    this.#directory = directory;
  }

  static forHome(home: string): ChannelActivityStore {
    return new ChannelActivityStore(resolveOpenTagHomeLayout(home).runtime);
  }

  /** Records the Turn's start and reports whether the time before it exceeded the idle threshold. */
  async beginTurn(sessionId: string, now: number): Promise<boolean> {
    const last = await readDurableJson(this.#path(sessionId), parseActivity).catch((error: unknown) => {
      logger.warn({ code: "channel_activity_read_failed", error: String(error) }, "Channel activity could not be read");
      return undefined;
    });
    await this.recordActivity(sessionId, now);
    return channelIdleExceeded(last, now);
  }

  async recordActivity(sessionId: string, now: number): Promise<void> {
    try {
      await ensurePrivateDirectory(this.#root, this.#directory);
      await writeDurableJson(this.#path(sessionId), { lastActivityAt: new Date(now).toISOString() });
    } catch (error) {
      logger.warn({ code: "channel_activity_write_failed", error: String(error) }, "Channel activity was not recorded");
    }
  }

  #path(sessionId: string): string {
    return resolve(this.#directory, `${deriveRuntimeKey("session", sessionId)}.json`);
  }
}

type ChannelActivity = Pick<ChannelActivityStore, "beginTurn" | "recordActivity">;

/** Prompt options for a Turn: compaction for a Channel Session's first Turn after its idle time. */
export async function beginChannelTurn(
  activity: ChannelActivity | undefined,
  turn: { readonly sessionId: string; readonly channel: boolean; readonly retry?: boolean },
  now: number,
): Promise<{ compactContext?: true }> {
  if (!activity || !turn.channel) return {};
  const idle = await activity.beginTurn(turn.sessionId, now);
  // A retry continues the Turn that already compacted or found the Session active.
  if (!idle || turn.retry) return {};
  logger.info({ sessionId: turn.sessionId }, "Channel Session idle; compacting its context before the Turn");
  return { compactContext: true };
}

export async function endChannelTurn(
  activity: ChannelActivity | undefined,
  turn: { readonly sessionId: string; readonly channel: boolean },
  now: number,
): Promise<void> {
  if (activity && turn.channel) await activity.recordActivity(turn.sessionId, now);
}
