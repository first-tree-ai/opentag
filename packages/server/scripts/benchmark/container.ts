/**
 * The process half of the Task query benchmark: one disposable PostgreSQL container on a random
 * loopback port, migrated and seeded with the tracked fixture, then removed.
 *
 * The commands and the clock are injected so this module is covered by unit tests without Docker,
 * and so nothing here can silently reach the environment: it never reads `DATABASE_URL` or a `.env`
 * file, and the port is whatever the container published.
 */

/** Run the docker CLI and return its trimmed stdout. */
export type DockerPort = (args: string[]) => string;

export interface BenchmarkContainer {
  /** Connection string for the container's own database. */
  url: string;
  /** Facts about the run for the evidence file. */
  environment: Record<string, unknown>;
  /** Removes the container and its volume; safe to call once the clients are closed. */
  stop(): void;
}

export interface StartContainerOptions {
  docker: DockerPort;
  /** Container name prefix; the process id keeps concurrent runs apart. */
  name: string;
  /** Label key/value that proves the container is this benchmark's own. */
  labelKey: string;
  labelValue: string;
  image?: string;
  database?: string;
  password?: string;
  /** Attempts to open the database, each after one second, before the run gives up. */
  readyAttempts?: number;
  sleep?(milliseconds: number): Promise<void>;
  /** Prints a line of progress; the seed phase uses it as well. */
  log(line: string): void;
}

const DEFAULT_IMAGE = "postgres:17-alpine";
const DEFAULT_DATABASE = "opentag_benchmark";
/** Local-only credential: the container listens on a loopback port that exists for this run alone. */
const DEFAULT_PASSWORD = "benchmark-local-only";

/**
 * Start the container, prove it is ours by its label, and report the loopback binding.
 *
 * Two failure rules make this safe to run beside another lane's container:
 *
 * - A failed `docker run` removes nothing. The name may already belong to a container this run did not
 *   create, so a cleanup here would delete somebody else's database.
 * - Once `docker run` succeeds, the container is ours, and every later read — label, port, image,
 *   resources, progress line — is guarded: if any of them throws, the container is removed before the
 *   failure is rethrown. A partial start would otherwise occupy the port and the name until someone
 *   noticed it by hand.
 *
 * When the start fails *and* the cleanup fails, both failures are reported: the start error is the
 * reason the caller sees, and the cleanup error is attached as the aggregate's second member, because
 * dropping either one hides a leak or the reason for it.
 */
export function startBenchmarkContainer(options: StartContainerOptions): BenchmarkContainer {
  const { docker } = options;
  const image = options.image ?? DEFAULT_IMAGE;
  const database = options.database ?? DEFAULT_DATABASE;
  const password = options.password ?? DEFAULT_PASSWORD;
  const remove = () => docker(["rm", "--force", "--volumes", options.name]);
  // Only after this returns is the container provably ours to remove.
  docker([
    "run",
    "--detach",
    "--name",
    options.name,
    "--label",
    `${options.labelKey}=${options.labelValue}`,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${database}`,
    image,
  ]);
  try {
    const label = docker(["inspect", "--format", `{{index .Config.Labels "${options.labelKey}"}}`, options.name]);
    if (label !== options.labelValue) throw new Error(`The container is not this benchmark's own: label ${label}`);
    const binding = docker(["port", options.name, "5432/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error(`The container is not on a loopback port: ${binding}`);
    const environment = {
      dockerImage: docker(["inspect", "--format", "{{.Image}}", options.name]),
      dockerResources: JSON.parse(docker(["info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'])),
    };
    options.log(JSON.stringify({ phase: "container", state: "started", binding }));
    return {
      url: `postgres://postgres:${password}@${binding}/${database}`,
      environment,
      stop: remove,
    };
  } catch (error) {
    throw withCleanupFailure(error, remove);
  }
}

/**
 * Rethrow `primary` unchanged when the container is gone, or as an `AggregateError` whose first member
 * is that same error when the cleanup also failed. The caller must never see a cleanup error in place
 * of the failure that caused it.
 */
export function withCleanupFailure(primary: unknown, cleanup: () => void): unknown {
  try {
    cleanup();
  } catch (cleanupError) {
    return new AggregateError([primary, cleanupError], "The benchmark failed and its container was not removed");
  }
  return primary;
}

/** Wait until the container accepts a query, without assuming how long its first start takes. */
export async function waitForDatabase(
  probe: () => Promise<unknown>,
  options: { attempts?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = options.attempts ?? 60;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await probe();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1_000);
    }
  }
}
