import { Readable } from "node:stream";
import {
  ACCOUNT_SKILLS_PATH,
  agentSkillsPath,
  EMPTY_AGENT_SKILLS_DIGEST,
  SKILL_ARCHIVE_MAX_BYTES,
  type SkillDetail,
  skillAgentsPath,
  skillArchivePath,
  skillByNamePath,
  skillSkillMdPath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { AuthServiceError } from "../services/auth/index.js";
import { skillAlreadyExists, skillNotFound } from "../services/skills/index.js";
import { signedInBrowser } from "./signed-in-browser.js";
import { validSkillZip } from "./support/skill-fixtures.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "6a7f5ffb-65c2-40e2-8b20-89f430aa74e5";
const bearer = { authorization: "Bearer access" };
const zipHeaders = { ...bearer, "content-type": "application/zip" };
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn().mockResolvedValue({
      user: { id: userId, email: "admin@example.com", displayName: "Admin" },
      setupCompletedAt: null,
    }),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: userId, email: "admin@example.com", displayName: "Admin" }, setupCompletedAt: null },
    }),
  };
}

function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: "my-skill",
    description: "Does something useful",
    digest: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    archiveBytes: 512,
    fileCount: 1,
    totalBytes: 40,
    agentCount: 0,
    updatedAt: "2026-09-11T10:00:00.000Z",
    updatedBy: { kind: "user", id: userId },
    manifest: {
      schemaVersion: 1,
      name: "my-skill",
      files: [{ path: "SKILL.md", sha256: "c".repeat(64), size: 40, mode: "0644" }],
    },
    ...overrides,
  };
}

function summary() {
  const { manifest: _manifest, ...rest } = detail();
  return rest;
}

