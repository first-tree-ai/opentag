import { randomUUID } from "node:crypto";
import {
  AGENT_SKILL_BUNDLE_TEMPLATE,
  AGENT_SKILL_TEMPLATE,
  AGENT_SKILLS_TEMPLATE,
  COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE,
  COMPUTER_AGENT_SKILLS_TEMPLATE,
  ErrorEnvelopeSchema,
  HTTP_PATHS,
  RuntimeSkillManifestSchema,
  runtimeSkillBundlePath,
  SKILL_ERROR_CODES,
  SKILL_FORMAT_HEADER,
  SKILL_REPLACE_HEADER,
  SKILL_SHA256_HEADER,
  SKILL_UPLOAD_CONTENT_TYPE,
  type Skill,
  type SkillDetail,
} from "@opentag/shared";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerComputerSkillRoutes } from "../api/computer-skills.js";
import { registerRuntimeSkillRoutes } from "../api/runtime-skills.js";
import { skillBundleDisposition } from "../api/skill-bundle.js";
import { parseSkillUploadHeaders } from "../api/skill-upload.js";
import { registerSkillRoutes } from "../api/skills.js";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import { SessionCliProofError, type SessionCliProofService } from "../services/sessions/index.js";
import {
  type SkillService,
  type SkillServiceError,
  skillNameConflict,
  skillRevisionConflict,
  skillStorageUnavailable,
} from "../services/skills/index.js";

const ACCOUNT = "account-1";
const AGENT = randomUUID();
const SKILL = randomUUID();
const SHA = "a".repeat(64);

const detail: SkillDetail = {
  id: SKILL,
  agentId: AGENT,
  name: "demo",
  description: "A test Skill",
  enabled: true,
  source: "web_upload",
  archiveSha256: SHA,
  archiveBytes: 3,
  fileCount: 1,
  revision: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  files: [{ path: "SKILL.md", bytes: 3 }],
  filesTruncated: false,
};

const skillSummary: Skill = {
  id: detail.id,
  agentId: detail.agentId,
  name: detail.name,
  description: detail.description,
  enabled: detail.enabled,
  source: detail.source,
  archiveSha256: detail.archiveSha256,
  archiveBytes: detail.archiveBytes,
  fileCount: detail.fileCount,
  revision: detail.revision,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
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

function fakeService(overrides: Partial<Record<keyof SkillService, unknown>> = {}): SkillService {
  const bundle = () => ({
    skill: detail,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.close();
      },
    }),
    sha256: SHA,
    bytes: 3,
  });
  return {
    list: vi.fn(async () => ({ skills: [skillSummary], storage: "available" })),
    get: vi.fn(async () => detail),
    upload: vi.fn(async () => detail),
    setEnabled: vi.fn(async () => detail),
    remove: vi.fn(async () => undefined),
    openBundle: vi.fn(async () => bundle()),
    manifestForComputer: vi.fn(async () => ({
      skills: [{ id: SKILL, name: "demo", archiveSha256: SHA, archiveBytes: 3 }],
    })),
    openBundleForComputer: vi.fn(async () => bundle()),
    listForAgent: vi.fn(async () => ({ skills: [skillSummary], storage: "available" })),
    uploadForAgent: vi.fn(async () => ({ ...detail, source: "agent_upload" })),
    openBundleForAgent: vi.fn(async () => bundle()),
    ...overrides,
  } as unknown as SkillService;
}

function headerRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const VALID_UPLOAD_HEADERS = {
  "content-type": SKILL_UPLOAD_CONTENT_TYPE,
  "content-length": "3",
  [SKILL_SHA256_HEADER]: SHA,
};

describe("skillBundleDisposition", () => {
  it("names the saved file after the Skill", () => {
    expect(skillBundleDisposition("demo")).toBe('attachment; filename="demo.tar.gz"');
    expect(skillBundleDisposition("release-notes-2")).toBe('attachment; filename="release-notes-2.tar.gz"');
  });

  it("falls back for a name outside the contract's character set", () => {
    for (const hostile of ['evil".tar.gz', "a\r\nx-disposition: inline", "UPPER", "a/b", "?", ""]) {
      expect(skillBundleDisposition(hostile)).toBe('attachment; filename="skill.tar.gz"');
    }
  });
});

