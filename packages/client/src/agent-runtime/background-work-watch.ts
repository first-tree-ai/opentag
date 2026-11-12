import { stat } from "node:fs/promises";
import type { AgentBackgroundWorkItem, AgentRuntimeEvent } from "./types.js";

const MINUTE_MS = 60_000;
const CHECK_INTERVAL_MS = 30_000;

/**
 * How long a task must stay quiet before the next notice: 10, 30, 60, 120... minutes. Ten minutes is an
 * experience value (three times the longest polling interval seen in real background commands), to be
 * adjusted from real notices. It backs off because a task can be quiet for hours and still be healthy.
 */
function quietMsBeforeNotice(noticesSent: number): number {
  if (noticesSent === 0) return 10 * MINUTE_MS;
  if (noticesSent === 1) return 30 * MINUTE_MS;
  return 60 * (noticesSent - 1) * MINUTE_MS;
}

interface WatchedWork {
  label: string;
  outputPath?: string;
  /** What the output looked like last time; progress is any change. */
  outputMark?: string;
  readonly startedAt: number;
  lastProgressAt: number;
  noticesSent: number;
}

export interface BackgroundWorkWatchOptions {
  readonly notify: (text: string) => Promise<void>;
  readonly now?: () => number;
  /** Size and modification time of a file, as a comparable mark; undefined when it cannot be read. */
  readonly outputMark?: (path: string) => Promise<string | undefined>;
}

/**
 * Tells the Session when live background work has gone quiet. It only tells: no signal separates a hung task
 * from a healthy one in either direction (a long sleep is silent, an endless retry is not), so the model
 * decides and the Run's limit is the fallback. Nothing here stops anything or changes when a Run ends.
 *
 * It watches only work whose output it can see. A timer has none, and is not expected to make progress.
 */
export class BackgroundWorkWatch {
  readonly #notify: BackgroundWorkWatchOptions["notify"];
  readonly #now: () => number;
  readonly #outputMark: NonNullable<BackgroundWorkWatchOptions["outputMark"]>;
  readonly #work = new Map<string, WatchedWork>();
  #timer?: ReturnType<typeof setInterval>;

  constructor(options: BackgroundWorkWatchOptions) {
    this.#notify = options.notify;
    this.#now = options.now ?? Date.now;
    this.#outputMark = options.outputMark ?? readOutputMark;
  }

  observe(event: AgentRuntimeEvent): void {
    if (event.type !== "background_work_changed") return;
    const listed = new Set(event.items.map((item) => item.id));
    for (const id of this.#work.keys()) if (!listed.has(id)) this.#work.delete(id);
    for (const item of event.items) this.#track(item);
    if (this.#work.size > 0) this.#start();
    else this.stop();
  }

  /** The Provider saw output from this work, for one that reports output as events rather than a file. */
  progress(id: string): void {
    const work = this.#work.get(id);
    if (work) this.#recordProgress(work);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One check, public for the timer and for tests. */
  async check(): Promise<void> {
    const quiet: WatchedWork[] = [];
    for (const work of this.#work.values()) {
      await this.#readOutput(work);
      if (this.#now() - work.lastProgressAt < quietMsBeforeNotice(work.noticesSent)) continue;
      work.noticesSent += 1;
      quiet.push(work);
    }
    if (quiet.length > 0) await this.#notify(this.#notice(quiet));
  }

  #track(item: AgentBackgroundWorkItem): void {
    const known = this.#work.get(item.id);
    if (known) {
      known.label = item.label;
      if (item.outputPath) known.outputPath = item.outputPath;
      return;
    }
    if (!item.outputPath && !item.reportsProgress) return;
    const now = this.#now();
    this.#work.set(item.id, {
      label: item.label,
      ...(item.outputPath ? { outputPath: item.outputPath } : {}),
      startedAt: now,
      lastProgressAt: now,
      noticesSent: 0,
    });
  }

  #start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.check().catch(() => undefined), CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  async #readOutput(work: WatchedWork): Promise<void> {
    if (!work.outputPath) return;
    const mark = await this.#outputMark(work.outputPath);
    if (mark === undefined || mark === work.outputMark) return;
    const first = work.outputMark === undefined;
    work.outputMark = mark;
    if (!first) this.#recordProgress(work);
  }

  #recordProgress(work: WatchedWork): void {
    work.lastProgressAt = this.#now();
    work.noticesSent = 0;
  }

  #notice(quiet: readonly WatchedWork[]): string {
    const now = this.#now();
    const minutes = (ms: number) => Math.floor(ms / MINUTE_MS);
    return [
      "[openTag notice] This background work has produced no output for a while. It may be hung, or it may be waiting normally: openTag cannot tell.",
      ...quiet.map(
        (work) =>
          `- ${work.label} (running for ${minutes(now - work.startedAt)} min, no output for ${minutes(now - work.lastProgressAt)} min${work.outputPath ? `; output: ${work.outputPath}` : ""})`,
      ),
      "Check it if you can. If it is hung, stop it yourself; nothing stops it before this Run reaches its limit. If it is fine, keep waiting and end your turn.",
    ].join("\n");
  }
}

async function readOutputMark(path: string): Promise<string | undefined> {
  try {
    const { size, mtimeMs } = await stat(path);
    return `${size}:${mtimeMs}`;
  } catch {
    return undefined;
  }
}
