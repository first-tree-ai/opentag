import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApplicationCipher } from "../services/crypto.js";
import {
  authorizationAadContext,
  McpCredentialCipher,
  registrationAadContext,
} from "../services/mcp/mcp-credential-cipher.js";

/**
 * The AAD contract, asserted as properties rather than as a string:
 *
 * - Changing the binding (a different Agent, a different authorization server) must fail to open.
 * - The context's *shape* is pinned, so a later field reordering cannot silently make every stored
 *   ciphertext unopenable — the failure mode a `JSON.stringify([...])` context would have.
 * - `kind` and the header configuration are deliberately absent, because changing them is an edit to
 *   an existing row and must not invalidate a key the user already stored.
 */

const SERVER = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";
const AGENT = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const OTHER_AGENT = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
const ACCOUNT = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const AS = "https://auth.example.com";
const OTHER_AS = "https://other.example.com";

function cipher() {
  return new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
}

describe("MCP authorization AAD", () => {
  it("pins the format so a field reordering is a compile-time-visible change", () => {
    // The exact string is the contract: reordering these fields in the implementation would break
    // every stored ciphertext, and this assertion is what makes that impossible to do silently.
    expect(authorizationAadContext({ mcpServerId: SERVER, agentId: AGENT, authorizationServer: AS })).toBe(
      `mcp-authorization|${SERVER}|${AGENT}|${encodeURIComponent(AS)}`,
    );
  });

  it("renders a null authorization server as an empty field rather than dropping it", () => {
    expect(authorizationAadContext({ mcpServerId: SERVER, agentId: AGENT, authorizationServer: null })).toBe(
      `mcp-authorization|${SERVER}|${AGENT}|`,
    );
  });

  it("keeps a separator unambiguous when a value contains the separator", () => {
    const context = authorizationAadContext({
      mcpServerId: SERVER,
      agentId: AGENT,
      authorizationServer: "https://a|b.example.com",
    });
    expect(context.endsWith(`|${encodeURIComponent("https://a|b.example.com")}`)).toBe(true);
    expect(context.split("|")).toHaveLength(4);
  });

  it("uses a separate domain for the registration envelope", () => {
    expect(registrationAadContext({ accountId: ACCOUNT, authorizationServer: AS })).toBe(
      `mcp-client-registration|${ACCOUNT}|${encodeURIComponent(AS)}`,
    );
  });
});

describe("McpCredentialCipher", () => {
  const binding = { mcpServerId: SERVER, agentId: AGENT, authorizationServer: AS };

  it("round-trips an authorization credential", () => {
    const store = cipher();
    const sealed = store.encryptAuthorizationCredential(binding, {
      accessToken: "at_123",
      refreshToken: "rt_456",
      tokenType: "Bearer",
    });
    expect(sealed.ciphertext.startsWith(`v2.${sealed.keyId}.`)).toBe(true);
    expect(store.decryptAuthorizationCredential(binding, sealed)).toEqual({
      accessToken: "at_123",
      refreshToken: "rt_456",
      tokenType: "Bearer",
    });
  });

  it("fails to open a credential presented under a different Agent", () => {
    const store = cipher();
    const sealed = store.encryptAuthorizationCredential(binding, { accessToken: "at_123" });
    // A credential lifted onto another Agent's row must not be usable: that would be a cross-Agent
    // credential replay, which is exactly what the per-Agent design exists to prevent.
    expect(() => store.decryptAuthorizationCredential({ ...binding, agentId: OTHER_AGENT }, sealed)).toThrow();
  });

  it("fails to open a credential presented under a different authorization server", () => {
    const store = cipher();
    const sealed = store.encryptAuthorizationCredential(binding, { accessToken: "at_123" });
    expect(() => store.decryptAuthorizationCredential({ ...binding, authorizationServer: OTHER_AS }, sealed)).toThrow();
  });

  it("fails to open a registration secret presented as an authorization credential", () => {
    const store = cipher();
    const sealed = store.encryptClientSecret({ accountId: ACCOUNT, authorizationServer: AS }, "cs_123");
    // The two envelopes carry different domains, so a ciphertext cannot move between them.
    expect(() => store.decryptAuthorizationCredential(binding, sealed)).toThrow();
  });

  it("round-trips a PKCE verifier without exposing it in the ciphertext", () => {
    const store = cipher();
    const sealed = store.encryptPkceVerifier(binding, "verifier_value_that_is_long_enough_to_be_a_real_pkce_verifier");
    expect(sealed.ciphertext).not.toContain("verifier_value");
    expect(store.decryptPkceVerifier(binding, sealed)).toBe(
      "verifier_value_that_is_long_enough_to_be_a_real_pkce_verifier",
    );
  });

  it("rejects a ciphertext with a foreign envelope prefix", () => {
    const store = cipher();
    expect(() =>
      store.decryptAuthorizationCredential(binding, { ciphertext: "v1.abc.def.ghi", keyId: "default" }),
    ).toThrow();
  });
});

/**
 * The property the `kind` column depends on: changing an authorization's kind is an UPSERT into the
 * same row, so the AAD must not include the kind or the new credential could not be opened by the
 * write that just replaced the old one. This simulates the two writes and checks the second opens.
 */
describe("a kind change does not strand a credential", () => {
  const binding = { mcpServerId: SERVER, agentId: AGENT, authorizationServer: null };

  it("opens a bearer key written after the row was anonymous, and an OAuth token after that", () => {
    const store = cipher();
    // `none` writes no credential at all, so there is nothing to strand.
    expect(authorizationAadContext(binding)).toBe(`mcp-authorization|${SERVER}|${AGENT}|`);

    const bearer = store.encryptAuthorizationCredential(binding, { accessToken: "bearer_key" });
    expect(store.decryptAuthorizationCredential(binding, bearer)).toEqual({ accessToken: "bearer_key" });

    // The same row is overwritten with an OAuth envelope; the previous ciphertext is gone, and the
    // new one opens under the identical context because the context never named the kind.
    const oauth = store.encryptAuthorizationCredential(
      { ...binding, authorizationServer: AS },
      { accessToken: "at_123", refreshToken: "rt_456" },
    );
    expect(store.decryptAuthorizationCredential({ ...binding, authorizationServer: AS }, oauth)).toEqual({
      accessToken: "at_123",
      refreshToken: "rt_456",
    });
  });
});
