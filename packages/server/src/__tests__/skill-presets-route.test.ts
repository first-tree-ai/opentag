import { randomUUID } from "node:crypto";
import {
  agentSkillPresetInstallPath,
  agentSkillPresetsPath,
  ErrorEnvelopeSchema,
  RUNTIME_SKILL_PRESETS_PATH,
  runtimeSkillPresetInstallPath,
  SESSION_CLI_PROOF_HEADER,
  SKILL_ERROR_CODES,
  type Skill,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { registerRuntimeSkillRoutes } from "../api/runtime-skills.js";
import { registerSkillRoutes } from "../api/skills.js";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import { SessionCliProofError, type SessionCliProofService } from "../services/sessions/index.js";
import {
  type SkillPresetService,
  type SkillService,
  skillNameConflict,
  skillNotFound,
  skillPresetNotFound,
} from "../services/skills/index.js";

const ACCOUNT = "account-1";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const SKILL = randomUUID();
const SHA = "a".repeat(64);

function skillSummary(source: Skill["source"] = "preset"): Skill {
  return {
    id: SKILL,
    agentId: AGENT,
    name: "mcp-onboarding",
    description: "Add MCP tools to this Agent",
    enabled: true,
    source,
    archiveSha256: SHA,
    archiveBytes: 3,
    fileCount: 1,
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

const CATALOG = {
  categories: [{ id: "getting-started", order: 10 }],
  presets: [
    {
      name: "mcp-onboarding",
      description: "Add MCP tools to this Agent",
      category: "getting-started",
      order: 10,
      archiveSha256: SHA,
      archiveBytes: 3,
      fileCount: 1,
      state: "not_installed",
    },
  ],
};

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

function goodProofs(): Pick<SessionCliProofService, "authenticate"> {
  return {
    authenticate: async (proof: string) => {
      if (proof !== "good-proof") {
        throw new SessionCliProofError("invalid_proof", "The Session CLI proof is invalid or stale");
      }
      return { agentId: AGENT };
    },
  } as unknown as Pick<SessionCliProofService, "authenticate">;
}

function fakeSkillService(): SkillService {
  return { list: vi.fn(), listForAgent: vi.fn() } as unknown as SkillService;
}

function fakePresetService(overrides: Partial<Record<keyof SkillPresetService, unknown>> = {}): SkillPresetService {
  return {
    list: vi.fn(async () => CATALOG),
    install: vi.fn(async () => ({ action: "installed", skill: skillSummary() })),
    listForAgent: vi.fn(async () => CATALOG),
    installForAgent: vi.fn(async () => ({ action: "updated", skill: skillSummary() })),
    ...overrides,
  } as unknown as SkillPresetService;
}

const ACCOUNT_HEADERS = { authorization: "Bearer good-token" };
const PROOF_HEADERS = { [SESSION_CLI_PROOF_HEADER]: "good-proof" };

describe("preset Skill routes", () => {
  it("requires authentication on both surfaces", async () => {
    const app = createApp({});
    registerSkillRoutes(app, fakeSkillService(), userAuth(), {}, undefined, fakePresetService());
    registerRuntimeSkillRoutes(app, fakeSkillService(), goodProofs(), fakePresetService());

    const account = await app.inject({ method: "GET", url: agentSkillPresetsPath(AGENT) });
    expect(account.statusCode).toBe(401);
    expect(account.json().error).toMatchObject({ code: "AUTH_INVALID_TOKEN" });

    const runtime = await app.inject({ method: "GET", url: RUNTIME_SKILL_PRESETS_PATH });
    expect(runtime.statusCode).toBe(401);
    expect(runtime.json().error).toMatchObject({ code: "SESSION_PROOF_INVALID" });
    await app.close();
  });

  it("returns the catalog with no-store caching", async () => {
    const app = createApp({});
    const preset = fakePresetService();
    registerSkillRoutes(app, fakeSkillService(), userAuth(), {}, undefined, preset);

    const response = await app.inject({
      method: "GET",
      url: agentSkillPresetsPath(AGENT),
      headers: ACCOUNT_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(CATALOG);
    expect(preset.list).toHaveBeenCalledWith(ACCOUNT, AGENT);
    await app.close();
  });

  it("installs the preset named in the path", async () => {
    const app = createApp({});
    const preset = fakePresetService();
    registerSkillRoutes(app, fakeSkillService(), userAuth(), {}, undefined, preset);

    const response = await app.inject({
      method: "POST",
      url: agentSkillPresetInstallPath(AGENT, "mcp-onboarding"),
      headers: ACCOUNT_HEADERS,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      action: "installed",
      skill: { name: "mcp-onboarding", source: "preset" },
    });
    expect(preset.install).toHaveBeenCalledWith(ACCOUNT, AGENT, "mcp-onboarding");
    await app.close();
  });

  it("renders an unknown preset and a name conflict as Skill error envelopes", async () => {
    const app = createApp({});
    registerSkillRoutes(
      app,
      fakeSkillService(),
      userAuth(),
      {},
      undefined,
      fakePresetService({ install: vi.fn(async () => Promise.reject(skillPresetNotFound())) }),
    );
    const missing = await app.inject({
      method: "POST",
      url: agentSkillPresetInstallPath(AGENT, "not-a-preset"),
      headers: ACCOUNT_HEADERS,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(missing.json()).error).toMatchObject({
      code: SKILL_ERROR_CODES.PRESET_NOT_FOUND,
    });
    await app.close();

    const conflicted = createApp({});
    registerSkillRoutes(
      conflicted,
      fakeSkillService(),
      userAuth(),
      {},
      undefined,
      fakePresetService({ install: vi.fn(async () => Promise.reject(skillNameConflict())) }),
    );
    const conflict = await conflicted.inject({
      method: "POST",
      url: agentSkillPresetInstallPath(AGENT, "mcp-onboarding"),
      headers: ACCOUNT_HEADERS,
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(conflict.json()).error).toMatchObject({ code: SKILL_ERROR_CODES.NAME_CONFLICT });
    await conflicted.close();
  });

  it("treats a foreign Agent as missing", async () => {
    const app = createApp({});
    registerSkillRoutes(
      app,
      fakeSkillService(),
      userAuth(),
      {},
      undefined,
      fakePresetService({ list: vi.fn(async () => Promise.reject(skillNotFound())) }),
    );
    const response = await app.inject({
      method: "GET",
      url: agentSkillPresetsPath(AGENT),
      headers: ACCOUNT_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({ code: SKILL_ERROR_CODES.NOT_FOUND });
    await app.close();
  });

  it("does not register the preset routes without the service", async () => {
    const app = createApp({});
    registerSkillRoutes(app, fakeSkillService(), userAuth(), {});
    const response = await app.inject({
      method: "GET",
      url: agentSkillPresetsPath(AGENT),
      headers: ACCOUNT_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("derives the runtime Agent from the proof and ignores request fields", async () => {
    const app = createApp({});
    const preset = fakePresetService();
    registerRuntimeSkillRoutes(app, fakeSkillService(), goodProofs(), preset);

    const listed = await app.inject({
      method: "GET",
      url: `${RUNTIME_SKILL_PRESETS_PATH}?agentId=${OTHER_AGENT}`,
      headers: PROOF_HEADERS,
    });
    expect(listed.statusCode).toBe(200);
    expect(preset.listForAgent).toHaveBeenCalledWith(AGENT);

    const installed = await app.inject({
      method: "POST",
      url: runtimeSkillPresetInstallPath("mcp-onboarding"),
      headers: PROOF_HEADERS,
      payload: { agentId: OTHER_AGENT },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ action: "updated", skill: { source: "preset" } });
    expect(preset.installForAgent).toHaveBeenCalledWith(AGENT, "mcp-onboarding");
    await app.close();
  });
});
