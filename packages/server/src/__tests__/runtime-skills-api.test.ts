import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  EMPTY_AGENT_SKILLS_DIGEST,
  runtimeSessionSkillsPath,
  runtimeSkillArchivePath,
  runtimeSkillsPath,
  SESSION_CLI_PROOF_HEADER,
  type SkillDetail,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import { SessionCliProofError } from "../services/sessions/index.js";
import { skillNotFound } from "../services/skills/index.js";
import { validSkillZip } from "./support/skill-fixtures.js";

const computerId = "59ea83c3-0452-4fdb-a81b-e8037e91cd1b";
const ownerAccountId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "6a7f5ffb-65c2-40e2-8b20-89f430aa74e5";
const machine = { authorization: "Bearer machine" };
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const source = {
  agentId,
  computerId,
  connectionInstanceId: randomUUID(),
  placementGeneration: 2,
  sessionId: randomUUID(),
  sessionKind: "channel" as const,
  installationId: randomUUID(),
};

function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: "pushed",
    description: "Pushed from a session",
    digest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 3,
    fileCount: 1,
    totalBytes: 40,
    agentCount: 1,
    updatedAt: "2026-09-11T10:00:00.000Z",
    updatedBy: { kind: "session", id: source.sessionId },
    manifest: {
      schemaVersion: 1,
      name: "pushed",
      files: [{ path: "SKILL.md", sha256: "c".repeat(64), size: 40, mode: "0644" }],
    },
    ...overrides,
  };
}

function accountAuth(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi
      .fn()
      .mockRejectedValue(new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "account token", 401)),
  };
}

function createRuntimeApp(options: { configured?: boolean; withProofs?: boolean } = {}) {
  const manifest = {
    agents: [{ agentId, digest: EMPTY_AGENT_SKILLS_DIGEST, skills: [] }],
  };
  const skills = {
    openArchiveById: vi.fn().mockResolvedValue({
      name: "pushed",
      archiveSha256: "b".repeat(64),
      archiveBytes: 3,
      open: vi.fn().mockResolvedValue({ stream: Readable.from([Buffer.from("zip")]), contentLength: 3 }),
    }),
    upsertFromArchive: vi.fn().mockResolvedValue({ skill: detail(), created: true, affectedAgentIds: [agentId] }),
  };
  const assignments = {
    manifestForComputer: vi.fn().mockResolvedValue(manifest),
    assertSkillAssignedOnComputer: vi.fn().mockResolvedValue({ skillId: randomUUID() }),
    resolveAgentOwner: vi.fn().mockResolvedValue({ id: agentId, ownerAccountId }),
  };
  const notifier = { notifyAgents: vi.fn().mockResolvedValue(undefined) };
  const machineAuth = {
    verifyMachineToken: vi.fn(async (token: string) => {
      if (token !== "machine")
        throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "machine token required", 401);
      return { credentialId: randomUUID(), computerId, installationId: source.installationId };
    }),
  };
  const authenticate = vi.fn(async (token: string) => {
    if (token !== "proof") throw new SessionCliProofError("invalid_proof", "invalid");
    return source;
  });
  const app = createApp({
    loggerLevel: "silent",
    authService: accountAuth(),
    machineAuthService: machineAuth as never,
    ...(options.configured === false
      ? {}
      : { skills: { skills: skills as never, assignments: assignments as never, notifier } }),
    ...(options.withProofs === false
      ? {}
      : {
          runtimeSessions: {
            collaboration: { create: vi.fn(), send: vi.fn() },
            proofs: { authenticate },
            sessions: { listInternalSessions: vi.fn() },
          },
        }),
  });
  apps.push(app);
  return { app, skills, assignments, notifier, machineAuth, authenticate, manifest };
}

