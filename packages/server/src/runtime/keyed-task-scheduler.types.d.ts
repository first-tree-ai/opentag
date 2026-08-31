export interface KeyedTaskSchedulerOptions {
  maxConcurrent: number;
  maxQueuedPerKey: number;
  maxQueuedTotal: number;
  now?: () => number;
}

export interface TaskLane {
  queue: Array<{ run: () => Promise<void>; onDrop?: () => void; enqueuedAt: number }>;
  running: boolean;
}
