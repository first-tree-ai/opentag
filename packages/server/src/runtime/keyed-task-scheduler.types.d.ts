import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";

export interface KeyedTaskSchedulerOptions {
  maxConcurrent: number;
  maxQueuedPerKey: number;
  maxQueuedTotal: number;
  now?: () => number;
  supervisor?: BackgroundFailureSupervisor;
}

export interface TaskLane {
  queue: Array<{ run: () => Promise<void>; onDrop?: () => void; enqueuedAt: number }>;
  running: boolean;
}
