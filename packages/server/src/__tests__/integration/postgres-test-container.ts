import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { getContainerRuntimeClient } from "testcontainers";

class IntegrationPostgreSqlContainer extends PostgreSqlContainer {
  protected override async beforeContainerCreated(): Promise<void> {
    const { info } = await getContainerRuntimeClient();
    const host = info.containerRuntime.host;
    if (host !== "localhost" && host !== "127.0.0.1") return;

    // Local tests only need loopback. Wildcard publishing can accept a TCP connection
    // without forwarding PostgreSQL traffic on Docker Desktop; remote daemons keep their defaults.
    this.hostConfig.PortBindings = { "5432/tcp": [{ HostPort: "0", HostIp: "127.0.0.1" }] };
  }
}

export async function startPostgresTestContainer(): Promise<StartedPostgreSqlContainer> {
  const container = await new IntegrationPostgreSqlContainer("postgres:17-alpine")
    .withLabels({ "opentag.test.postgres": "integration" })
    .start();

  try {
    const sql = postgres(container.getConnectionUri(), { connect_timeout: 5, max: 1, onnotice: () => undefined });
    try {
      // Container health and an open host port do not prove the host can query PostgreSQL.
      await sql`select 1`;
    } finally {
      await sql.end({ timeout: 1 });
    }
    return container;
  } catch (error) {
    const message = `Integration PostgreSQL is not reachable at ${container.getHost()}:${container.getPort()}; check Docker port forwarding`;
    try {
      await container.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${message}; container cleanup also failed`);
    }
    throw new Error(message, { cause: error });
  }
}
