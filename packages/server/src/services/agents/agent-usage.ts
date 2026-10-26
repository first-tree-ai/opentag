/**
 * Agent usage arithmetic and the bounded PostgreSQL read behind it.
 *
 * The 30-day Agent usage window is aggregated in the database into at most one row per UTC day, so the
 * response size never depends on history length. Two properties make that rewrite exact rather than
 * approximate, and both must survive later edits:
 *
 * - Turn reports hold token counts as JSON, and the Server's original contract parses every value with
 *   `Number()` and rejects anything that is not a non-negative safe integer. SQL cannot reproduce
 *   `Number()` for arbitrary text, so the aggregate covers only values written in the canonical decimal
 *   form of a safe integer; every other row is read back by `readAgentUsageDaily` and recomputed with
 *   the same per-row parser. Canonical rows are the entire production population, so the fallback stays
 *   bounded in practice while the arithmetic stays exact.
 * - Token totals are summed as `numeric` and converted to `number` only through
 *   `parseAggregateTokenTotal`, which rejects a total beyond the safe-integer range instead of losing
 *   precision.
 */
import { type AgentRuntimeProvider, type AgentUsageDetail, runtimeUsageTotalTokens } from "@opentag/shared";
import { type SQL, sql } from "drizzle-orm";

import type { DatabaseClient } from "../../db/client.js";

/** The largest value `Number.isSafeInteger` accepts, used as the SQL bound for a canonical count. */
const MAX_SAFE_INTEGER = 9007199254740991;

/**
 * How many reports one correction statement may return.
 *
 * The aggregate sums only values stored in canonical decimal form. A value that `Number()` still reads exactly —
 * `1000.00`, `1e3`, `" 12"` — has to be recomputed row by row, and a window can legitimately hold any number of
 * them, so the correction is a bounded keyset walk over them instead of one unbounded read: each statement takes
 * at most this many rows and the totals are folded as they arrive, so memory stays constant however many
 * reports need it. This is a page size, not a compatibility limit.
 */
export const AGENT_USAGE_EXCEPTION_BATCH_SIZE = 1000;

type QueryExecutor = Pick<DatabaseClient, "execute">;

type UsageDayAggregateRow = {
  day: string;
  tasks: string;
  failed: string;
  measuredTasks: string;
  approximatedTasks: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
};

interface UsageTokenCounts {
  cachedInputTokens: number;
  inputTokens: number;
  measured: boolean;
  outputTokens: number;
  tokens: number;
}

export interface AgentUsageDailyReadInput {
  agentId: string;
  provider: AgentRuntimeProvider;
  startedAt: Date;
  endedAt: Date;
}

export interface AgentUsageDailyRead {
  tasks: number;
  measuredTasks: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  tokens: number;
  daily: AgentUsageDetail["daily"];
}

/**
 * `true` when the stored text is a value the per-row `Number()` parser accepts without rounding.
 *
 * The cast sits inside a `CASE` whose condition already proved the text is decimal digits: SQL does not
 * promise to evaluate `a ~ '^[0-9]+$' and a::numeric > b` left to right, so a bare `AND` could reach the
 * cast with arbitrary text and raise `22P02` instead of classifying the row.
 */
function canonicalSql(column: string): SQL {
  return sql`(case when ${sql.raw(column)} ~ '^[0-9]+$' then ${sql.raw(column)}::numeric <= ${MAX_SAFE_INTEGER} when ${sql.raw(column)} is null then true else false end)`;
}

/**
 * The window's Deliveries with every JSON usage value extracted exactly once, plus the row-level verdict
 * the aggregate needs.
 *
 * The shape is measured, not stylistic. `materialized` stops PostgreSQL from inlining the CTE and
 * re-evaluating `#>>` once per reference. The second level exists because a `SELECT` cannot reference its
 * own output columns: `canonical` must be computed from the extracted text, not from the projection, and
 * computing it inside each aggregate instead made this query several times slower — every `FILTER` and
 * every `sum` re-ran three regex tests per row. The projected rows stay narrow, so both tuplestores stay
 * inside `work_mem`.
 */