describe("Skill upload header preconditions", () => {
  it("accepts the canonical header set and defaults", () => {
    expect(parseSkillUploadHeaders(headerRequest(VALID_UPLOAD_HEADERS))).toEqual({
      declaredBytes: 3,
      declaredSha256: SHA,
      format: "tar.gz",
      replace: false,
    });
    expect(
      parseSkillUploadHeaders(
        headerRequest({
          ...VALID_UPLOAD_HEADERS,
          [SKILL_FORMAT_HEADER]: "zip",
          [SKILL_REPLACE_HEADER]: "true",
        }),
      ),
    ).toMatchObject({ format: "zip", replace: true });
  });

  it("rejects a missing length, a transfer encoding, and an over-limit length", () => {
    expect(() =>
      parseSkillUploadHeaders(headerRequest({ ...VALID_UPLOAD_HEADERS, "content-length": undefined })),
    ).toThrow(expect.objectContaining({ code: SKILL_ERROR_CODES.ARCHIVE_INVALID }));
    expect(() =>
      parseSkillUploadHeaders(headerRequest({ ...VALID_UPLOAD_HEADERS, "transfer-encoding": "chunked" })),
    ).toThrow(expect.objectContaining({ code: SKILL_ERROR_CODES.ARCHIVE_INVALID }));
    const error = (() => {
      try {
        parseSkillUploadHeaders(
          headerRequest({ ...VALID_UPLOAD_HEADERS, "content-length": String(16 * 1024 * 1024 + 1) }),
        );
        return undefined;
      } catch (thrown) {
        return thrown as SkillServiceError;
      }
    })();
    expect(error?.code).toBe(SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE);
    expect(error?.statusCode).toBe(413);
  });

  it("rejects a bad sha, a bad format, and a replace value that is not true", () => {
    expect(() =>
      parseSkillUploadHeaders(headerRequest({ ...VALID_UPLOAD_HEADERS, [SKILL_SHA256_HEADER]: "NOTHEX" })),
    ).toThrow(expect.objectContaining({ code: SKILL_ERROR_CODES.ARCHIVE_INVALID }));
    expect(() =>
      parseSkillUploadHeaders(headerRequest({ ...VALID_UPLOAD_HEADERS, [SKILL_FORMAT_HEADER]: "rar" })),
    ).toThrow(expect.objectContaining({ code: SKILL_ERROR_CODES.ARCHIVE_INVALID }));
    expect(() =>
      parseSkillUploadHeaders(headerRequest({ ...VALID_UPLOAD_HEADERS, [SKILL_REPLACE_HEADER]: "yes" })),
    ).toThrow(expect.objectContaining({ code: SKILL_ERROR_CODES.ARCHIVE_INVALID }));
  });
});

