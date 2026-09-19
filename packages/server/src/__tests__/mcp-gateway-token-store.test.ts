import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MCP_GATEWAY_TOKEN_PREFIX,
  RuntimeMcpGatewayTokenStore,
  RuntimeMcpGatewayTokenStoreCapacityError,
} from "../runtime-credentials/mcp-gateway-token-store.js";

function storeAt(now: () => number, options: { maxTokens?: number; maxTtlMs?: number } = {}) {
  return new RuntimeMcpGatewayTokenStore({ now, ...options });
}

describe("issuing", () => {
  it("issues a prefixed token that resolves to its execution", () => {
    const store = storeAt(() => 1_000);
    const { token } = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(token.startsWith(MCP_GATEWAY_TOKEN_PREFIX)).toBe(true);
    expect(store.resolve(token)?.executionId).toBe("exec-1");
  });

  /*
   * The whole point of the design: a leaked config file must not be a lasting credential. The store
   * therefore holds no reversible copy of the token, only its digest.
   */
  it("retains only the token digest, never the token", () => {
    const store = storeAt(() => 1_000);
    const { token } = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    const record = store.resolve(token);
    expect(record?.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it("caps the lifetime at the store's own ceiling, not the caller's claim", () => {
    const store = storeAt(() => 1_000, { maxTtlMs: 5_000 });
    const { expiresAt } = store.issue({ executionId: "exec-1", expiresAt: Number.MAX_SAFE_INTEGER });
    expect(expiresAt).toBe(6_000);
  });

  it("honours an execution that expires sooner than the ceiling", () => {
    const store = storeAt(() => 1_000, { maxTtlMs: 60_000 });
    const { expiresAt } = store.issue({ executionId: "exec-1", expiresAt: 2_000 });
    expect(expiresAt).toBe(2_000);
  });

  /*
   * Two live tokens for one execution would double the surface a leak exposes, and would make
   * revocation ambiguous. Re-issuing replaces instead.
   */
  it("replaces an execution's previous token rather than accumulating", () => {
    const store = storeAt(() => 1_000);
    const first = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    const second = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(store.resolve(first.token)).toBeUndefined();
    expect(store.resolve(second.token)?.executionId).toBe("exec-1");
    expect(store.size).toBe(1);
  });

  it("refuses to issue past its capacity", () => {
    const store = storeAt(() => 1_000, { maxTokens: 1 });
    store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(() => store.issue({ executionId: "exec-2", expiresAt: 61_000 })).toThrow(
      RuntimeMcpGatewayTokenStoreCapacityError,
    );
  });
});

describe("resolving", () => {
  it("rejects an unknown token, a wrong prefix, and an empty string alike", () => {
    const store = storeAt(() => 1_000);
    store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(store.resolve("otmg_nope")).toBeUndefined();
    expect(store.resolve("otmc_something")).toBeUndefined();
    expect(store.resolve("")).toBeUndefined();
  });

  /*
   * Not single-use, unlike a proxy ticket: one execution makes many MCP calls over its life, so a
   * consuming read would break the second `tools/call` of every turn.
   */
  it("accepts the same token repeatedly within its life", () => {
    const store = storeAt(() => 1_000);
    const { token } = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(store.resolve(token)).toBeDefined();
    expect(store.resolve(token)).toBeDefined();
    expect(store.resolve(token)).toBeDefined();
  });

  it("stops accepting a token at its expiry and drops the record", () => {
    let clock = 1_000;
    const store = storeAt(() => clock);
    const { token } = store.issue({ executionId: "exec-1", expiresAt: 2_000 });
    clock = 2_000;
    expect(store.resolve(token)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("revocation", () => {
  /*
   * This is what makes "the token dies with the turn" true. The credential owner calls this from the
   * single point every execution ends at, so an abrupt close is covered as well as a polite one.
   */
  it("revokes an execution's token", () => {
    const store = storeAt(() => 1_000);
    const { token } = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    expect(store.revokeExecution("exec-1")).toBe(1);
    expect(store.resolve(token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("leaves other executions alone", () => {
    const store = storeAt(() => 1_000);
    const first = store.issue({ executionId: "exec-1", expiresAt: 61_000 });
    const second = store.issue({ executionId: "exec-2", expiresAt: 61_000 });
    store.revokeExecution("exec-1");
    expect(store.resolve(first.token)).toBeUndefined();
    expect(store.resolve(second.token)?.executionId).toBe("exec-2");
  });

  it("reports nothing revoked for an execution it never issued for", () => {
    const store = storeAt(() => 1_000);
    expect(store.revokeExecution("exec-absent")).toBe(0);
  });

  it("sweeps expired tokens and keeps live ones", () => {
    let clock = 1_000;
    const store = storeAt(() => clock);
    store.issue({ executionId: "exec-1", expiresAt: 2_000 });
    const live = store.issue({ executionId: "exec-2", expiresAt: 10_000 });
    clock = 3_000;
    expect(store.sweep()).toBe(1);
    expect(store.resolve(live.token)?.executionId).toBe("exec-2");
  });
});
