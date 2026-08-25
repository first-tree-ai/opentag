import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { migrateDatabase } from "../../db/migrate.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export interface MigratedTestDatabase {
  databaseUrl: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

// Stable-schema suites can preserve the migration ledger and clear only application data.
// Migration contract tests intentionally use their own empty-schema setup instead of this helper.
export async function startMigratedTestDatabase(): Promise<MigratedTestDatabase> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const databaseUrl = container.getConnectionUri();

  try {
    await migrateDatabase(databaseUrl, migrationsFolder);
  } catch (error) {
    await container.stop();
    throw error;
  }

  return {
    databaseUrl,
    reset: () => resetApplicationTables(databaseUrl),
    stop: () => stopContainer(container),
  };
}

async function resetApplicationTables(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`
      do $$
      declare
        table_list text;
        sequence_record record;
      begin
        select string_agg(format('%I.%I', schemaname, tablename), ', ')
        into table_list
        from pg_tables
        where schemaname = 'public';

        if table_list is not null then
          execute 'truncate table ' || table_list || ' restart identity cascade';
        end if;

        for sequence_record in
          select schemaname, sequencename, start_value
          from pg_sequences
          where schemaname = 'public'
        loop
          execute format(
            'alter sequence %I.%I restart with %s',
            sequence_record.schemaname,
            sequence_record.sequencename,
            sequence_record.start_value
          );
        end loop;
      end
      $$;
    `);
  } finally {
    await sql.end();
  }
}

async function stopContainer(container: StartedPostgreSqlContainer): Promise<void> {
  await container.stop();
}
