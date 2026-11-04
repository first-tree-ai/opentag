import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { getContainerRuntimeClient } from "testcontainers";
import { migrateDatabase } from "../../db/migrate.js";
import { acquireLocalTestDatabase } from "./local-test-database.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export interface MigratedTestDatabase {
  databaseUrl: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

// Stable-schema suites can preserve the migration ledger and clear only application data.
// Migration contract tests intentionally use their own empty-schema setup instead of this helper.
export async function startMigratedTestDatabase(
  options?: string | { disposable: true },
): Promise<MigratedTestDatabase> {
  const image = typeof options === "string" ? options : undefined;
  const local = !process.env.CI && !options && (await isLocalDocker());
  const fixture = local
    ? await acquireLocalTestDatabase()
    : await startPostgresTestContainer(image).then((container) => ({
        databaseUrl: container.getConnectionUri(),
        stop: async () => {
          await container.stop();
        },
      }));
  const { databaseUrl } = fixture;

  try {
    await migrateDatabase(databaseUrl, migrationsFolder);
  } catch (error) {
    await fixture.stop();
    throw error;
  }

  return {
    databaseUrl,
    reset: () => resetApplicationTables(databaseUrl),
    stop: () => fixture.stop(),
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

async function isLocalDocker(): Promise<boolean> {
  const { info } = await getContainerRuntimeClient();
  return ["localhost", "127.0.0.1", "::1"].includes(info.containerRuntime.host);
}
