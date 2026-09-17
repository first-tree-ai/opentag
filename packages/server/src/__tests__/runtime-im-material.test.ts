import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { imBindings, slackInstallations } from "../db/schema/index.js";
import type { FeishuTenantToken, FeishuTenantTokenCache } from "../runtime-credentials/feishu-tenant-token.js";
import { ImProviderMaterialResolver } from "../runtime-credentials/im-material.js";
import { type RuntimeProviderMaterialInput, SLACK_FIXED_ORIGIN } from "../runtime-credentials/provider-material.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  feishuBindingCredentialContext,
  slackInstallationCredentialContext,
} from "../services/im-bindings/credential-material.js";

const BINDING = "00000000-0000-4000-8000-0000000000b1";
const INSTALLATION = "00000000-0000-4000-8000-0000000000d1";
const AGENT = "agent-1";
const EXECUTION = "00000000-0000-4000-8000-0000000000e1";
const FEISHU_ORIGIN = "https://open.feishu.cn";
const LARK_ORIGIN = "https://open.larksuite.com";

// Ephemeral in-process key: the real cipher exercises decryption without any platform token.
const cipher = new ApplicationCipher(Buffer.alloc(32, 9));

interface StubDatabase {
  readonly database: DatabaseClient;
  readonly selects: () => number;
}

/**
 * Query stub returning the active-row result the resolver's SQL query would produce. The
 * provider/status/owner predicates themselves are verified by the PostgreSQL integration suite.
 */
function stubDatabase(
  rows: { bindings?: readonly Record<string, unknown>[]; installations?: readonly Record<string, unknown>[] } = {},
): StubDatabase {
  let selects = 0;
  const resultFor = (table: unknown): readonly Record<string, unknown>[] => {
    if (table === imBindings) return rows.bindings ?? [];
    if (table === slackInstallations) return rows.installations ?? [];
    throw new Error("Unexpected table in the IM provider material query");
  };
  const database = {
    select() {
      selects += 1;
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        limit: () => Promise.resolve(resultFor(table)),
        where: () => query,
      };
      return query;
    },
  };
  return { database: database as unknown as DatabaseClient, selects: () => selects };
}

function tenantTokens(result: FeishuTenantToken | Error = { expiresAt: 1_800_000_000_000, token: "tenant-token" }) {
  const get = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { cache: { get } as unknown as FeishuTenantTokenCache, get };
}

function resolver(database: DatabaseClient, cache: FeishuTenantTokenCache = tenantTokens().cache) {
  return new ImProviderMaterialResolver({ cipher, database, tenantTokens: cache });
}

function materialInput(overrides: Partial<RuntimeProviderMaterialInput> = {}): RuntimeProviderMaterialInput {
  return {
    accountId: "account-1",
    agentId: AGENT,
    bindingId: BINDING,
    credentialGeneration: "1",
    executionId: EXECUTION,
    provider: "feishu",
    ...overrides,
  };
}

function feishuBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const encryptedCredential = cipher.encryptBound(
    JSON.stringify({ appId: "cli_app", appSecret: "app-secret", grantedScopes: [] }),
    feishuBindingCredentialContext(BINDING),
  );
  return {
    id: BINDING,
    credentialGeneration: 1,
    encryptedCredential: encryptedCredential.ciphertext,
    externalAppId: "cli_app",
    externalTeamBrand: "feishu",
    ...overrides,
  };
}

function slackBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: BINDING, agentId: AGENT, credentialGeneration: 1, slackInstallationId: INSTALLATION, ...overrides };
}

function slackInstallation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const encryptedCredential = cipher.encryptBound(
    JSON.stringify({ botAccessToken: "xoxb-test-token", botId: "B1", grantedScopes: [], signingSecret: "signing" }),
    slackInstallationCredentialContext(INSTALLATION),
  );
  return {
    id: INSTALLATION,
    agentId: AGENT,
    credentialGeneration: 4,
    encryptedCredential: encryptedCredential.ciphertext,
    ...overrides,
  };
}

