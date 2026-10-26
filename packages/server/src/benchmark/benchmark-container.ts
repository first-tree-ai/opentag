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
 * The label check is not ceremony: a container started by another run or another lane carries a
 * different value, so a name collision fails here instead of migrating and seeding somebody else's
 * database.
 */
export function startBenchmarkContainer(options: StartContainerOptions): BenchmarkContainer {
  const { docker } = options;
  const image = options.image ?? DEFAULT_IMAGE;
  const database = options.database ?? DEFAULT_DATABASE;
  const password = options.password ?? DEFAULT_PASSWORD;
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
  const label = docker(["inspect", "--format", `{{index .Config.Labels "${options.labelKey}"}}`, options.name]);
  if (label !== options.labelValue) throw new Error(`The container is not this benchmark's own: label ${label}`);
  const binding = docker(["port", options.name, "5432/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error(`The container is not on a loopback port: ${binding}`);
  options.log(JSON.stringify({ phase: "container", state: "started", binding }));
  return {
    url: `postgres://postgres:${password}@${binding}/${database}`,
    environment: {
      dockerImage: docker(["inspect", "--format", "{{.Image}}", options.name]),
      dockerResources: JSON.parse(docker(["info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'])),
    },
    stop() {
      docker(["rm", "--force", "--volumes", options.name]);
    },
  };
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
