import type { ChannelName, RuntimeChannelTarget } from "@opentag/shared";
import { RuntimeChannelTargetSchema } from "@opentag/shared";
import { z } from "zod";

/**
 * Tracks the exact channel latest target the Server advertises to connected Clients.
 *
 * The authority is the channel's published portable `latest.json` pointer — the same coordinate the
 * portable installer consumes, and one the release pipeline keeps identical to the npm dist-tag, so
 * portable and npm-global Clients follow one exact target per channel. A failing poll never clears
 * the last known target: Clients keep upgrading toward the last good coordinate instead of seeing
 * the advertisement flap during a transient outage.
 *
 * The dev channel has no published artifacts, so its poller is an explicit no-op that never
 * advertises anything.
 */
export interface ChannelTargetPoller {
  /** Current cached target, when one has been observed. Cheap; safe on the heartbeat path. */
  get(): RuntimeChannelTarget | undefined;
  /** Begin periodic refreshes. Fires an immediate refresh in the background. */
  start(): void;
  /** Stop the timer and ignore in-flight responses. Idempotent. */
  stop(): void;
  /** Force a refresh now. Exposed for tests; production code calls `start()`. */
  refresh(): Promise<void>;
}

export interface ChannelTargetPollerOptions {
  channel: ChannelName;
  downloadBaseUrl: string;
  intervalMs: number;
  /** Override for tests. Returning `null` models an unreachable endpoint without tripping catch-alls. */
  fetchImpl?: typeof fetch;
  logger?: {
    info(bindings: Record<string, unknown>, message: string): void;
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

const ChannelPointerSchema = z
  .object({
    channel: z.string(),
    version: z.string(),
  })
  .passthrough();

const noopLogger = { info: () => undefined, warn: () => undefined };

export function createChannelTargetPoller(options: ChannelTargetPollerOptions): ChannelTargetPoller {
  const logger = options.logger ?? noopLogger;
  let current: RuntimeChannelTarget | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let stopped = false;

  if (options.channel === "dev") {
    return {
      get: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      refresh: async () => undefined,
    };
  }
  const channel = options.channel;
  const pointerUrl = `${options.downloadBaseUrl.replace(/\/+$/, "")}/${channel}/latest.json`;

  async function fetchOnce(): Promise<RuntimeChannelTarget | undefined> {
    const fetchFn = options.fetchImpl ?? fetch;
    let body: unknown;
    try {
      const response = await fetchFn(pointerUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, url: pointerUrl }, "Channel target poll returned a non-OK status");
        return undefined;
      }
      body = await response.json();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), url: pointerUrl },
        "Channel target poll failed",
      );
      return undefined;
    }
    const pointer = ChannelPointerSchema.safeParse(body);
    if (!pointer.success) {
      logger.warn({ url: pointerUrl }, "Channel target poll returned malformed metadata");
      return undefined;
    }
    const target = RuntimeChannelTargetSchema.safeParse({
      channel: pointer.data.channel,
      version: pointer.data.version,
    });
    if (!target.success) {
      logger.warn({ url: pointerUrl }, "Channel target poll returned an invalid channel or version");
      return undefined;
    }
    if (target.data.channel !== channel) {
      // A pointer for another channel can never select a target for this one.
      logger.warn(
        { advertisedChannel: target.data.channel, channel, url: pointerUrl },
        "Channel target poll returned a pointer for another channel",
      );
      return undefined;
    }
    return target.data;
  }

  async function runRefresh(): Promise<void> {
    const next = await fetchOnce();
    if (stopped || !next) return;
    if (current?.version !== next.version) {
      logger.info({ from: current?.version, to: next.version, channel }, "Advertised channel target changed");
      current = next;
    }
  }

  function refresh(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    const pending = runRefresh().finally(() => {
      if (refreshInFlight === pending) refreshInFlight = undefined;
    });
    refreshInFlight = pending;
    return pending;
  }

  return {
    get: () => current,
    start: () => {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), options.intervalMs);
      timer.unref();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    refresh,
  };
}