describe("ImProviderMaterialResolver Feishu material", () => {
  it("exchanges the tenant token for a current binding at the fixed Feishu origin", async () => {
    const binding = feishuBinding();
    const { cache, get } = tenantTokens();
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, cache);
    const signal = new AbortController().signal;

    await expect(subject.resolve(materialInput({ signal }))).resolves.toEqual({
      expiresAt: 1_800_000_000_000,
      kind: "bearer",
      origin: FEISHU_ORIGIN,
      token: "tenant-token",
    });
    expect(get).toHaveBeenCalledWith({
      appId: "cli_app",
      appSecret: "app-secret",
      bindingId: BINDING,
      brand: "feishu",
      credentialGeneration: 1,
      origin: FEISHU_ORIGIN,
      signal,
    });
  });

  it("uses the Lark origin for a Lark brand binding", async () => {
    const binding = feishuBinding({ externalTeamBrand: "lark" });
    const { cache, get } = tenantTokens({ expiresAt: 1_800_000_000_001, token: "lark-token" });
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, cache);

    await expect(subject.resolve(materialInput())).resolves.toEqual({
      expiresAt: 1_800_000_000_001,
      kind: "bearer",
      origin: LARK_ORIGIN,
      token: "lark-token",
    });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ brand: "lark", origin: LARK_ORIGIN }));
  });

  it("resolves nothing when the binding is missing or inactive (no active row returned)", async () => {
    const { cache, get } = tenantTokens();
    const subject = resolver(stubDatabase({ bindings: [] }).database, cache);

    await expect(subject.resolve(materialInput())).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("resolves nothing when the binding generation no longer matches the capability pin", async () => {
    const binding = feishuBinding({ credentialGeneration: 2 });
    const { cache, get } = tenantTokens();
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, cache);

    await expect(subject.resolve(materialInput({ credentialGeneration: "1" }))).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("resolves nothing when the stored credential cannot be opened", async () => {
    const binding = feishuBinding({ encryptedCredential: "not-a-valid-envelope" });
    const { cache, get } = tenantTokens();
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, cache);

    await expect(subject.resolve(materialInput())).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("resolves nothing when the credential app id disagrees with the binding identity", async () => {
    const binding = feishuBinding({ externalAppId: "cli_other" });
    const { cache, get } = tenantTokens();
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, cache);

    await expect(subject.resolve(materialInput())).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("propagates a tenant token exchange failure instead of silently dropping material", async () => {
    const binding = feishuBinding();
    const failure = new Error("tenant token exchange failed");
    const subject = resolver(stubDatabase({ bindings: [binding] }).database, tenantTokens(failure).cache);

    await expect(subject.resolve(materialInput())).rejects.toBe(failure);
  });
});

describe("ImProviderMaterialResolver Slack material", () => {
  it("returns the installation bot token after matching both generation pins", async () => {
    const subject = resolver(
      stubDatabase({ bindings: [slackBinding()], installations: [slackInstallation()] }).database,
    );

    await expect(subject.resolve(materialInput({ provider: "slack", credentialGeneration: "1:4" }))).resolves.toEqual({
      kind: "bearer",
      origin: SLACK_FIXED_ORIGIN,
      token: "xoxb-test-token",
    });
  });

  it("resolves nothing when the Slack binding is missing", async () => {
    const stub = stubDatabase({ bindings: [], installations: [slackInstallation()] });
    const subject = resolver(stub.database);

    await expect(subject.resolve(materialInput({ provider: "slack" }))).resolves.toBeUndefined();
    expect(stub.selects()).toBe(1);
  });

  it("resolves nothing when the binding has no installation to read credentials from", async () => {
    const stub = stubDatabase({ bindings: [slackBinding({ slackInstallationId: null })], installations: [] });
    const subject = resolver(stub.database);

    await expect(subject.resolve(materialInput({ provider: "slack" }))).resolves.toBeUndefined();
    expect(stub.selects()).toBe(1);
  });

  it("resolves nothing when the referenced installation is missing or inactive", async () => {
    const subject = resolver(stubDatabase({ bindings: [slackBinding()], installations: [] }).database);

    await expect(subject.resolve(materialInput({ provider: "slack" }))).resolves.toBeUndefined();
  });

  it("resolves nothing when the installation belongs to another agent", async () => {
    const subject = resolver(
      stubDatabase({
        bindings: [slackBinding()],
        installations: [slackInstallation({ agentId: "agent-foreign" })],
      }).database,
    );

    await expect(subject.resolve(materialInput({ provider: "slack" }))).resolves.toBeUndefined();
  });

  it("resolves nothing when the binding or installation generation no longer matches the pin", async () => {
    const subject = resolver(
      stubDatabase({ bindings: [slackBinding()], installations: [slackInstallation()] }).database,
    );

    await expect(
      subject.resolve(materialInput({ provider: "slack", credentialGeneration: "1:3" })),
    ).resolves.toBeUndefined();
  });

  it("resolves nothing when the installation credential cannot be opened", async () => {
    const subject = resolver(
      stubDatabase({
        bindings: [slackBinding()],
        installations: [slackInstallation({ encryptedCredential: null })],
      }).database,
    );

    await expect(
      subject.resolve(materialInput({ provider: "slack", credentialGeneration: "1:4" })),
    ).resolves.toBeUndefined();
  });

  it("resolves nothing for a provider without IM material", async () => {
    const stub = stubDatabase();
    const subject = resolver(stub.database);

    await expect(subject.resolve(materialInput({ provider: "github" }))).resolves.toBeUndefined();
    expect(stub.selects()).toBe(0);
  });
});
