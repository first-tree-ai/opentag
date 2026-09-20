import type { OpenTagApi } from "@opentag/client";
import * as client from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpApiClient } from "../core/mcp/shared.js";
import type { SkillApiClient } from "../core/skill/shared.js";

/**
 * The "the context did not resolve an authenticated API" guards are unreachable through a real
 * `resolveCommandContext`: with `requireAuth: true` it either returns both halves or throws its own
 * login error first. So the command-context module is mocked here, which is the only way to drive
 * those guards without editing the sources they live in.
 */
vi.mock("../core/command/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/command/context.js")>();
  return { ...actual, resolveCommandContext: vi.fn() };
});
vi.mock("@opentag/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentag/client")>();
  return { ...actual, readSessionCliProofFile: vi.fn() };
});

const { resolveCommandContext } = await import("../core/command/context.js");
const { resolveMcpCommandContext } = await import("../core/mcp/shared.js");
const { resolveSkillCommandContext } = await import("../core/skill/context.js");
const { runSkillPull } = await import("../core/skill/operations.js");

const mockedContext = vi.mocked(resolveCommandContext);

afterEach(() => {
  mockedContext.mockReset();
});

describe("resolveMcpCommandContext", () => {
  it("refuses an authenticated API that the command context did not produce", async () => {
    mockedContext.mockResolvedValue({ environment: {}, home: "/home/user" });
    await expect(
      resolveMcpCommandContext({ api: {} as McpApiClient, accessToken: "fixture-account-access" }),
    ).rejects.toThrow("Command context did not resolve an authenticated API");
  });

  it("passes an injected client and token straight through", async () => {
    const api = {} as McpApiClient;
    mockedContext.mockResolvedValue({
      api: api as unknown as OpenTagApi,
      accessToken: "fixture-account-access",
      environment: {},
      home: "/home/user",
    });
    await expect(resolveMcpCommandContext({ api, accessToken: "fixture-account-access" })).resolves.toEqual({
      api,
      accessToken: "fixture-account-access",
    });
    expect(mockedContext).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fixture-account-access", requireAuth: true }),
    );
  });
});

describe("resolveSkillCommandContext inside a Session", () => {
  it("resolves the Agent's own authority from the proof file when only a proof path was given", async () => {
    const api = { listRuntimeSkills: vi.fn() } as unknown as OpenTagApi;
    mockedContext.mockResolvedValue({ api, environment: {}, home: "/home/user" });
    vi.mocked(client.readSessionCliProofFile).mockResolvedValue({
      proofId: "11111111-1111-4111-8111-111111111111",
      token: "p".repeat(40),
    });

    const authority = await resolveSkillCommandContext("push", {
      api: api as unknown as SkillApiClient,
      environment: {
        OPENTAG_SESSION_PROOF_FILE: "/tmp/proof.json",
        OPENTAG_SESSION_SERVER_URL: "https://opentag.example",
      },
    });
    expect(authority).toMatchObject({ mode: "agent", proof: "p".repeat(40) });
    expect(client.readSessionCliProofFile).toHaveBeenCalledWith("/tmp/proof.json");
  });
});

describe("Session proof resolution with no injected environment", () => {
  it("falls back to the process environment when the caller injected none", async () => {
    const api = { listRuntimeSkills: vi.fn() } as unknown as OpenTagApi;
    mockedContext.mockResolvedValue({ api, environment: {}, home: "/home/user" });
    vi.mocked(client.readSessionCliProofFile).mockResolvedValue({
      proofId: "11111111-1111-4111-8111-111111111111",
      token: "p".repeat(40),
    });
    const previousProof = process.env.OPENTAG_SESSION_PROOF_FILE;
    const previousUrl = process.env.OPENTAG_SESSION_SERVER_URL;
    process.env.OPENTAG_SESSION_PROOF_FILE = "/tmp/proof.json";
    // The Cloud Session endpoint short-circuits the Computer-identity read, so the fallback can be
    // driven without a Computer binding on disk.
    process.env.OPENTAG_SESSION_SERVER_URL = "https://opentag.example";
    try {
      const authority = await resolveSkillCommandContext("list", { proof: "p".repeat(40) });
      expect(authority).toMatchObject({ mode: "agent", proof: "p".repeat(40) });
      expect(client.readSessionCliProofFile).toHaveBeenCalledWith("/tmp/proof.json");
    } finally {
      if (previousProof === undefined) delete process.env.OPENTAG_SESSION_PROOF_FILE;
      else process.env.OPENTAG_SESSION_PROOF_FILE = previousProof;
      if (previousUrl === undefined) delete process.env.OPENTAG_SESSION_SERVER_URL;
      else process.env.OPENTAG_SESSION_SERVER_URL = previousUrl;
    }
  });
});

describe("account authority", () => {
  it("refuses an operator context that resolved without an API", async () => {
    mockedContext.mockResolvedValue({ environment: {}, home: "/home/user" });
    await expect(
      resolveSkillCommandContext("list", {
        accessToken: "fixture-account-access",
        agentId: "agent-a",
        api: {} as SkillApiClient,
        environment: {},
      }),
    ).rejects.toThrow("Command context did not resolve an authenticated API");
  });
});

describe("resolveSkill inside a Session", () => {
  it("refuses a name the Agent's own Skill list does not contain", async () => {
    const api = {
      listRuntimeSkills: vi.fn(async () => ({ skills: [], storage: "available" as const })),
    } as unknown as SkillApiClient;
    await expect(runSkillPull("missing", {}, { api, proof: "p".repeat(32) })).rejects.toThrow(
      'No Skill named or identified by "missing"',
    );
  });
});
