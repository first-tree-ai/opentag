import { SESSION_CLI_PROOF_HEADER, SKILL_ARCHIVE_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const skill = {
  name: "alpha",
  description: "Alpha skill",
  digest: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  archiveBytes: 3,
  fileCount: 1,
  totalBytes: 6,
  agentCount: 0,
  updatedAt: "2026-09-11T00:00:00.000Z",
  updatedBy: { kind: "user" as const, id: "user-1" },
};
const detail = {
  ...skill,
  manifest: {
    schemaVersion: 1 as const,
    name: "alpha",
    files: [{ path: "SKILL.md", sha256: "c".repeat(64), size: 6, mode: "0644" as const }],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function requestOf(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const call = fetchImpl.mock.calls[index] as [URL, RequestInit];
  return { url: call[0].toString(), init: call[1], headers: new Headers(call[1].headers) };
}

describe("OpenTagApi skill surface", () => {
  it("fetches the runtime skills manifest for one agent or the whole Computer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ agents: [] }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.runtimeSkillsManifest("machine", { agentId: "agent 1" })).resolves.toEqual({ agents: [] });
    expect(requestOf(fetchImpl).url).toBe("https://opentag.example.com/api/v1/runtime/skills?agentId=agent+1");
    expect(requestOf(fetchImpl).headers.get("authorization")).toBe("Bearer machine");
    await api.runtimeSkillsManifest("machine");
    expect(requestOf(fetchImpl, 1).url).toBe("https://opentag.example.com/api/v1/runtime/skills");
  });

  it("downloads a runtime archive with the conditional header and returns 304 untouched", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"abc"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4]), { status: 200, headers: { etag: 'W/"weak"' } }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    const first = await api.downloadRuntimeSkillArchive("machine", "alpha", { etag: "abc" });
    expect(first).toEqual({ status: 200, bytes: new Uint8Array([1, 2, 3]), etag: "abc" });
    expect(requestOf(fetchImpl).url).toBe("https://opentag.example.com/api/v1/runtime/skills/alpha/archive");
    expect(requestOf(fetchImpl).headers.get("if-none-match")).toBe('"abc"');
    await expect(api.downloadRuntimeSkillArchive("machine", "alpha", { etag: "abc" })).resolves.toEqual({
      status: 304,
    });
    const weak = await api.downloadRuntimeSkillArchive("machine", "alpha");
    expect(weak).toEqual({ status: 200, bytes: new Uint8Array([4]), etag: "weak" });
    expect(requestOf(fetchImpl, 2).headers.get("if-none-match")).toBeNull();
  });

  it("rejects oversized archives by declared length, streamed length, and buffered length", async () => {
    const oversized = SKILL_ARCHIVE_MAX_BYTES + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SKILL_ARCHIVE_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(1), { status: 200, headers: { "content-length": String(oversized) } }),
      )
      .mockResolvedValueOnce(new Response(stream, { status: 200 }))
      .mockResolvedValueOnce(
        json({ error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "gone" } }, 404),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    await expect(api.downloadRuntimeSkillArchive("machine", "alpha")).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_TOO_LARGE",
    });
    await expect(api.downloadRuntimeSkillArchive("machine", "alpha")).rejects.toMatchObject({
      code: "SKILL_ARCHIVE_TOO_LARGE",
    });
    await expect(api.downloadSkillArchive("access", "alpha")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    });
    await expect(api.downloadSkillArchive("access", "alpha")).resolves.toEqual({
      status: 200,
      bytes: new Uint8Array(0),
    });
    expect(requestOf(fetchImpl, 2).url).toBe("https://opentag.example.com/api/v1/skills/alpha/archive");
    expect(requestOf(fetchImpl, 2).headers.get("authorization")).toBe("Bearer access");
  });

  it("lists, reads, uploads, deletes, and assigns skills with the Account token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ skills: [skill], nextCursor: null }))
      .mockResolvedValueOnce(json({ skills: [], nextCursor: null }))
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(new Response("# alpha", { status: 200, headers: { "content-type": "text/markdown" } }))
      .mockResolvedValueOnce(json(detail, 201))
      .mockResolvedValueOnce(json(detail))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ agentId: "agent-1", digest: "d".repeat(64), skills: [skill] }))
      .mockResolvedValueOnce(json({ agentId: "agent-1", digest: "e".repeat(64), skills: [] }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);

    await expect(api.listSkills("access")).resolves.toEqual({ skills: [skill], nextCursor: null });
    expect(requestOf(fetchImpl, 0).url).toBe("https://opentag.example.com/api/v1/skills");
    await api.listSkills("access", { cursor: "c1", limit: 10 });
    expect(requestOf(fetchImpl, 1).url).toBe("https://opentag.example.com/api/v1/skills?cursor=c1&limit=10");

    await expect(api.getSkill("access", "alpha")).resolves.toEqual(detail);
    expect(requestOf(fetchImpl, 2).url).toBe("https://opentag.example.com/api/v1/skills/alpha");
    await expect(api.getSkillMarkdown("access", "alpha")).resolves.toBe("# alpha");
    expect(requestOf(fetchImpl, 3).url).toBe("https://opentag.example.com/api/v1/skills/alpha/skill-md");

    const bytes = new Uint8Array([80, 75, 5, 6]);
    await expect(api.uploadSkill("access", bytes)).resolves.toEqual(detail);
    const upload = requestOf(fetchImpl, 4);
    expect(upload.url).toBe("https://opentag.example.com/api/v1/skills");
    expect(upload.init.method).toBe("POST");
    expect(upload.headers.get("content-type")).toBe("application/zip");
    expect(new Uint8Array(await (upload.init.body as Blob).arrayBuffer())).toEqual(bytes);
    await api.uploadSkill("access", bytes, { onConflict: "replace" });
    expect(requestOf(fetchImpl, 5).url).toBe("https://opentag.example.com/api/v1/skills?onConflict=replace");

    await expect(api.deleteSkill("access", "alpha")).resolves.toBeUndefined();
    expect(requestOf(fetchImpl, 6).init.method).toBe("DELETE");
    await expect(api.getAgentSkills("access", "agent-1")).resolves.toMatchObject({ agentId: "agent-1" });
    expect(requestOf(fetchImpl, 7).url).toBe("https://opentag.example.com/api/v1/agents/agent-1/skills");
    await expect(api.replaceAgentSkills("access", "agent-1", { skillNames: [] })).resolves.toMatchObject({
      digest: "e".repeat(64),
    });
    expect(requestOf(fetchImpl, 8).init.method).toBe("PUT");
    expect(requestOf(fetchImpl, 8).init.body).toBe(JSON.stringify({ skillNames: [] }));
  });

  it("uploads a skill from inside a Session with the proof header and surfaces API errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(detail, 201))
      .mockResolvedValueOnce(
        json({ error: { code: "INTERNAL_ERROR", category: "deterministic", message: "exists" } }, 409),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const api = new OpenTagApi("https://opentag.example.com", fetchImpl);
    const bytes = new Uint8Array([1]);
    await expect(api.uploadSessionSkill("proof-token", "session-1", bytes, { onConflict: "fail" })).resolves.toEqual(
      detail,
    );
    const request = requestOf(fetchImpl, 0);
    expect(request.url).toBe("https://opentag.example.com/api/v1/runtime/sessions/session-1/skills?onConflict=fail");
    expect(request.headers.get(SESSION_CLI_PROOF_HEADER)).toBe("proof-token");
    expect(request.headers.get("authorization")).toBeNull();
    await expect(api.uploadSessionSkill("proof-token", "session-1", bytes)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 409,
      message: "exists",
    });
    const error = await api.getSkillMarkdown("access", "missing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenTagApiError);
    expect(error).toMatchObject({ status: 404 });
  });
});
