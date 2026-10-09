import postgres from "postgres";

async function boundedQuery<T>(query: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Runner image prewarm coordination deadline exceeded")), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunnerImagePrewarmLeadership {
  isHeld(): Promise<boolean>;
  release(): Promise<void>;
}

/** One dedicated connection for the leader, with no transaction, table or external scheduler. */
export function createRunnerImagePrewarmCoordinator(databaseUrl: string, key: string) {
  return async (): Promise<RunnerImagePrewarmLeadership | undefined> => {
    const sql = postgres(databaseUrl, {
      max: 1,
      max_lifetime: null,
      idle_timeout: 0,
      connect_timeout: 5,
      connection: { statement_timeout: 5_000 },
      onnotice: () => undefined,
    });
    try {
      const [row] = await boundedQuery(sql<{ acquired: boolean }[]>`
        select pg_try_advisory_lock(hashtextextended(${`runner-image-prewarm:${key}`}, 0)) as acquired
      `);
      if (!row?.acquired) {
        await sql.end({ timeout: 1 });
        return undefined;
      }
      return {
        // A silently reconnected session has lost its lock. Never retain its prepared marker.
        async isHeld() {
          try {
            const [held] = await boundedQuery(sql<{ held: boolean }[]>`
              select exists(select 1 from pg_locks
                where locktype = 'advisory' and pid = pg_backend_pid() and granted) as held
            `);
            return held?.held === true;
          } catch {
            // A failed query cannot establish ownership; the worker closes this session and reacquires.
            return false;
          }
        },
        // Closing the dedicated session releases the lock even if an unlock query would fail.
        release: () => sql.end({ timeout: 1 }),
      };
    } catch {
      await sql.end({ timeout: 1 });
      throw new Error("Runner image prewarm coordination unavailable");
    }
  };
}
