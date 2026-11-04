import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import postgres from "postgres";

const run = promisify(execFile);
const containerName = "opentag-local-postgres";
const ownershipLabel = "opentag.test.postgres=shared-local";
const databaseUrl = "postgresql://opentag:opentag@127.0.0.1:5432/opentag";

interface ContainerState {
  Config: { Labels?: Record<string, string>; Env?: string[] };
  HostConfig?: { PortBindings?: Record<string, { HostPort: string }[]> };
  State: { Running: boolean };
}

async function inspectContainer(name = containerName): Promise<ContainerState | undefined> {
  try {
    const { stdout } = await run("docker", ["inspect", name]);
    return JSON.parse(stdout)[0];
  } catch (error) {
    if (/no such (object|container)/i.test((error as { stderr?: string }).stderr ?? "")) return undefined;
    throw error;
  }
}

async function ensureContainer(): Promise<void> {
  let name = containerName;
  let container = await inspectContainer();
  if (!container) {
    const compose = await inspectContainer("opentag-postgres-1");
    if (
      compose?.Config.Labels?.["com.docker.compose.service"] === "postgres" &&
      compose.Config.Env?.includes("POSTGRES_DB=opentag") &&
      compose.Config.Env.includes("POSTGRES_USER=opentag") &&
      compose.HostConfig?.PortBindings?.["5432/tcp"]?.some((binding) => binding.HostPort === "5432")
    ) {
      name = "opentag-postgres-1";
      container = compose;
    }
  }
  if (!container) {
    try {
      await run("docker", [
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        ownershipLabel,
        "--restart",
        "unless-stopped",
        "--publish",
        "127.0.0.1:5432:5432",
        "--env",
        "POSTGRES_USER=opentag",
        "--env",
        "POSTGRES_PASSWORD=opentag",
        "--env",
        "POSTGRES_DB=opentag",
        "--volume",
        "opentag-local-postgres-data:/var/lib/postgresql/data",
        "postgres:17-alpine",
      ]);
    } catch (error) {
      // Docker's unique name arbitrates simultaneous starts from different worktrees.
      if (!(error as { stderr?: string }).stderr?.includes("already in use")) throw error;
    }
    container = await inspectContainer();
  }
  if (!container || (name === containerName && container.Config.Labels?.["opentag.test.postgres"] !== "shared-local")) {
    throw new Error(`${containerName} is not an OpenTag shared test database`);
  }
  if (!container.State.Running) await run("docker", ["start", name]);
  await waitForPostgres(name);
}

async function waitForPostgres(name: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await run("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "opentag", "-d", "opentag"]);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await setTimeout(250);
    }
  }
}

export async function acquireLocalTestDatabase(): Promise<{ databaseUrl: string; stop(): Promise<void> }> {
  await ensureContainer();
  const connection = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 0,
    onnotice: () => undefined,
    connection: { application_name: "opentag-local-test-lease" },
  });
  try {
    // Keep this connection open for the complete suite. PostgreSQL releases the lock after a killed worker too.
    await connection`select pg_advisory_lock(1869898087, 1)`;
  } catch (error) {
    await connection.end({ timeout: 1 });
    throw error;
  }
  return {
    databaseUrl,
    stop: () => connection.end({ timeout: 1 }),
  };
}
