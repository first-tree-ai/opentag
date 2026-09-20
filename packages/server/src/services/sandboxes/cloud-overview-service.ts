import type { AgentCloudOverview, AgentCloudOverviewQuery, CloudSessionSummary } from "@opentag/shared";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  runtimeDurableWork,
  sandboxes,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { sandboxNotFound } from "./errors.js";
import type { RunnerHub } from "./runner-hub.js";
import { countCloudCapacityOccupancy, occupiedSandbox } from "./sandbox-capacity.js";

// Phase markers are not failures. Never expose raw provider diagnostics to the browser.
const phaseMarkers = ["cloud_create_pending", "workspace_save_required", "workspace_discard_requested"];
const publicErrors = new Set([
  "cloud_create_uncertain",
  "cloud_create_rejected",
  "cloud_create_failed",
  "cloud_instance_unverified",
  "cloud_delete_incomplete",
  "workspace_save_failed",
  "workspace_restore_required",
]);

function publicDiagnostic(code: string | null): string | null {
  if (!code || phaseMarkers.includes(code)) return null;
  return publicErrors.has(code) ? code : "environment_unavailable";
}

function workState(active: boolean, queued: boolean, connected: boolean): CloudSessionSummary["taskState"] {
  if (active) return connected ? "running" : "unknown";
  return queued ? "queued" : "idle";
}

function currentConnection(
  hub: RunnerHub | undefined,
  row: {
    sandboxId: string;
    sessionId: string;
    generation: number;
    resourceName: string | null;
  },
) {
  const snapshot = hub?.describe(row.sandboxId);
  const current =
    snapshot?.scope?.environmentGeneration === row.generation &&
    snapshot?.scope?.resourceName === row.resourceName &&
    snapshot?.scope?.sessionId === row.sessionId;
  return { connected: current && snapshot?.connected === true, ready: current && snapshot?.ready === true };
}