function usageWindowSql(where: SQL, extraColumns: SQL = sql``): SQL {
  return sql`
    with usage_window as materialized (
      select
        ${extraColumns}
        d.accepted_at as accepted_at,
        d.turn_report ->> 'outcome' = 'failed' as failed,
        case when d.execution_origin = 'cloud' then null else d.turn_report #>> '{usage,inputTokens}' end as input_text,
        case when d.execution_origin = 'cloud' then null else d.turn_report #>> '{usage,cachedInputTokens}' end as cached_text,
        case when d.execution_origin = 'cloud' then null else d.turn_report #>> '{usage,outputTokens}' end as output_text
      from im_message_deliveries d
      inner join sessions s on s.id = d.session_id
      inner join im_bindings b on b.id = s.im_binding_id
      where ${where}
    ),
    flagged_window as materialized (
      select
        *,
        (${canonicalSql("input_text")} and ${canonicalSql("cached_text")} and ${canonicalSql("output_text")}) as canonical
      from usage_window
    )
  `;
}

/** Sums one extracted usage field over canonical rows only; the fallback reads the others in JavaScript. */
function canonicalSumSql(column: string): SQL {
  return sql`coalesce(sum(case when canonical then coalesce(${sql.raw(column)}::numeric, 0) else 0 end), 0)::text`;
}

/**
 * Per-row token arithmetic. The provider rule is the billing boundary: Codex already reports cached
 * tokens inside its input count, Claude Code and Pi do not, so only the latter add them again.
 */
export function deliveryUsageTokenCounts(
  provider: AgentRuntimeProvider,
  inputTokens: string | null,
  cachedInputTokens: string | null,
  outputTokens: string | null,
): UsageTokenCounts {
  const parse = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new Error("Agent usage contains an invalid token count");
    }
    return result;
  };
  const usage = {
    inputTokens: parse(inputTokens),
    cachedInputTokens: parse(cachedInputTokens),
    outputTokens: parse(outputTokens),
  };
  const normalizedInputTokens = (usage.inputTokens ?? 0) + (provider === "codex" ? 0 : (usage.cachedInputTokens ?? 0));
  return {
    inputTokens: normalizedInputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    tokens: runtimeUsageTotalTokens(provider, usage),
    measured: Object.values(usage).some((value) => value !== undefined),
  };
}

