import { CloudUsageSummarySchema, type CloudUsageWindowDays } from "@opentag/shared";
import { z } from "zod";
import { usageCalendarDates } from "./agents/agent-usage.js";
import type { CloudQueryConnection } from "./cloud-call-store.js";

const count = z.coerce.number().int().safe().nonnegative();
const TotalsSchema = z.object({
  requests: count,
  measuredRequests: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
});
const DaySchema = TotalsSchema.extend({ date: z.string() });
const measured = "input_tokens IS NOT NULL AND output_tokens IS NOT NULL";
export class CloudUsageService {
  constructor(readonly db: CloudQueryConnection) {}
  async read(account: string, windowDays: CloudUsageWindowDays, timezone = "UTC") {
    const value = await this.readDetail(account, windowDays, undefined, new Date(), timezone);
    return CloudUsageSummarySchema.parse({
      enabled: true,
      windowDays,
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      requests: value.requests,
      measuredRequests: value.measuredRequests,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      tokens: value.inputTokens + value.outputTokens,
      daily: value.points.map(({ date, tokens }) => ({ date, tokens })),
    });
  }
  async totalsByAgent(account: string, windowDays: number, now: Date): Promise<Map<string, number>> {
    const rows = z
      .array(z.object({ agentId: z.string(), tokens: count }))
      .parse(
        (
          await this.db.query(
            `SELECT agent_id AS "agentId",coalesce(sum(input_tokens+output_tokens) FILTER(WHERE ${measured}),0) AS tokens FROM billing.attempts WHERE account=$1 AND created_at>=$2 AND created_at<=$3 GROUP BY agent_id`,
            [account, new Date(now.getTime() - windowDays * 86_400_000).toISOString(), now.toISOString()],
          )
        ).rows,
      );
    return new Map(rows.map((row) => [row.agentId, row.tokens]));
  }
  async readDetail(
    account: string,
    windowDays: CloudUsageWindowDays,
    agentId?: string,
    now = new Date(),
    timezone = "UTC",
  ) {
    const startedDate = new Date(now.getTime() - windowDays * 86_400_000);
    const endedAt = now.toISOString(),
      startedAt = startedDate.toISOString();
    const filter = `account=$1 AND created_at>=$2 AND created_at<=$3${agentId ? " AND agent_id=$5" : ""}`;
    const args = agentId ? [account, startedAt, endedAt, timezone, agentId] : [account, startedAt, endedAt, timezone];
    const rows = z
      .array(DaySchema)
      .parse(
        (
          await this.db.query(
            `SELECT to_char(created_at AT TIME ZONE $4,'YYYY-MM-DD') AS date,count(*) AS requests,count(*) FILTER(WHERE ${measured}) AS "measuredRequests",coalesce(sum(input_tokens) FILTER(WHERE ${measured}),0) AS "inputTokens",coalesce(sum(output_tokens) FILTER(WHERE ${measured}),0) AS "outputTokens",coalesce(sum(cached_input_tokens) FILTER(WHERE ${measured}),0) AS "cachedInputTokens" FROM billing.attempts WHERE ${filter} GROUP BY date ORDER BY date`,
            args,
          )
        ).rows,
      );
    const totals = TotalsSchema.parse(
      rows.reduce(
        (total, row) => ({
          requests: total.requests + row.requests,
          measuredRequests: total.measuredRequests + row.measuredRequests,
          inputTokens: total.inputTokens + row.inputTokens,
          outputTokens: total.outputTokens + row.outputTokens,
          cachedInputTokens: total.cachedInputTokens + row.cachedInputTokens,
        }),
        { requests: 0, measuredRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      ),
    );
    const points = rows.map(({ date, inputTokens, outputTokens, cachedInputTokens }) => ({
      date,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      tokens: inputTokens + outputTokens,
    }));
    const byDate = new Map(points.map((point) => [point.date, point]));
    const daily: typeof points = [];
    for (const date of usageCalendarDates(startedDate, now, timezone)) {
      daily.push(byDate.get(date) ?? { date, tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    }
    return { startedAt, endedAt, ...totals, points: daily };
  }
}
