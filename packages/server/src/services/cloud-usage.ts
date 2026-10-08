import { CloudUsageSummarySchema, type CloudUsageWindowDays } from "@opentag/shared";
import { z } from "zod";
import type { CloudQueryConnection } from "./cloud-call-store.js";

const count = z.coerce.number().int().safe().nonnegative();
const TotalsSchema = z.object({
  requests: count,
  measuredRequests: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
});
const DaySchema = z.object({
  date: z.string(),
  tokens: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
});
const measured = "usage_complete AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL";
export class CloudUsageService {
  constructor(readonly db: CloudQueryConnection) {}
  async read(account: string, windowDays: CloudUsageWindowDays) {
    const value = await this.readDetail(account, windowDays);
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
  async readDetail(account: string, windowDays: CloudUsageWindowDays, agentId?: string, now = new Date()) {
    const endedAt = now.toISOString(),
      startedAt = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const filter = `account=$1 AND created_at>=$2 AND created_at<=$3${agentId ? " AND agent_id=$4" : ""}`;
    const args = agentId ? [account, startedAt, endedAt, agentId] : [account, startedAt, endedAt];
    const totals = TotalsSchema.parse(
      (
        await this.db.query(
          `SELECT count(*) AS requests,count(*) FILTER(WHERE ${measured}) AS "measuredRequests",coalesce(sum(input_tokens) FILTER(WHERE ${measured}),0) AS "inputTokens",coalesce(sum(output_tokens) FILTER(WHERE ${measured}),0) AS "outputTokens",coalesce(sum(cached_input_tokens) FILTER(WHERE ${measured}),0) AS "cachedInputTokens" FROM billing.attempts WHERE ${filter}`,
          args,
        )
      ).rows[0],
    );
    const points = z
      .array(DaySchema)
      .parse(
        (
          await this.db.query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,coalesce(sum(input_tokens+output_tokens) FILTER(WHERE ${measured}),0) AS tokens,coalesce(sum(input_tokens) FILTER(WHERE ${measured}),0) AS "inputTokens",coalesce(sum(output_tokens) FILTER(WHERE ${measured}),0) AS "outputTokens",coalesce(sum(cached_input_tokens) FILTER(WHERE ${measured}),0) AS "cachedInputTokens" FROM billing.attempts WHERE ${filter} GROUP BY date ORDER BY date`,
            args,
          )
        ).rows,
      );
    const byDate = new Map(points.map((point) => [point.date, point]));
    const daily: Array<z.infer<typeof DaySchema>> = [];
    for (let day = Date.parse(`${startedAt.slice(0, 10)}T00:00:00.000Z`); day <= now.getTime(); day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      daily.push(byDate.get(date) ?? { date, tokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    }
    return { startedAt, endedAt, ...totals, points: daily };
  }
}
