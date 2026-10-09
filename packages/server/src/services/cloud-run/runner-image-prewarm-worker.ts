import type { ChannelName } from "@opentag/shared";
import type { CloudRunnerConfig } from "../../cloud-runner-config.js";
import type { BackgroundFailureSupervisor } from "../../observability/background-failure-supervisor.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  createRunnerImagePrewarmCoordinator,
  type RunnerImagePrewarmLeadership,
} from "./runner-image-prewarm-coordinator.js";
import { RunnerImagePrewarmer } from "./runner-image-prewarmer.js";
import { createMetadataServerTokenProvider, createStaticTokenProvider } from "./token-provider.js";

export interface RunnerImagePrewarmWorkerOptions {
  prewarmer: Pick<RunnerImagePrewarmer, "prepare" | "resourceName" | "image">;
  acquire: () => Promise<RunnerImagePrewarmLeadership | undefined>;
  intervalMs: number;
  logger: Pick<ServiceLogger, "info" | "warn">;
  supervisor?: BackgroundFailureSupervisor;
}

/** Startup preparation and periodic retries, independent of readiness and business dispatch. */
export class RunnerImagePrewarmWorker {
  readonly #options: RunnerImagePrewarmWorkerOptions;
  #timer?: ReturnType<typeof setInterval>;
  #controller?: AbortController;
  #running?: Promise<void>;
  #leadership?: RunnerImagePrewarmLeadership;
  #prepared = false;

  constructor(options: RunnerImagePrewarmWorkerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    this.#controller = new AbortController();
    this.#timer = setInterval(() => this.check(), this.#options.intervalMs);
    this.#timer.unref();
    this.check();
  }

  check(): void {
    if (!this.#controller || this.#controller.signal.aborted || this.#running) return;
    const operation = this.#run(this.#controller.signal).finally(() => {
      this.#running = undefined;
    });
    this.#running = operation;
    this.#observe(operation);
  }

  #observe(operation: Promise<void>): void {
    if (this.#options.supervisor) {
      this.#options.supervisor.track(operation, {
        code: "RUNNER_IMAGE_PREWARM_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
        operation: "runner-image-prewarm.check",
      });
    } else {
      void operation.catch(() =>
        this.#options.logger.warn(
          { resourceName: this.#options.prewarmer.resourceName },
          "Runner image prewarm failed; retrying on next check",
        ),
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    await this.#running?.catch(() => undefined);
    const release = this.#release();
    this.#observe(release);
    await release.catch(() => undefined);
    this.#controller = undefined;
  }

  async #release(): Promise<void> {
    const leadership = this.#leadership;
    this.#leadership = undefined;
    this.#prepared = false;
    await leadership?.release();
  }

  async #run(signal: AbortSignal): Promise<void> {
    try {
      if (this.#leadership && !(await this.#leadership.isHeld())) await this.#release();
      this.#leadership ??= await this.#options.acquire();
      if (!this.#leadership || this.#prepared || signal.aborted) return;
      const prewarmer = this.#options.prewarmer;
      this.#options.logger.info(
        { image: prewarmer.image, resourceName: prewarmer.resourceName },
        "Starting Runner image prewarm",
      );
      const leadership = this.#leadership;
      const result = await prewarmer.prepare(signal, async () => {
        if (!(await leadership.isHeld())) throw new Error("Runner image prewarm leadership lost");
      });
      this.#prepared = true;
      this.#options.logger.info({ ...result }, "Runner image prewarm complete and probe deleted");
      // Keep leadership after success so other replicas do not repeat the same startup import.
    } catch (error) {
      try {
        await this.#release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Runner image prewarm failed to release leadership");
      }
      if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  }
}

/** The production entrypoint's factory performs no I/O until start(), after Server listen. */
export function createRunnerImagePrewarmWorker(input: {
  environment: ChannelName;
  config: CloudRunnerConfig;
  databaseUrl: string;
  logger: Pick<ServiceLogger, "info" | "warn">;
  supervisor?: BackgroundFailureSupervisor;
}): RunnerImagePrewarmWorker | undefined {
  const config = input.config;
  if (!config.enabled || !config.prewarm?.enabled) return undefined;
  const tokenProvider = config.staticAccessToken
    ? createStaticTokenProvider(config.staticAccessToken)
    : createMetadataServerTokenProvider();
  const prewarmer = new RunnerImagePrewarmer(input.environment, config, { tokenProvider });
  return new RunnerImagePrewarmWorker({
    prewarmer,
    acquire: createRunnerImagePrewarmCoordinator(input.databaseUrl, prewarmer.resourceName),
    intervalMs: config.prewarm.intervalMs,
    logger: input.logger,
    supervisor: input.supervisor,
  });
}