export function parseAggregateCount(value: string | number | null, field: string): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Agent usage ${field} total exceeds the safe integer range`);
  }
  return result;
}

export function parseAggregateTokenTotal(value: string | number | null): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Agent usage token total exceeds the safe integer range");
  }
  return result;
}

export function addUsageTokenCounts(
  target: Pick<AgentUsageDetail, "cachedInputTokens" | "inputTokens" | "outputTokens" | "tokens">,
  value: Pick<UsageTokenCounts, "cachedInputTokens" | "inputTokens" | "outputTokens" | "tokens">,
): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
  target.tokens += value.tokens;
  if (![target.inputTokens, target.cachedInputTokens, target.outputTokens, target.tokens].every(Number.isSafeInteger)) {
    throw new Error("Agent usage token total exceeds the safe integer range");
  }
}

/**
 * The zero-filled day bucket for one UTC date. Every date between the window start and end is present,
 * so a day without tasks reads as zero rather than disappearing from the series.
 */
function emptyUsageDay(date: string): AgentUsageDetail["daily"][number] {
  return { date, tasks: 0, measuredTasks: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokens: 0 };
}

/**
 * Recomputes the reports the aggregate could not sum, one bounded keyset page at a time.
 *
 * The aggregate counted these rows inside the same snapshot, so the walk stops exactly when the counts agree;
 * a mismatch is an internal inconsistency, not a data condition. Each page is folded into the per-day totals and
 * then dropped, so memory does not depend on how many reports need it.
 */
async function foldApproximatedReports(
  executor: QueryExecutor,
  input: AgentUsageDailyReadInput,
  window: SQL,
  daily: Map<string, AgentUsageDetail["daily"][number]>,
  result: AgentUsageDailyRead,
  approximatedTasks: number,
): Promise<void> {
  // Every report the aggregate excluded, in keyset order. The aggregate already counted them inside the same
  // snapshot, so the walk is bounded by that count: it stops exactly when the counts agree, and a mismatch is an
  // internal inconsistency rather than a data condition.
  let processed = 0;
  // The cursor is the exact UTC text PostgreSQL printed, not a JavaScript Date: a `timestamptz` carries
  // microseconds, a `Date` truncates to milliseconds, and a truncated cursor would repeat every row that shares
  // the current millisecond — double-counting it — or skip one. The text is bound back as `timestamptz`, so the
  // comparison is exact.
  let cursor: { acceptedAtText: string; deliveryId: string } | undefined;
  while (processed < approximatedTasks) {
    const remaining = approximatedTasks - processed;
    const batch = (await executor.execute(sql`
        ${usageWindowSql(window, sql`d.id as delivery_id,`)}
        select
          to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD') as "day",
          delivery_id as "deliveryId",
          to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "acceptedAtText",
          input_text as "inputTokens",
          cached_text as "cachedInputTokens",
          output_text as "outputTokens"
        from flagged_window
        where not canonical
          ${
            cursor
              ? sql`and (accepted_at, delivery_id) > (${cursor.acceptedAtText}::timestamptz, ${cursor.deliveryId}::uuid)`
              : sql``
          }
        order by accepted_at asc, delivery_id asc
        limit ${Math.min(AGENT_USAGE_EXCEPTION_BATCH_SIZE, remaining)}
      `)) as unknown as {
      day: string;
      deliveryId: string;
      acceptedAtText: string;
      inputTokens: string | null;
      cachedInputTokens: string | null;
      outputTokens: string | null;
    }[];
    if (batch.length === 0) {
      throw new Error("Agent usage reports need per-row parsing but the window returned none");
    }
    for (const row of batch) {
      const counts = deliveryUsageTokenCounts(input.provider, row.inputTokens, row.cachedInputTokens, row.outputTokens);
      const point = daily.get(row.day);
      if (!point) throw new Error("Agent usage date falls outside the requested window");
      if (counts.measured) {
        point.measuredTasks += 1;
        result.measuredTasks += 1;
      }
      addUsageTokenCounts(point, counts);
      addUsageTokenCounts(result, counts);
    }
    processed += batch.length;
    const last = batch.at(-1);
    if (!last) throw new Error("Agent usage reports need per-row parsing but the window returned none");
    cursor = { acceptedAtText: last.acceptedAtText, deliveryId: last.deliveryId };
  }
}

/**
 * Reads the window as UTC day buckets. Callers must pass one authorized, fixed read snapshot so the
 * aggregate and the fallback rows describe the same set of deliveries (see
 * `docs/system/database-read-write-standards.md`, RD1).
 */
export async function readAgentUsageDaily(
  executor: QueryExecutor,
  input: AgentUsageDailyReadInput,
): Promise<AgentUsageDailyRead> {
  const window = sql`b.agent_id = ${input.agentId}::uuid
    and d.accepted_at >= ${input.startedAt.toISOString()}::timestamptz
    and d.accepted_at <= ${input.endedAt.toISOString()}::timestamptz`;
  // Sequential on purpose: both statements must observe one snapshot on one connection, and the
  // fallback stays cheap because canonical rows are the entire production population.
  const dayRows = (await executor.execute(sql`
    ${usageWindowSql(window)}
    select
      to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD') as "day",
      count(*)::text as "tasks",
      count(*) filter (where failed)::text as "failed",
      count(*) filter (where canonical
        and (input_text is not null or cached_text is not null or output_text is not null))::text as "measuredTasks",
      count(*) filter (where not canonical)::text as "approximatedTasks",
      ${canonicalSumSql("input_text")} as "inputTokens",
      ${canonicalSumSql("cached_text")} as "cachedInputTokens",
      ${canonicalSumSql("output_text")} as "outputTokens"
    from flagged_window
    group by 1
  `)) as unknown as UsageDayAggregateRow[];
  // Rows the aggregate excluded. Their detection rides the aggregate itself, so the fallback query only
  // runs when there is something to correct; a window of ordinary JSON numbers never pays for it.
  const approximatedTasks = dayRows.reduce(
    (total, row) => total + parseAggregateCount(row.approximatedTasks, "approximated task"),
    0,
  );
  const result: AgentUsageDailyRead = {
    tasks: 0,
    measuredTasks: 0,
    failed: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    daily: [],
  };
  const daily = new Map<string, AgentUsageDetail["daily"][number]>();
  const firstDate = Date.UTC(
    input.startedAt.getUTCFullYear(),
    input.startedAt.getUTCMonth(),
    input.startedAt.getUTCDate(),
  );
  const lastDate = Date.UTC(input.endedAt.getUTCFullYear(), input.endedAt.getUTCMonth(), input.endedAt.getUTCDate());
  for (let timestamp = firstDate; timestamp <= lastDate; timestamp += 24 * 60 * 60 * 1_000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    daily.set(date, emptyUsageDay(date));
  }

  for (const row of dayRows) {
    const point = daily.get(row.day);
    if (!point) throw new Error("Agent usage date falls outside the requested window");
    const tasks = parseAggregateCount(row.tasks, "task");
    const failed = parseAggregateCount(row.failed, "failed");
    const measuredTasks = parseAggregateCount(row.measuredTasks, "measured task");
    const inputTokens = parseAggregateTokenTotal(row.inputTokens);
    const cachedInputTokens = parseAggregateTokenTotal(row.cachedInputTokens);
    const outputTokens = parseAggregateTokenTotal(row.outputTokens);
    // Summing canonical rows already applied the provider rule: cached tokens are a separate sum, and
    // only Codex excludes them from its input total.
    const normalizedInputTokens = inputTokens + (input.provider === "codex" ? 0 : cachedInputTokens);
    const tokens = normalizedInputTokens + outputTokens;
    if (!Number.isSafeInteger(tokens)) throw new Error("Agent usage token total exceeds the safe integer range");
    Object.assign(point, {
      tasks,
      measuredTasks,
      inputTokens: normalizedInputTokens,
      cachedInputTokens,
      outputTokens,
      tokens,
    });
    result.tasks += tasks;
    result.failed += failed;
    result.measuredTasks += measuredTasks;
    addUsageTokenCounts(result, { inputTokens: normalizedInputTokens, cachedInputTokens, outputTokens, tokens });
  }

  await foldApproximatedReports(executor, input, window, daily, result, approximatedTasks);

  result.daily = [...daily.values()];
  return result;
}

/** One Agent's 30-day totals, still as aggregate text the caller parses. */
export interface AgentUsageSummaryRow {
  agentId: string;
  failed: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  tasks: string;
  invalidTokenCount: boolean | null;
}

/**
 * The list's per-Agent totals over the window, in one statement.
 *
 * The list keeps its own validity rule: a value that is not the canonical decimal form of a number is
 * flagged here rather than parsed per row, so the list reports an unusable history instead of failing on
 * it. `getUsageById` deliberately differs, and both behaviors are part of the contract.
 */
export async function readAgentUsageSummaries(
  executor: QueryExecutor,
  input: { agentIds: readonly string[]; startedAt: Date; endedAt: Date },
): Promise<AgentUsageSummaryRow[]> {
  // `in ()` is not valid SQL, so an Account with no visible Agent must not reach the statement at all.
  if (input.agentIds.length === 0) return [];
  const agentIds = sql.join(
    input.agentIds.map((agentId) => sql`${agentId}::uuid`),
    sql`, `,
  );
  const window = sql`b.agent_id in (${agentIds})
    and d.accepted_at >= ${input.startedAt.toISOString()}::timestamptz
    and d.accepted_at <= ${input.endedAt.toISOString()}::timestamptz`;
  const invalidValueSql = (column: string): SQL =>
    sql`case when ${sql.raw(column)} is null then false
      when ${sql.raw(column)} ~ '^[0-9]+$' then ${sql.raw(column)}::numeric > ${MAX_SAFE_INTEGER}
      else true end`;
  return (await executor.execute(sql`
    ${usageWindowSql(window, sql`b.agent_id as agent_id,`)}
    select
      agent_id as "agentId",
      count(*)::text as "tasks",
      count(*) filter (where failed)::text as "failed",
      coalesce(sum(case when input_text ~ '^[0-9]+$' then input_text::numeric else 0 end), 0)::text as "inputTokens",
      coalesce(sum(case when cached_text ~ '^[0-9]+$' then cached_text::numeric else 0 end), 0)::text as "cachedInputTokens",
      coalesce(sum(case when output_text ~ '^[0-9]+$' then output_text::numeric else 0 end), 0)::text as "outputTokens",
      bool_or(${invalidValueSql("input_text")} or ${invalidValueSql("cached_text")} or ${invalidValueSql("output_text")})
        as "invalidTokenCount"
    from flagged_window
    group by agent_id
  `)) as unknown as AgentUsageSummaryRow[];
}