function services() {
  const skills = {
    list: vi.fn().mockResolvedValue({ skills: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(detail()),
    getSkillMd: vi.fn().mockResolvedValue({ name: "my-skill", markdown: "---\nname: my-skill\n---\n# Hi\n" }),
    upsertFromArchive: vi.fn().mockResolvedValue({ skill: detail(), created: true, affectedAgentIds: [] }),
    delete: vi.fn().mockResolvedValue({ affectedAgentIds: [agentId] }),
    openArchive: vi.fn().mockResolvedValue({
      name: "my-skill",
      archiveSha256: "b".repeat(64),
      archiveBytes: 3,
      open: vi.fn().mockResolvedValue({ stream: Readable.from([Buffer.from("zip")]), contentLength: 3 }),
    }),
  };
  const assignments = {
    listForAgent: vi.fn().mockResolvedValue({ agentId, digest: EMPTY_AGENT_SKILLS_DIGEST, skills: [] }),
    replaceForAgent: vi.fn().mockResolvedValue({ agentId, digest: "d".repeat(64), skills: [summary()] }),
    agentsForSkill: vi.fn().mockResolvedValue({ agents: [{ agentId, name: "assistant", displayName: "Assistant" }] }),
  };
  const notifier = { notifyAgents: vi.fn().mockResolvedValue(undefined) };
  return { skills, assignments, notifier };
}

function createSkillsApp(configured = true, auth = authService()) {
  const deps = services();
  const app = createApp({
    loggerLevel: "silent",
    authService: auth,
    ...(configured
      ? { skills: { skills: deps.skills as never, assignments: deps.assignments as never, notifier: deps.notifier } }
      : {}),
  });
  apps.push(app);
  return { app, ...deps, auth };
}

describe("Skill library HTTP API", () => {
  it("requires account authentication on every route", async () => {
    const auth = authService();
    vi.mocked(auth.getAuthenticatedUser).mockRejectedValue(
      new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "invalid", 401),
    );
    const { app, skills } = createSkillsApp(true, auth);
    for (const [method, url] of [
      ["GET", ACCOUNT_SKILLS_PATH],
      ["GET", skillByNamePath("my-skill")],
      ["DELETE", skillByNamePath("my-skill")],
      ["GET", agentSkillsPath(agentId)],
    ] as const) {
      const response = await app.inject({ method, url, headers: bearer });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    const upload = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: zipHeaders,
      payload: Buffer.from(validSkillZip()),
    });
    expect(upload.statusCode).toBe(401);
    expect(skills.upsertFromArchive).not.toHaveBeenCalled();
  });

  it("answers 503 SKILL_STORAGE_UNAVAILABLE when the deployment has no skill storage", async () => {
    const { app } = createSkillsApp(false);
    const response = await app.inject({ method: "GET", url: ACCOUNT_SKILLS_PATH, headers: bearer });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "SKILL_STORAGE_UNAVAILABLE", category: "transient" } });
  });

  it("requires the CSRF double-submit token for browser cookie uploads", async () => {
    const deps = services();
    const app = createApp({
      loggerLevel: "silent",
      authService: authService(),
      betterAuth: signedInBrowser(userId),
      browserAuth: { publicOrigin: "https://dev.example.com", sessionTtlSeconds: 3600, secureCookies: true },
      skills: { skills: deps.skills as never, assignments: deps.assignments as never },
    });
    apps.push(app);
    const cookie = "opentag.session_token=session; opentag_csrf=csrf";
    const rejected = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: { cookie, "content-type": "application/zip" },
      payload: Buffer.from(validSkillZip()),
    });
    expect(rejected.statusCode).toBe(403);
    expect(deps.skills.upsertFromArchive).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: {
        cookie,
        origin: "https://dev.example.com",
        "x-opentag-csrf": "csrf",
        "content-type": "application/zip",
      },
      payload: Buffer.from(validSkillZip()),
    });
    expect(accepted.statusCode).toBe(201);
  });

  it("refuses non-zip uploads with 415 and oversized archives with a 413 envelope", async () => {
    const { app, skills } = createSkillsApp();
    const octet = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: { ...bearer, "content-type": "application/octet-stream" },
      payload: Buffer.from("zip"),
    });
    expect(octet.statusCode).toBe(415);
    expect(octet.json()).toMatchObject({ error: { code: "SKILL_ARCHIVE_UNSUPPORTED_MEDIA_TYPE" } });
    const json = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: bearer,
      payload: { zip: true },
    });
    expect(json.statusCode).toBe(415);
    const huge = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: zipHeaders,
      payload: Buffer.alloc(SKILL_ARCHIVE_MAX_BYTES + 1),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({
      error: { code: "SKILL_ARCHIVE_TOO_LARGE", category: "validation", requestId: expect.any(String) },
    });
    expect(skills.upsertFromArchive).not.toHaveBeenCalled();
  });

  it("uploads with 201, reports 409 on a name conflict, and replaces with 200 when asked", async () => {
    const { app, skills, notifier } = createSkillsApp();
    const bytes = Buffer.from(validSkillZip());
    const created = await app.inject({ method: "POST", url: ACCOUNT_SKILLS_PATH, headers: zipHeaders, payload: bytes });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(detail());
    expect(skills.upsertFromArchive).toHaveBeenCalledWith(userId, expect.any(Uint8Array), {
      onConflict: "fail",
      updatedBy: { kind: "user", id: userId },
    });
    expect(Buffer.from(skills.upsertFromArchive.mock.calls[0]?.[1] as Uint8Array).equals(bytes)).toBe(true);

    skills.upsertFromArchive.mockRejectedValueOnce(skillAlreadyExists("my-skill"));
    const conflict = await app.inject({
      method: "POST",
      url: ACCOUNT_SKILLS_PATH,
      headers: zipHeaders,
      payload: bytes,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "SKILL_ALREADY_EXISTS", category: "deterministic" } });

    skills.upsertFromArchive.mockResolvedValueOnce({ skill: detail(), created: false, affectedAgentIds: [agentId] });
    const replaced = await app.inject({
      method: "POST",
      url: `${ACCOUNT_SKILLS_PATH}?onConflict=replace`,
      headers: zipHeaders,
      payload: bytes,
    });
    expect(replaced.statusCode).toBe(200);
    expect(skills.upsertFromArchive).toHaveBeenLastCalledWith(
      userId,
      expect.any(Uint8Array),
      expect.objectContaining({ onConflict: "replace" }),
    );
    expect(notifier.notifyAgents).toHaveBeenCalledWith([agentId]);
    const badQuery = await app.inject({
      method: "POST",
      url: `${ACCOUNT_SKILLS_PATH}?onConflict=merge`,
      headers: zipHeaders,
      payload: bytes,
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", issues: expect.any(Array) } });
  });

  it("lists with validated pagination and returns details and 404s from the service", async () => {
    const { app, skills } = createSkillsApp();
    const list = await app.inject({
      method: "GET",
      url: `${ACCOUNT_SKILLS_PATH}?limit=10&cursor=alpha`,
      headers: bearer,
    });
    expect(list.statusCode).toBe(200);
    expect(skills.list).toHaveBeenCalledWith(userId, { limit: 10, cursor: "alpha" });
    expect(
      (await app.inject({ method: "GET", url: `${ACCOUNT_SKILLS_PATH}?limit=0`, headers: bearer })).statusCode,
    ).toBe(400);
    const found = await app.inject({ method: "GET", url: skillByNamePath("my-skill"), headers: bearer });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(detail());
    skills.get.mockRejectedValueOnce(skillNotFound());
    const missing = await app.inject({ method: "GET", url: skillByNamePath("missing"), headers: bearer });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "SKILL_NOT_FOUND" } });
    expect((await app.inject({ method: "GET", url: skillByNamePath("Bad_Name"), headers: bearer })).statusCode).toBe(
      400,
    );
  });

  it("serves SKILL.md as inline, nosniff markdown", async () => {
    const { app } = createSkillsApp();
    const response = await app.inject({ method: "GET", url: skillSkillMdPath("my-skill"), headers: bearer });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe('inline; filename="SKILL.md"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toBe("---\nname: my-skill\n---\n# Hi\n");
  });

  it("streams the archive with download headers and honours If-None-Match without opening storage", async () => {
    const { app, skills } = createSkillsApp();
    const response = await app.inject({ method: "GET", url: skillArchivePath("my-skill"), headers: bearer });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-length"]).toBe("3");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="my-skill.zip"');
    expect(response.headers.etag).toBe(`"${"b".repeat(64)}"`);
    expect(response.body).toBe("zip");
    const opened = (await skills.openArchive.mock.results[0]?.value) as { open: ReturnType<typeof vi.fn> };
    expect(opened.open).toHaveBeenCalledTimes(1);
    opened.open.mockClear();

    const cached = await app.inject({
      method: "GET",
      url: skillArchivePath("my-skill"),
      headers: { ...bearer, "if-none-match": `W/"other", "${"b".repeat(64)}"` },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers.etag).toBe(`"${"b".repeat(64)}"`);
    expect(cached.body).toBe("");
    expect(skills.openArchive).toHaveBeenCalledTimes(2);
    expect(opened.open).not.toHaveBeenCalled();
  });

  it("deletes with 204 and notifies the agents that lost the skill", async () => {
    const { app, skills, notifier } = createSkillsApp();
    const response = await app.inject({ method: "DELETE", url: skillByNamePath("my-skill"), headers: bearer });
    expect(response.statusCode).toBe(204);
    expect(skills.delete).toHaveBeenCalledWith(userId, "my-skill");
    expect(notifier.notifyAgents).toHaveBeenCalledWith([agentId]);
  });

  it("does not fail a mutation when notification fails", async () => {
    const { app, notifier } = createSkillsApp();
    notifier.notifyAgents.mockRejectedValueOnce(new Error("socket closed"));
    const response = await app.inject({ method: "DELETE", url: skillByNamePath("my-skill"), headers: bearer });
    expect(response.statusCode).toBe(204);
  });

  it("reads and replaces agent assignments and lists the agents of a skill", async () => {
    const { app, assignments, notifier } = createSkillsApp();
    const listed = await app.inject({ method: "GET", url: agentSkillsPath(agentId), headers: bearer });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ agentId, digest: EMPTY_AGENT_SKILLS_DIGEST, skills: [] });

    const replaced = await app.inject({
      method: "PUT",
      url: agentSkillsPath(agentId),
      headers: bearer,
      payload: { skillNames: ["my-skill"] },
    });
    expect(replaced.statusCode).toBe(200);
    expect(assignments.replaceForAgent).toHaveBeenCalledWith(userId, agentId, ["my-skill"]);
    expect(notifier.notifyAgents).toHaveBeenCalledWith([agentId]);

    const duplicate = await app.inject({
      method: "PUT",
      url: agentSkillsPath(agentId),
      headers: bearer,
      payload: { skillNames: ["a", "a"] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    assignments.replaceForAgent.mockRejectedValueOnce(skillNotFound(["ghost"]));
    const unknown = await app.inject({
      method: "PUT",
      url: agentSkillsPath(agentId),
      headers: bearer,
      payload: { skillNames: ["ghost"] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "SKILL_NOT_FOUND", details: { missing: ["ghost"] } } });

    const agentsOfSkill = await app.inject({ method: "GET", url: skillAgentsPath("my-skill"), headers: bearer });
    expect(agentsOfSkill.statusCode).toBe(200);
    expect(agentsOfSkill.json()).toEqual({ agents: [{ agentId, name: "assistant", displayName: "Assistant" }] });
    expect((await app.inject({ method: "GET", url: agentSkillsPath("not-a-uuid"), headers: bearer })).statusCode).toBe(
      400,
    );
  });
});
