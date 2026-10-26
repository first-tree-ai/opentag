import { describe, expect, it, vi } from "vitest";
import { contextTreePushBody } from "../services/github-proxy/git-packets.js";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { body, bytes, proxyAuthorization, proxyRequest } from "./support/github-proxy-fixture.js";

const sha = "1".repeat(40);
function packet(command: string) {
  return `${(Buffer.byteLength(command) + 4).toString(16).padStart(4, "0")}${command}`;
}
function update(ref = "refs/heads/main", next = sha) {
  return packet(`${sha} ${next} ${ref}\0report-status side-band-64k\n`);
}

describe("Context Tree Git scope", () => {
  it("preserves a fragmented single-branch push and its pack bytes", async () => {
    const input = Buffer.concat([Buffer.from(`${update()}0000`), Buffer.alloc(200000, 65)]);
    async function* chunks() {
      yield input.subarray(0, 6);
      yield input.subarray(6, 40);
      yield input.subarray(40);
    }
    expect(await bytes(await contextTreePushBody(chunks(), "main"))).toEqual(input);
  });
  it.each([
    `${update("refs/heads/other")}0000`,
    `${update("refs/tags/tag")}0000`,
    `${update("refs/heads/main", "0".repeat(40))}0000`,
    `${update()}${update()}0000`,
    "0000",
    "0001",
    "ffffbad",
    "invalid",
    "0008bad!0000",
  ])("rejects malformed, deleted, multiple, or foreign ref updates before forwarding", async (input) => {
    await expect(contextTreePushBody(body(input), "main")).rejects.toBeDefined();
  });
  it("closes the source on rejection", async () => {
    const closed = vi.fn();
    async function* source() {
      try {
        yield Buffer.from(`${update("refs/heads/other")}0000`);
      } finally {
        closed();
      }
    }
    await expect(contextTreePushBody(source(), "main")).rejects.toBeDefined();
    expect(closed).toHaveBeenCalledOnce();
  });
  it("allows selected repository Git reads and rejects REST and other repositories without opening credentials", async () => {
    const auth = {
      ...proxyAuthorization(),
      purpose: "context-tree" as const,
      contextTree: {
        kind: "git" as const,
        repository: "team/code",
        path: "docs",
        ref: "main",
        parentExecutionId: "parent",
      },
    };
    const credential = vi.fn(async () => null);
    const transport = { request: vi.fn(async () => ({ status: 200, headers: {}, body: body("ok") })) };
    const adapter = new GitHubProviderAdapter({ management: { getExecutionUserCredential: credential }, transport });
    for (const request of [
      proxyRequest(auth),
      proxyRequest(auth, {
        path: "/team/other.git/info/refs?service=git-upload-pack",
        headers: { "x-opentag-provider-origin": "github.com" },
      }),
    ])
      await expect(adapter.handle(request, auth)).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      adapter.handle(
        proxyRequest(auth, {
          method: "POST",
          path: "/team/code.git/git%2dreceive-pack",
          headers: { "x-opentag-provider-origin": "github.com" },
        }),
        auth,
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(credential).not.toHaveBeenCalled();
    await expect(
      adapter.handle(
        proxyRequest(auth, {
          path: "/team/code.git/info/refs?service=git-upload-pack",
          headers: { "x-opentag-provider-origin": "github.com" },
        }),
        auth,
      ),
    ).rejects.toMatchObject({ code: "github_credential_unavailable" });
    expect(credential).toHaveBeenCalledOnce();
    expect(transport.request).not.toHaveBeenCalled();
  });
});
