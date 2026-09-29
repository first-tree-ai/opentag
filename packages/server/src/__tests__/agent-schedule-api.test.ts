/**
 * HTTP contract for the Agent Schedule management routes. The ScheduleService is stubbed: what is
 * under test here is the wire behavior — Session proof authentication happens BEFORE any request
 * body is interpreted (P01), strict schemas reject caller-supplied target/source/anchor fields
 * (P03), the Account surface exposes exactly list/show/pause/resume/delete (M10), and service
 * failures surface as the documented envelopes.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentSchedule,
  type AgentScheduleListResponse,
  type AgentSchedulePreview,
  agentSchedulePath,
  agentSchedulePausePath,
  agentScheduleResumePath,
  agentSchedulesPath,
  RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
  RUNTIME_AGENT_SCHEDULES_PATH,
  runtimeAgentSchedulePath,
  runtimeAgentSchedulePausePath,
  runtimeAgentScheduleResumePath,
  SCHEDULE_ERROR_CODES,
  SESSION_CLI_PROOF_HEADER,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resourceNotFound } from "../services/agents/errors.js";
import type { UserAuthService } from "../services/auth/index.js";
import { type AgentScheduleScope, ScheduleServiceError } from "../services/schedules/index.js";
import { SessionCliProofError } from "../services/sessions/index.js";

const accountId = randomUUID();
const agentId = randomUUID();
const sessionId = randomUUID();
const scheduleId = randomUUID();
const now = "2026-09-28T01:00:00.000Z";

const scope: AgentScheduleScope = { accountId, agentId, sessionId, sessionKind: "channel" };

const schedule: AgentSchedule = {
  id: scheduleId,
  agentId,
  target: { sessionId, provider: "feishu", sessionKind: "channel", channelId: "oc_test", threadKey: null },
  name: "Daily check",
  prompt: "Check the build.",
  schedule: { kind: "every", intervalSeconds: 3600, anchorAt: now },
  timezone: "Asia/Shanghai",
  enabled: true,
  nextTriggerAt: "2026-09-28T02:00:00.000Z",
  revision: 1,
  lastDispatch: null,
  detailUrl: `https://opentag.example.com/agents/${agentId}?schedule=${scheduleId}`,
  createdAt: now,
  updatedAt: now,
};

const preview: AgentSchedulePreview = {
  calculatedAt: now,
  schedule: schedule.schedule,
  timezone: schedule.timezone,
  items: [{ at: "2026-09-28T02:00:00.000Z", local: "2026-09-28 10:00:00 +08:00", timezone: "Asia/Shanghai" }],
};

const listResponse: AgentScheduleListResponse = {
  items: [(({ prompt: _prompt, detailUrl: _detailUrl, ...rest }) => rest)(schedule) as never],
  nextCursor: null,
};

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function runtimeFixture(overrides: Record<string, unknown> = {}) {
  const service = {
    authenticate: vi.fn(async () => scope),
    createForAgent: vi.fn(async () => schedule),
    listForAgent: vi.fn(async () => listResponse),
    getForAgent: vi.fn(async () => schedule),
    updateForAgent: vi.fn(async () => schedule),
    pauseForAgent: vi.fn(async () => ({ ...schedule, enabled: false, nextTriggerAt: null, revision: 2 })),
    resumeForAgent: vi.fn(async () => schedule),
    deleteForAgent: vi.fn(async () => undefined),
    previewForAgent: vi.fn(async () => preview),
    ...overrides,
  };
  const app = createApp({ runtimeAgentSchedules: { service: service as never } });
  apps.push(app);
  return { app, service };
}

function accountFixture(overrides: Record<string, unknown> = {}) {
  const service = {
    listForAccount: vi.fn(async () => listResponse),
    getForAccount: vi.fn(async () => schedule),
    pauseForAccount: vi.fn(async () => ({ ...schedule, enabled: false, nextTriggerAt: null, revision: 2 })),
    resumeForAccount: vi.fn(async () => schedule),
    deleteForAccount: vi.fn(async () => undefined),
    ...overrides,
  };
  const authService = {
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: accountId, email: "owner@example.com", displayName: "Owner" }, setupCompletedAt: null },
    }),
  } as unknown as UserAuthService;
  const app = createApp({ authService, agentSchedules: { service: service as never } });
  apps.push(app);
  return { app, service };
}

const proof = { [SESSION_CLI_PROOF_HEADER]: "proof-token" };
const bearer = { authorization: "Bearer access" };

describe("Runtime Agent schedule routes", () => {
  it("runs the full management surface with schema-checked responses", async () => {
    const { app, service } = runtimeFixture();

    const created = await app.inject({
      method: "POST",
      url: RUNTIME_AGENT_SCHEDULES_PATH,
      headers: proof,
      payload: {
        name: "Daily check",
        prompt: "Check the build.",
        schedule: { kind: "every", intervalSeconds: 3600 },
        timezone: "Asia/Shanghai",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toEqual(schedule);
    expect(service.createForAgent).toHaveBeenCalledWith(scope, {
      name: "Daily check",
      prompt: "Check the build.",
      schedule: { kind: "every", intervalSeconds: 3600 },
      timezone: "Asia/Shanghai",
    });

    const listed = await app.inject({ method: "GET", url: RUNTIME_AGENT_SCHEDULES_PATH, headers: proof });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(listResponse);
    expect(service.listForAgent).toHaveBeenCalledWith(scope, { limit: 50 });
    expect(listed.json().items[0]).not.toHaveProperty("prompt");

    const shown = await app.inject({ method: "GET", url: runtimeAgentSchedulePath(scheduleId), headers: proof });
    expect(shown.statusCode).toBe(200);
    expect(shown.json().prompt).toBe("Check the build.");

    const updated = await app.inject({
      method: "PATCH",
      url: runtimeAgentSchedulePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 1, name: "Renamed" },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.updateForAgent).toHaveBeenCalledWith(scope, scheduleId, { expectedRevision: 1, name: "Renamed" });

    const paused = await app.inject({
      method: "POST",
      url: runtimeAgentSchedulePausePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 1 },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });

    const resumed = await app.inject({
      method: "POST",
      url: runtimeAgentScheduleResumePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 2 },
    });
    expect(resumed.statusCode).toBe(200);
    expect(service.resumeForAgent).toHaveBeenCalledWith(scope, scheduleId, 2);

    const removed = await app.inject({
      method: "DELETE",
      url: `${runtimeAgentSchedulePath(scheduleId)}?expectedRevision=1`,
      headers: proof,
    });
    expect(removed.statusCode).toBe(204);
    expect(service.deleteForAgent).toHaveBeenCalledWith(scope, scheduleId, 1);

    const previewed = await app.inject({
      method: "POST",
      url: RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
      headers: proof,
      payload: { schedule: { kind: "cron", expression: "0 9 * * MON-FRI" }, timezone: "Asia/Shanghai" },
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toEqual(preview);
  });

  it("authenticates the proof before interpreting the request (P01)", async () => {
    const authenticate = vi.fn(async () => {
      throw new SessionCliProofError("invalid_proof", "invalid");
    });
    const { app, service } = runtimeFixture({ authenticate });

    // No proof at all, an invalid proof, and an invalid proof plus an invalid body all fail as
    // 401 without the body ever reaching the service.
    for (const request of [
      { method: "POST" as const, url: RUNTIME_AGENT_SCHEDULES_PATH, payload: { not: "valid" } },
      { method: "POST" as const, url: RUNTIME_AGENT_SCHEDULES_PATH, headers: proof, payload: { not: "valid" } },
      { method: "GET" as const, url: RUNTIME_AGENT_SCHEDULES_PATH, headers: proof },
      { method: "DELETE" as const, url: `${runtimeAgentSchedulePath(scheduleId)}?expectedRevision=x`, headers: proof },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "SESSION_PROOF_INVALID" } });
    }
    expect(service.createForAgent).not.toHaveBeenCalled();
    expect(service.listForAgent).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied target, source, agent, and anchor fields (P03)", async () => {
    const { app, service } = runtimeFixture();
    const base = {
      name: "Daily check",
      prompt: "Check the build.",
      schedule: { kind: "every", intervalSeconds: 3600 },
      timezone: "Asia/Shanghai",
    };
    const forbidden = [
      { ...base, targetSessionId: randomUUID() },
      { ...base, target: { sessionId: randomUUID() } },
      { ...base, agentId },
      { ...base, accountId },
      { ...base, scheduledOrigin: { scheduleId, scheduledFor: now, timezone: "UTC", name: "x" } },
      { ...base, sourceSessionId: sessionId },
      { ...base, schedule: { kind: "every", intervalSeconds: 3600, anchorAt: now } },
      { ...base, nextTriggerAt: now },
      { ...base, enabled: false },
    ];
    for (const payload of forbidden) {
      const response = await app.inject({ method: "POST", url: RUNTIME_AGENT_SCHEDULES_PATH, headers: proof, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    expect(service.createForAgent).not.toHaveBeenCalled();
  });

  it("validates identifiers, revisions, and pagination bounds", async () => {
    const { app, service } = runtimeFixture();

    const badId = await app.inject({ method: "GET", url: runtimeAgentSchedulePath("not-a-uuid"), headers: proof });
    expect(badId.statusCode).toBe(400);

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: runtimeAgentSchedulePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 1 },
    });
    expect(emptyPatch.statusCode).toBe(400);

    const unknownPauseField = await app.inject({
      method: "POST",
      url: runtimeAgentSchedulePausePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 1, enabled: true },
    });
    expect(unknownPauseField.statusCode).toBe(400);

    const missingRevision = await app.inject({
      method: "DELETE",
      url: runtimeAgentSchedulePath(scheduleId),
      headers: proof,
    });
    expect(missingRevision.statusCode).toBe(400);

    for (const limit of ["0", "101", "abc"]) {
      const response = await app.inject({
        method: "GET",
        url: `${RUNTIME_AGENT_SCHEDULES_PATH}?limit=${limit}`,
        headers: proof,
      });
      expect(response.statusCode).toBe(400);
    }
    const bounded = await app.inject({
      method: "GET",
      url: `${RUNTIME_AGENT_SCHEDULES_PATH}?limit=100`,
      headers: proof,
    });
    expect(bounded.statusCode).toBe(200);
    expect(service.listForAgent).toHaveBeenLastCalledWith(scope, { limit: 100 });
    expect(service.updateForAgent).not.toHaveBeenCalled();
  });

  it("renders the documented error envelopes", async () => {
    const conflict = new ScheduleServiceError(SCHEDULE_ERROR_CODES.REVISION_CONFLICT, "stale");
    const { app } = runtimeFixture({
      updateForAgent: vi.fn(async () => {
        throw conflict;
      }),
      getForAgent: vi.fn(async () => {
        throw resourceNotFound();
      }),
    });

    const stale = await app.inject({
      method: "PATCH",
      url: runtimeAgentSchedulePath(scheduleId),
      headers: proof,
      payload: { expectedRevision: 1, name: "Renamed" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "SCHEDULE_REVISION_CONFLICT", category: "deterministic" },
    });

    const missing = await app.inject({ method: "GET", url: runtimeAgentSchedulePath(scheduleId), headers: proof });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
  });
});

describe("Account schedule routes", () => {
  it("exposes exactly list, show, pause, resume, and delete (M10)", async () => {
    const { app, service } = accountFixture();

    const listed = await app.inject({ method: "GET", url: agentSchedulesPath(agentId), headers: bearer });
    expect(listed.statusCode).toBe(200);
    expect(service.listForAccount).toHaveBeenCalledWith(accountId, agentId, { limit: 50 });

    const shown = await app.inject({ method: "GET", url: agentSchedulePath(agentId, scheduleId), headers: bearer });
    expect(shown.statusCode).toBe(200);
    expect(service.getForAccount).toHaveBeenCalledWith(accountId, agentId, scheduleId);

    const paused = await app.inject({
      method: "POST",
      url: agentSchedulePausePath(agentId, scheduleId),
      headers: bearer,
      payload: { expectedRevision: 1 },
    });
    expect(paused.statusCode).toBe(200);
    expect(service.pauseForAccount).toHaveBeenCalledWith(accountId, agentId, scheduleId, 1);

    const resumed = await app.inject({
      method: "POST",
      url: agentScheduleResumePath(agentId, scheduleId),
      headers: bearer,
      payload: { expectedRevision: 2 },
    });
    expect(resumed.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `${agentSchedulePath(agentId, scheduleId)}?expectedRevision=2`,
      headers: bearer,
    });
    expect(removed.statusCode).toBe(204);

    // There is no Account create, update, or preview: those shapes are concealed as not found.
    for (const request of [
      { method: "POST" as const, url: agentSchedulesPath(agentId), payload: {} },
      { method: "PATCH" as const, url: agentSchedulePath(agentId, scheduleId), payload: {} },
      { method: "POST" as const, url: `${agentSchedulesPath(agentId)}/preview`, payload: {} },
    ]) {
      const response = await app.inject({ ...request, headers: bearer });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
    }
  });

  it("requires authentication and rejects malformed input without touching the service", async () => {
    const { app, service } = accountFixture();

    const anonymous = await app.inject({ method: "GET", url: agentSchedulesPath(agentId) });
    expect(anonymous.statusCode).toBe(401);

    const unknownField = await app.inject({
      method: "POST",
      url: agentSchedulePausePath(agentId, scheduleId),
      headers: bearer,
      payload: { expectedRevision: 1, enabled: false },
    });
    expect(unknownField.statusCode).toBe(400);

    const badAgent = await app.inject({ method: "GET", url: agentSchedulesPath("nope"), headers: bearer });
    expect(badAgent.statusCode).toBe(400);

    expect(service.listForAccount).not.toHaveBeenCalled();
    expect(service.pauseForAccount).not.toHaveBeenCalled();
  });
});