describe("Skill routes", () => {
  it("requires authentication on all three surfaces", async () => {
    const app = createApp({});
    registerSkillRoutes(app, fakeService(), userAuth(), {});
    registerComputerSkillRoutes(
      app,
      {
        verifyMachineToken: async () => {
          throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Machine authentication is required", 401);
        },
      } as unknown as ComputerAuthVerifier,
      fakeService(),
    );
    registerRuntimeSkillRoutes(app, fakeService(), {
      authenticate: async () => {
        throw new SessionCliProofError("invalid_proof", "The Session CLI proof is invalid or stale");
      },
    } as unknown as Pick<SessionCliProofService, "authenticate">);

    const account = await app.inject({ method: "GET", url: AGENT_SKILLS_TEMPLATE.replace(":agentId", AGENT) });
    expect(account.statusCode).toBe(401);
    expect(account.json().error).toMatchObject({ code: "AUTH_INVALID_TOKEN", category: "credential" });

    const computer = await app.inject({
      method: "GET",
      url: COMPUTER_AGENT_SKILLS_TEMPLATE.replace(":agentId", AGENT),
    });
    expect(computer.statusCode).toBe(401);

    const runtime = await app.inject({ method: "GET", url: HTTP_PATHS.runtimeSkills });
    expect(runtime.statusCode).toBe(401);
    expect(runtime.json().error).toMatchObject({ code: "SESSION_PROOF_INVALID" });
    await app.close();
  });

  it("returns the Skill error envelope from the shared metadata", async () => {
    const app = createApp({});
    registerSkillRoutes(
      app,
      fakeService({ upload: vi.fn(async () => Promise.reject(skillNameConflict())) }),
      userAuth(),
      {},
    );
    const response = await app.inject({
      method: "POST",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", AGENT),
      headers: { authorization: "Bearer good-token", ...VALID_UPLOAD_HEADERS },
      payload: Buffer.from("abc"),
    });
    expect(response.statusCode).toBe(409);
    // The shared envelope schema must admit the Skill code; otherwise the transport would have
    // degraded this into a 500 and this parse would throw.
    const envelope = ErrorEnvelopeSchema.parse(response.json());
    expect(envelope.error).toMatchObject({
      code: SKILL_ERROR_CODES.NAME_CONFLICT,
      category: "deterministic",
      requestId: expect.any(String),
    });
    await app.close();
  });

  it("renders a revision conflict as its own 409 envelope, not a name conflict", async () => {
    const app = createApp({});
    registerSkillRoutes(
      app,
      fakeService({ setEnabled: vi.fn(async () => Promise.reject(skillRevisionConflict())) }),
      userAuth(),
      {},
    );
    const response = await app.inject({
      method: "PATCH",
      url: AGENT_SKILL_TEMPLATE.replace(":agentId", AGENT).replace(":skillId", SKILL),
      headers: { authorization: "Bearer good-token" },
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
      code: SKILL_ERROR_CODES.REVISION_CONFLICT,
      category: "deterministic",
    });
    await app.close();
  });

  it("renders a transient Skill failure through the root handler as a parsed envelope", async () => {
    const app = createApp({});
    registerSkillRoutes(
      app,
      fakeService({ openBundle: vi.fn(async () => Promise.reject(skillStorageUnavailable())) }),
      userAuth(),
      {},
    );
    const response = await app.inject({
      method: "GET",
      url: AGENT_SKILL_BUNDLE_TEMPLATE.replace(":agentId", AGENT).replace(":skillId", SKILL),
      headers: { authorization: "Bearer good-token" },
    });
    expect(response.statusCode).toBe(503);
    expect(ErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
      code: SKILL_ERROR_CODES.STORAGE_UNAVAILABLE,
      category: "transient",
    });
    await app.close();
  });

  it("passes the authenticated account and frame to the upload service", async () => {
    const upload = vi.fn(async () => detail);
    const app = createApp({});
    registerSkillRoutes(app, fakeService({ upload }), userAuth(), {});
    const response = await app.inject({
      method: "POST",
      url: AGENT_SKILLS_TEMPLATE.replace(":agentId", AGENT),
      headers: { authorization: "Bearer good-token", ...VALID_UPLOAD_HEADERS },
      payload: Buffer.from("abc"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: SKILL, name: "demo" });
    expect(upload).toHaveBeenCalledWith(
      ACCOUNT,
      AGENT,
      expect.objectContaining({ format: "tar.gz", declaredSha256: SHA, replace: false, source: "cli_upload" }),
    );
    await app.close();
  });

  it("streams a download with no-store, length, sha, and filename headers", async () => {
    const app = createApp({});
    registerSkillRoutes(app, fakeService(), userAuth(), {});
    const response = await app.inject({
      method: "GET",
      url: AGENT_SKILL_BUNDLE_TEMPLATE.replace(":agentId", AGENT).replace(":skillId", SKILL),
      headers: { authorization: "Bearer good-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toBe(SKILL_UPLOAD_CONTENT_TYPE);
    expect(response.headers["content-length"]).toBe("3");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="demo.tar.gz"');
    expect(response.headers[SKILL_SHA256_HEADER]).toBe(SHA);
    expect(response.body).toBe("abc");
    await app.close();
  });

  it("names the saved file on the computer bundle surface too", async () => {
    const app = createApp({});
    registerComputerSkillRoutes(
      app,
      {
        verifyMachineToken: async () => ({ computerId: "computer-1", credentialId: "c", installationId: "i" }),
      } as unknown as ComputerAuthVerifier,
      fakeService(),
    );
    const response = await app.inject({
      method: "GET",
      url: COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE.replace(":agentId", AGENT).replace(":skillId", SKILL),
      headers: { authorization: "Bearer machine-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="demo.tar.gz"');
    await app.close();
  });

  it("names the saved file on the runtime bundle surface too", async () => {
    const app = createApp({});
    registerRuntimeSkillRoutes(app, fakeService(), {
      authenticate: async () => ({ agentId: AGENT, computerId: "computer-1" }),
    } as unknown as Pick<SessionCliProofService, "authenticate">);
    const response = await app.inject({
      method: "GET",
      url: runtimeSkillBundlePath("demo"),
      headers: { "x-opentag-session-cli-proof": "proof" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="demo.tar.gz"');
    await app.close();
  });

  it("uploads through the agent surface as agent_upload and lists the runtime manifest", async () => {
    const uploadForAgent = vi.fn(async () => ({ ...detail, source: "agent_upload" as const }));
    const app = createApp({});
    registerRuntimeSkillRoutes(app, fakeService({ uploadForAgent }), {
      authenticate: async () => ({ agentId: AGENT, computerId: "computer-1" }),
    } as unknown as Pick<SessionCliProofService, "authenticate">);
    const uploaded = await app.inject({
      method: "POST",
      url: HTTP_PATHS.runtimeSkills,
      headers: { ...VALID_UPLOAD_HEADERS, "x-opentag-session-cli-proof": "proof" },
      payload: Buffer.from("abc"),
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ source: "agent_upload" });
    expect(uploadForAgent).toHaveBeenCalledWith(AGENT, expect.objectContaining({ declaredSha256: SHA }));

    const list = await app.inject({ method: "GET", url: HTTP_PATHS.runtimeSkills });
    expect(list.statusCode).toBe(200);
    await app.close();
  });

  it("serves the computer manifest through the runtime schema", async () => {
    const app = createApp({});
    registerComputerSkillRoutes(
      app,
      {
        verifyMachineToken: async () => ({ computerId: "computer-1", credentialId: "c", installationId: "i" }),
      } as unknown as ComputerAuthVerifier,
      fakeService(),
    );
    const response = await app.inject({
      method: "GET",
      url: COMPUTER_AGENT_SKILLS_TEMPLATE.replace(":agentId", AGENT),
      headers: { authorization: "Bearer machine-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(RuntimeSkillManifestSchema.parse(response.json())).toMatchObject({ skills: [{ id: SKILL }] });
    await app.close();
  });
});