export class CloudOverviewService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly options: { hub?: RunnerHub; accountLimit: number; controlsEnabled: boolean },
  ) {}

  async read(accountId: string, agentId: string, query: AgentCloudOverviewQuery): Promise<AgentCloudOverview> {
    // A single database snapshot prevents count/page disagreements caused by concurrent releases.
    return this.database.transaction(
      async (tx) => {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .innerJoin(computers, eq(computers.id, agents.computerId))
          .where(
            and(
              eq(agents.id, agentId),
              eq(agents.createdByUserId, accountId),
              eq(computers.ownerAccountId, accountId),
              eq(computers.kind, "cloud"),
            ),
          )
          .limit(1);
        if (!agent) throw sandboxNotFound();

        const queued = sql<boolean>`exists (select 1 from ${imMessageDeliveries}
        where ${imMessageDeliveries.sessionId} = ${sessions.id}
          and ${imMessageDeliveries.state} = 'pending' and ${imMessageDeliveries.reason} is null)`;
        const active = sql<boolean>`(
        exists (select 1 from ${imMessageDeliveries}
          where ${imMessageDeliveries.sessionId} = ${sessions.id}
            and ${imMessageDeliveries.state} = 'accepted' and ${imMessageDeliveries.reportedAt} is null)
        or exists (select 1 from ${runtimeDurableWork}
          where ${runtimeDurableWork.computerId} = ${computers.id}
            and ${runtimeDurableWork.kind} = 'session-message'
            and ${runtimeDurableWork.recordKey} like (${sessions.id}::text || ':%')
            and ${runtimeDurableWork.payload}->>'type' = 'cloud-session-message-work'
            and ${runtimeDurableWork.status} in ('accepted', 'running', 'retryable'))
      )`;
        const failed = sql<boolean>`(${sandboxes.lastErrorCode} is not null
        and ${sandboxes.lastErrorCode} not in (${sql.join(
          phaseMarkers.map((x) => sql`${x}`),
          sql`, `,
        )}))`;
        const owned = and(
          eq(agents.id, agentId),
          eq(agents.createdByUserId, accountId),
          eq(computers.ownerAccountId, accountId),
          eq(computers.kind, "cloud"),
          eq(sessionPlacements.computerId, computers.id),
        );
        const scope = tx
          .select({
            sessionId: sql<string>`${sessions.id}`.as("session_id"),
            kind: sessions.kind,
            sandboxId: sql<string | null>`${sandboxes.id}`.as("sandbox_id"),
            lifecycle: sandboxes.lifecycle,
            generation: sandboxes.environmentGeneration,
            resourceName: sandboxes.currentResourceName,
            occupied: occupiedSandbox.as("occupied"),
            idleReclaimAt: sandboxes.idleReclaimAt,
            errorCode: sandboxes.lastErrorCode,
            errorAt: sandboxes.lastErrorAt,
            updatedAt: sandboxes.updatedAt,
            queued: queued.as("queued"),
            active: active.as("active"),
            failed: failed.as("failed"),
          })
          .from(sessions)
          .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
          .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
          .innerJoin(agents, eq(agents.id, imBindings.agentId))
          .innerJoin(computers, eq(computers.id, agents.computerId))
          .leftJoin(sandboxes, eq(sandboxes.sessionId, sessions.id))
          .where(owned)
          .as("cloud_scope");

        const [counts] = await tx
          .select({
            allocated: sql<number>`count(*) filter (where ${scope.occupied})`.mapWith(Number),
            queued: sql<number>`count(*) filter (where ${scope.queued})`.mapWith(Number),
            running: sql<number>`count(*) filter (where ${scope.active})`.mapWith(Number),
            attention: sql<number>`count(*) filter (where ${scope.failed})`.mapWith(Number),
          })
          .from(scope);
        const { accountUsed } = await countCloudCapacityOccupancy(tx, accountId);
        const rows = await tx
          .select()
          .from(scope)
          .where(
            and(
              isNotNull(scope.sandboxId),
              query.cursor ? gt(scope.sessionId, query.cursor) : undefined,
              query.sessionId ? eq(scope.sessionId, query.sessionId) : undefined,
            ),
          )
          .orderBy(asc(scope.sessionId))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        return {
          agentId,
          observedAt: new Date().toISOString(),
          capacity: { accountUsed, accountLimit: this.options.accountLimit },
          counts: counts ?? { allocated: 0, queued: 0, running: 0, attention: 0 },
          sessions: page.map((row): CloudSessionSummary => {
            if (!row.sandboxId || !row.lifecycle || row.generation === null || !row.updatedAt) {
              throw new Error("Cloud overview returned an incomplete Sandbox");
            }
            const connection = currentConnection(this.options.hub, {
              sandboxId: row.sandboxId,
              sessionId: row.sessionId,
              generation: row.generation,
              resourceName: row.resourceName,
            });
            const errorCode = publicDiagnostic(row.errorCode);
            return {
              sessionId: row.sessionId,
              sandboxId: row.sandboxId,
              kind: row.kind,
              lifecycle: row.lifecycle,
              environmentGeneration: row.generation,
              runnerConnected: connection.connected,
              runnerReady: connection.ready && row.lifecycle === "ready" && row.idleReclaimAt === null,
              taskState: workState(row.active, row.queued, connection.connected),
              lastErrorCode: errorCode,
              lastErrorAt: errorCode ? (row.errorAt?.toISOString() ?? null) : null,
              updatedAt: row.updatedAt.toISOString(),
              canRelease: this.options.controlsEnabled && row.resourceName !== null,
              canDiscard:
                this.options.controlsEnabled &&
                row.resourceName !== null &&
                row.lifecycle === "releasing" &&
                row.errorCode === "workspace_save_failed",
            };
          }),
          nextCursor: rows.length > query.limit ? (page.at(-1)?.sessionId ?? null) : null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
