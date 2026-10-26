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
import { and, asc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, sessions } from "../../db/schema/index.js";

/** The largest value `Number.isSafeInteger` accepts, used as the SQL bound for a canonical count. */
const MAX_SAFE_INTEGER = 9007199254740991;

type UsageField = "inputTokens" | "cachedInputTokens" | "outputTokens";
type QueryExecutor = Pick<DatabaseClient, "select">;

type UsageDayAggregateRow = {
  day: string;
  tasks: string;
  failed: string;
  measuredTasks: string;
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

function usageText(field: UsageField): SQL<string | null> {
  // Cloud reports are the billing ledger's evidence, not the local token breakdown, so they never reach
  // the token arithmetic. Reading them as absent keeps that rule inside the aggregate instead of the
  // row loop, and a malformed Cloud report can never fail the read.
  return sql<
    string | null
  >`case when ${imMessageDeliveries.executionOrigin} = 'cloud' then null else ${imMessageDeliveries.turnReport} #>> ${sql.raw(`'{usage,${field}}'`)} end`;
}

/**
 * `true` when the stored text is what the per-row `Number()` parser accepts without rounding: SQL NULL,
 * or the canonical decimal form of a value the parser proves safe. A JSON number's text is always
 * canonical, so this predicate is only false for a hand-written or pathological report.
 */
function canonicalUsageValue(field: UsageField): SQL<boolean> {
  const text = usageText(field);
  return sql<boolean>`(${text} is null or (${text} ~ '^[0-9]+$' and (${text})::numeric <= ${MAX_SAFE_INTEGER}))`;
}

const canonicalUsageRow = sql<boolean>`(${canonicalUsageValue("inputTokens")} and ${canonicalUsageValue(
  "cachedInputTokens",
)} and ${canonicalUsageValue("outputTokens")})`;

/**
 * Sums one usage field over canonical rows only. A row with any non-canonical field is excluded here and
 * recomputed in JavaScript, so no row is counted twice.
 */
function canonicalUsageSum(field: UsageField): SQL<string> {
  const text = usageText(field);
  return sql<string>`coalesce(sum(case when ${canonicalUsageRow} and ${text} is not null then (${text})::numeric else 0 end), 0)::text`;
}

function usageDay(): SQL<string> {
  return sql<string>`to_char(${imMessageDeliveries.acceptedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
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
 * Reads the window as UTC day buckets. Callers must pass one authorized, fixed read snapshot so the
 * aggregate and the fallback rows describe the same set of deliveries (see
 * `docs/system/database-read-write-standards.md`, RD1).
 */
export async function readAgentUsageDaily(
  executor: QueryExecutor,
  input: AgentUsageDailyReadInput,
): Promise<AgentUsageDailyRead> {
  const window = and(
    eq(imBindings.agentId, input.agentId),
    gte(imMessageDeliveries.acceptedAt, input.startedAt),
    lte(imMessageDeliveries.acceptedAt, input.endedAt),
  );
  // Sequential on purpose: both statements must observe one snapshot on one connection, and the
  // fallback stays cheap because canonical rows are the entire production population.
  const dayRows = (await executor
    .select({
      day: usageDay(),
      tasks: sql<string>`count(*)::text`,
      failed: sql<string>`count(*) filter (where ${imMessageDeliveries.turnReport} ->> 'outcome' = 'failed')::text`,
      measuredTasks: sql<string>`count(*) filter (where ${canonicalUsageRow}
        and (${usageText("inputTokens")} is not null
          or ${usageText("cachedInputTokens")} is not null
          or ${usageText("outputTokens")} is not null))::text`,
      inputTokens: canonicalUsageSum("inputTokens"),
      cachedInputTokens: canonicalUsageSum("cachedInputTokens"),
      outputTokens: canonicalUsageSum("outputTokens"),
    })
    .from(imMessageDeliveries)
    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .where(window)
    .groupBy(usageDay())) as UsageDayAggregateRow[];
  const abnormalRows = await executor
    .select({
      acceptedAt: imMessageDeliveries.acceptedAt,
      inputTokens: usageText("inputTokens"),
      cachedInputTokens: usageText("cachedInputTokens"),
      outputTokens: usageText("outputTokens"),
    })
    .from(imMessageDeliveries)
    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .where(and(window, sql`not ${canonicalUsageRow}`))
    .orderBy(asc(imMessageDeliveries.acceptedAt), asc(imMessageDeliveries.id));

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

  for (const row of abnormalRows) {
    if (!row.acceptedAt) continue;
    const counts = deliveryUsageTokenCounts(input.provider, row.inputTokens, row.cachedInputTokens, row.outputTokens);
    const point = daily.get(row.acceptedAt.toISOString().slice(0, 10));
    if (!point) throw new Error("Agent usage date falls outside the requested window");
    if (counts.measured) {
      point.measuredTasks += 1;
      result.measuredTasks += 1;
    }
    addUsageTokenCounts(point, counts);
    addUsageTokenCounts(result, counts);
  }

  result.daily = [...daily.values()];
  return result;
}