describe("Runtime skill HTTP API", () => {
  it("requires a machine token and rejects account bearer tokens", async () => {
    const { app, assignments } = createRuntimeApp();
    const response = await app.inject({
      method: "GET",
      url: runtimeSkillsPath(),
      headers: { authorization: "Bearer account" },
    });
    expect(response.statusCode).toBe(401);
    expect(assignments.manifestForComputer).not.toHaveBeenCalled();
  });

  it("answers 503 when skill storage is not configured", async () => {
    const { app } = createRuntimeApp({ configured: false });
    const response = await app.inject({ method: "GET", url: runtimeSkillsPath(), headers: machine });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "SKILL_STORAGE_UNAVAILABLE" } });
  });

  it("returns the manifest scoped to the authenticated computer, optionally for one agent", async () => {
    const { app, assignments, manifest } = createRuntimeApp();
    const all = await app.inject({ method: "GET", url: runtimeSkillsPath(), headers: machine });
    expect(all.statusCode).toBe(200);
    expect(all.headers["cache-control"]).toBe("no-store");
    expect(all.json()).toEqual(manifest);
    expect(assignments.manifestForComputer).toHaveBeenCalledWith(computerId, undefined);

    const one = await app.inject({ method: "GET", url: runtimeSkillsPath(agentId), headers: machine });
    expect(one.statusCode).toBe(200);
    expect(assignments.manifestForComputer).toHaveBeenLastCalledWith(computerId, agentId);

    assignments.manifestForComputer.mockResolvedValueOnce(undefined);
    const foreign = await app.inject({ method: "GET", url: runtimeSkillsPath(randomUUID()), headers: machine });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
  });

  it("streams an assigned archive with ETag support and 404s an unassigned one", async () => {
    const { app, assignments, skills } = createRuntimeApp();
    const response = await app.inject({ method: "GET", url: runtimeSkillArchivePath("pushed"), headers: machine });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers.etag).toBe(`"${"b".repeat(64)}"`);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="pushed.zip"');
    expect(response.body).toBe("zip");
    expect(assignments.assertSkillAssignedOnComputer).toHaveBeenCalledWith(computerId, "pushed");

    const cached = await app.inject({
      method: "GET",
      url: runtimeSkillArchivePath("pushed"),
      headers: { ...machine, "if-none-match": `"${"b".repeat(64)}"` },
    });
    expect(cached.statusCode).toBe(304);

    assignments.assertSkillAssignedOnComputer.mockRejectedValueOnce(skillNotFound());
    const unassigned = await app.inject({ method: "GET", url: runtimeSkillArchivePath("other"), headers: machine });
    expect(unassigned.statusCode).toBe(404);
    expect(unassigned.json()).toMatchObject({ error: { code: "SKILL_NOT_FOUND" } });
    expect(skills.openArchiveById).toHaveBeenCalledTimes(2);
  });

  it("accepts an in-session push under the session proof, assigns it to the agent, and notifies", async () => {
    const { app, skills, assignments, notifier, authenticate } = createRuntimeApp();
    const bytes = Buffer.from(validSkillZip("pushed"));
    const response = await app.inject({
      method: "POST",
      url: `${runtimeSessionSkillsPath(source.sessionId)}?onConflict=replace`,
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof", "content-type": "application/zip" },
      payload: bytes,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ name: "pushed", updatedBy: { kind: "session", id: source.sessionId } });
    expect(authenticate).toHaveBeenCalledWith("proof");
    expect(assignments.resolveAgentOwner).toHaveBeenCalledWith(agentId);
    expect(skills.upsertFromArchive).toHaveBeenCalledWith(ownerAccountId, expect.any(Uint8Array), {
      onConflict: "replace",
      updatedBy: { kind: "session", id: source.sessionId },
      autoAssignAgentId: agentId,
    });
    expect(notifier.notifyAgents).toHaveBeenCalledWith([agentId]);
  });

  it("rejects pushes without a valid proof, for another session, or with the wrong media type", async () => {
    const { app, skills, assignments } = createRuntimeApp();
    const bytes = Buffer.from(validSkillZip("pushed"));
    const noProof = await app.inject({
      method: "POST",
      url: runtimeSessionSkillsPath(source.sessionId),
      headers: { "content-type": "application/zip" },
      payload: bytes,
    });
    expect(noProof.statusCode).toBe(401);
    expect(noProof.json()).toMatchObject({ error: { code: "SESSION_PROOF_INVALID" } });

    const otherSession = await app.inject({
      method: "POST",
      url: runtimeSessionSkillsPath(randomUUID()),
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof", "content-type": "application/zip" },
      payload: bytes,
    });
    expect(otherSession.statusCode).toBe(404);

    assignments.resolveAgentOwner.mockResolvedValueOnce(undefined);
    const inactiveAgent = await app.inject({
      method: "POST",
      url: runtimeSessionSkillsPath(source.sessionId),
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof", "content-type": "application/zip" },
      payload: bytes,
    });
    expect(inactiveAgent.statusCode).toBe(404);

    const wrongType = await app.inject({
      method: "POST",
      url: runtimeSessionSkillsPath(source.sessionId),
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof", "content-type": "application/gzip" },
      payload: bytes,
    });
    expect(wrongType.statusCode).toBe(415);
    expect(skills.upsertFromArchive).not.toHaveBeenCalled();
  });

  it("does not expose the push route when the server issues no session proofs", async () => {
    const { app } = createRuntimeApp({ withProofs: false });
    const response = await app.inject({
      method: "POST",
      url: runtimeSessionSkillsPath(source.sessionId),
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof", "content-type": "application/zip" },
      payload: Buffer.from(validSkillZip("pushed")),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
  });
});
