import { randomUUID } from "node:crypto";
import {
  AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE,
  AGENT_SKILLS_INSTALL_TEMPLATE,
  ErrorEnvelopeSchema,
  SKILL_ERROR_CODES,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { registerRemoteSkillRoutes } from "../api/skill-install.js";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import { skillSourceNoSkills, skillSourceUnreachable } from "../services/skills/index.js";
import type { RemoteSkillService } from "../services/skills/source/remote-skill-service.js";

/**
 * The remote-install routes: authentication, argument validation, the shared error envelope, and the
 * two success shapes. The service itself is stubbed here; `skill-remote-install.test.ts` covers its
 * behaviour against a real database.
 */

const ACCOUNT = "account-1";
const AGENT = randomUUID();
const SOURCE = { kind: "github", url: "https://github.com/owner/repo.git" } as const;
const SELECTION = { name: "demo", fingerprint: `sha256:${"a".repeat(64)}` };

function userAuth(): UserAuthService {
  return {
    getAuthenticatedUser: async (token: string) => {
      if (token !== "good-token") {
        throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Authentication is required", 401);
      }
      return { me: { user: { id: ACCOUNT } }, tokenExpiresAt: new Date() };
    },
    getActiveUserById: async () => ({ me: { user: { id: ACCOUNT } } }),
  } as unknown as UserAuthService;
}

function fakeRemote(overrides: Partial<Record<keyof RemoteSkillService, unknown>> = {}): RemoteSkillService {
  return {
    resolve: vi.fn(async () => ({
      source: SOURCE,
      skills: [
        {
          name: "demo",
          description: "A demo",
          path: "skills/demo",
          fileCount: 2,
          alreadyInstalled: false,
        },
      ],
    })),
    install: vi.fn(async () => ({ results: [{ name: "demo", status: "installed" }] })),
    ...overrides,
  } as unknown as RemoteSkillService;
}

function appWith(remote: RemoteSkillService) {
  const app = createApp({});
  registerRemoteSkillRoutes(app, remote, userAuth(), {});
  return app;
}

const resolveUrl = AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE.replace(":agentId", AGENT);
const installUrl = AGENT_SKILLS_INSTALL_TEMPLATE.replace(":agentId", AGENT);

describe("remote install routes", () => {
  it("requires an Account session on both routes", async () => {
    const app = appWith(fakeRemote());
    for (const url of [resolveUrl, installUrl]) {
      const response = await app.inject({ method: "POST", url, payload: { source: "owner/repo" } });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    }
  });

  it("validates the Agent id and the body", async () => {
    const app = appWith(fakeRemote());
    const headers = { authorization: "Bearer good-token" };
    const missingAgent = await app.inject({
      method: "POST",
      url: AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE.replace(":agentId", "not-a-uuid"),
      headers,
      payload: { source: "owner/repo" },
    });
    expect(missingAgent.statusCode).toBe(400);

    for (const payload of [
      {},
      { source: "" },
      { source: "owner/repo", names: [] },
      { source: "owner/repo", extra: 1 },
    ]) {
      const response = await app.inject({ method: "POST", url: resolveUrl, headers, payload });
      expect(response.statusCode).toBe(400);
    }
    const installWithoutSelections = await app.inject({
      method: "POST",
      url: installUrl,
      headers,
      payload: { source: "owner/repo" },
    });
    expect(installWithoutSelections.statusCode).toBe(400);
  });

  it("previews a source without writing anything", async () => {
    const resolve = vi.fn(async () => ({ source: SOURCE, skills: [] }));
    const app = appWith(fakeRemote({ resolve }));
    const response = await app.inject({
      method: "POST",
      url: resolveUrl,
      headers: { authorization: "Bearer good-token" },
      payload: { source: "owner/repo" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(resolve).toHaveBeenCalledWith({ callerUserId: ACCOUNT, agentId: AGENT, source: "owner/repo" });
    expect(response.json()).toEqual({ source: SOURCE, skills: [] });
  });

  it("installs the selected names", async () => {
    const install = vi.fn(async () => ({
      results: [
        { name: "demo", status: "installed" },
        { name: "other", status: "skipped_name_conflict" },
      ],
    }));
    const app = appWith(fakeRemote({ install }));
    const response = await app.inject({
      method: "POST",
      url: installUrl,
      headers: { authorization: "Bearer good-token" },
      payload: { source: "owner/repo", selections: [SELECTION] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(install).toHaveBeenCalledWith({
      callerUserId: ACCOUNT,
      agentId: AGENT,
      source: "owner/repo",
      selections: [SELECTION],
    });
  });

  it("renders a source failure through the shared envelope", async () => {
    const app = appWith(
      fakeRemote({
        resolve: vi.fn(async () => {
          throw skillSourceNoSkills();
        }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: resolveUrl,
      headers: { authorization: "Bearer good-token" },
      payload: { source: "owner/repo" },
    });
    expect(response.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(response.json());
    expect(envelope.error).toMatchObject({ code: SKILL_ERROR_CODES.SOURCE_NO_SKILLS, category: "deterministic" });
  });

  it("renders an unreachable source as a retryable failure", async () => {
    const app = appWith(
      fakeRemote({
        install: vi.fn(async () => {
          throw skillSourceUnreachable();
        }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: installUrl,
      headers: { authorization: "Bearer good-token" },
      payload: { source: "owner/repo", selections: [SELECTION] },
    });
    expect(response.statusCode).toBe(502);
    expect(ErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
      code: SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
      category: "transient",
    });
  });
});
