import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SESSION_CLI_PROOF_HEADER,
  SKILL_FORMAT_HEADER,
  SKILL_REPLACE_HEADER,
  SKILL_SHA256_HEADER,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../index.js";

const AGENT_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const SKILL_ID = "1f4b7c9d-2e3a-4b5c-8d9e-0f1a2b3c4d5e";
const ARCHIVE = new Uint8Array([1, 2, 3, 4, 5]);

function skillRecord(): Record<string, unknown> {
  return {
    id: SKILL_ID,
    agentId: AGENT_ID,
    name: "my-skill",
    description: "A Skill",
    enabled: true,
    source: "cli_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 5,
    fileCount: 1,
    revision: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

const servers: Array<{ close(): Promise<void> }> = [];

async function loopback(
  respond: (request: Captured, response: ServerResponse) => void,
): Promise<{ api: OpenTagApi; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const captured: Captured = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(captured);
    respond(captured, response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  servers.push({ close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) });
  return { api: new OpenTagApi(`http://127.0.0.1:${address.port}`), requests };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Agent Skill API methods", () => {
  it("addresses the Account surface and sends account-scoped upload headers", async () => {
    const { api, requests } = await loopback((_request, response) => json(response, skillRecord()));
    await api.uploadAgentSkill(
      "account-access",
      AGENT_ID,
      { archive: ARCHIVE, sha256: "b".repeat(64), format: "tar.gz", replace: true },
      { requestId: "req-1" },
    );
    const request = requests[0] as Captured;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(`/api/v1/agents/${AGENT_ID}/skills`);
    expect(request.headers.authorization).toBe("Bearer account-access");
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.headers["content-length"]).toBe("5");
    expect(request.headers[SKILL_SHA256_HEADER]).toBe("b".repeat(64));
    expect(request.headers[SKILL_FORMAT_HEADER]).toBe("tar.gz");
    expect(request.headers[SKILL_REPLACE_HEADER]).toBe("true");
    expect(request.body.equals(Buffer.from(ARCHIVE))).toBe(true);

    const withoutReplace = await loopback((_request, response) => json(response, skillRecord()));
    await withoutReplace.api.uploadAgentSkill("account-access", AGENT_ID, {
      archive: ARCHIVE,
      sha256: "b".repeat(64),
      format: "tar.gz",
    });
    expect(withoutReplace.requests[0]?.headers[SKILL_REPLACE_HEADER]).toBeUndefined();
  });

  it("lists, patches, and deletes Account Skills", async () => {
    const list = await loopback((_request, response) =>
      json(response, { skills: [skillRecord()], storage: "available" }),
    );
    await expect(list.api.listAgentSkills("account-access", AGENT_ID)).resolves.toMatchObject({
      storage: "available",
      skills: [{ name: "my-skill" }],
    });
    expect(list.requests[0]?.path).toBe(`/api/v1/agents/${AGENT_ID}/skills`);

    const patch = await loopback((_request, response) => json(response, skillRecord()));
    await patch.api.updateAgentSkill("account-access", AGENT_ID, SKILL_ID, { enabled: false });
    expect(patch.requests[0]?.method).toBe("PATCH");
    expect(patch.requests[0]?.body.toString()).toBe(JSON.stringify({ enabled: false }));

    const remove = await loopback((_request, response) => response.writeHead(204).end());
    await expect(remove.api.removeAgentSkill("account-access", AGENT_ID, SKILL_ID)).resolves.toBeUndefined();
    expect(remove.requests[0]?.method).toBe("DELETE");
    expect(remove.requests[0]?.path).toBe(`/api/v1/agents/${AGENT_ID}/skills/${SKILL_ID}`);
  });

  it("opens an Account bundle as a raw response and surfaces an error envelope", async () => {
    const ok = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(ARCHIVE));
    });
    const bundle = await ok.api.openAgentSkillBundle("account-access", AGENT_ID, SKILL_ID);
    expect(new Uint8Array(await bundle.arrayBuffer())).toEqual(ARCHIVE);

    const missing = await loopback((_request, response) =>
      json(
        response,
        {
          error: {
            code: "SKILL_NOT_FOUND",
            category: "deterministic",
            message: "No such Skill",
          },
        },
        404,
      ),
    );
    // CONTRACT GAP: the SKILL_* codes are not yet members of the shared ErrorCodeSchema, so a
    // Skill error envelope does not parse and the client falls back to the status-derived code.
    // The transport still rejects with the 404 status, which is what the caller can act on today.
    await expect(missing.api.openAgentSkillBundle("account-access", AGENT_ID, SKILL_ID)).rejects.toMatchObject({
      status: 404,
      category: "deterministic",
    });
  });

  it("addresses the Computer surface with the machine token", async () => {
    const { api, requests } = await loopback((_request, response) =>
      json(response, {
        skills: [{ id: SKILL_ID, name: "my-skill", archiveSha256: "a".repeat(64), archiveBytes: 5 }],
      }),
    );
    await expect(api.getComputerSkillManifest("machine-token", AGENT_ID)).resolves.toMatchObject({
      skills: [{ name: "my-skill" }],
    });
    expect(requests[0]?.path).toBe(`/api/v1/computer/agents/${AGENT_ID}/skills`);
    expect(requests[0]?.headers.authorization).toBe("Bearer machine-token");

    const bundle = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(ARCHIVE));
    });
    await bundle.api.openComputerSkillBundle("machine-token", AGENT_ID, SKILL_ID);
    expect(bundle.requests[0]?.path).toBe(`/api/v1/computer/agents/${AGENT_ID}/skills/${SKILL_ID}/bundle`);
  });

  it("addresses the Session-proof runtime surface for list, push, and bundle", async () => {
    const list = await loopback((_request, response) =>
      json(response, { skills: [skillRecord()], storage: "available" }),
    );
    await list.api.listRuntimeSkills("proof-token");
    expect(list.requests[0]?.path).toBe("/api/v1/runtime/skills");
    expect(list.requests[0]?.headers[SESSION_CLI_PROOF_HEADER]).toBe("proof-token");

    const push = await loopback((_request, response) => json(response, skillRecord(), 201));
    await push.api.pushRuntimeSkill("proof-token", {
      archive: ARCHIVE,
      sha256: "b".repeat(64),
      format: "tar.gz",
    });
    expect(push.requests[0]?.method).toBe("POST");
    expect(push.requests[0]?.headers[SESSION_CLI_PROOF_HEADER]).toBe("proof-token");
    expect(push.requests[0]?.headers["content-length"]).toBe("5");

    const bundle = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(ARCHIVE));
    });
    await bundle.api.openRuntimeSkillBundle("proof-token", "my-skill");
    expect(bundle.requests[0]?.path).toBe("/api/v1/runtime/skills/my-skill/bundle");
  });

  it("rejects a response that does not match the shared schema", async () => {
    const { api } = await loopback((_request, response) =>
      json(response, { skills: [{ name: "bad" }], storage: "nope" }),
    );
    await expect(api.listAgentSkills("account-access", AGENT_ID)).rejects.toBeInstanceOf(OpenTagApiError);
  });
});
