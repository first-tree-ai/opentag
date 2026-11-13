import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import { ProviderOperationRegistry } from "../runtime-credentials/operation-registry.js";
import { ImProviderProxyAdapter, type ProviderProxyRequest } from "../runtime-credentials/provider-proxy-adapter.js";
import { SLACK_OPERATIONS, SLACK_PASSTHROUGH } from "../runtime-credentials/slack-operations.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";

const EXECUTION = randomUUID();
const SESSION = randomUUID();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function request(overrides: Partial<ProviderProxyRequest> = {}): ProviderProxyRequest {
  return {
    executionId: EXECUTION,
    sessionId: SESSION,
    provider: "slack",
    bindingId: "binding-1",
    method: "POST",
    path: "/api/pins.add",
    headers: { "content-type": "application/json" },
    body: textBody("{}"),
    capability: "c".repeat(43),
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function* textBody(value: string): AsyncIterable<Uint8Array> {
  if (value) yield new TextEncoder().encode(value);
}

function authorization(overrides: Partial<RuntimeProxyAuthorization> = {}): RuntimeProxyAuthorization {
  return {
    executionId: EXECUTION,
    provider: "slack",
    bindingId: "binding-1",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "slack:3:7",
    credentialGeneration: "3:7",
    sessionId: SESSION,
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli: { provider: "slack", teamId: "T", botUserId: "B" },
    resolveMaterial: async () => ({ kind: "bearer", token: "real-token", origin: "https://slack.com" }),
    recheck: async () => undefined,
    ...overrides,
  };
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

interface Call {
  url: string;
  init: RequestInit;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function adapter(response: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const capture = vi.fn(async () => undefined);
  const instance = new ImProviderProxyAdapter({
    provider: "slack",
    registry: new ProviderOperationRegistry(SLACK_OPERATIONS, SLACK_PASSTHROUGH),
    urlHandles: new RuntimeUrlHandleStore(),
    fetchImpl,
    logger,
    outboundCapture: { capture },
  });
  return { instance, calls, logger, capture };
}

function bodyText(call: Call | undefined): string {
  return Buffer.from(call?.init.body as Uint8Array).toString("utf8");
}

describe("Slack passthrough registry", () => {
  const registry = new ProviderOperationRegistry(SLACK_OPERATIONS, SLACK_PASSTHROUGH);

  it("keeps explicit operations first and infers the kind of other methods", () => {
    expect(registry.match("POST", "/api/chat.postMessage")?.operation.operationId).toBe("chat.postMessage");
    expect(registry.match("POST", "/api/auth.test")?.operation.validationAllowed).toBe(true);
    for (const [method, path, kind, body] of [
      ["POST", "/api/pins.add", "write", "form"],
      ["POST", "/api/admin.conversations.create", "write", "form"],
      ["POST", "/api/conversations.setTopic", "write", "form"],
      ["POST", "/api/users.conversations", "read", "form"],
      ["POST", "/api/users.identity", "read", "form"],
      ["POST", "/api/dnd.teamInfo", "read", "form"],
      ["POST", "/api/team.billableInfo", "read", "form"],
      ["POST", "/api/team.accessLogs", "read", "form"],
      ["POST", "/api/team.integrationLogs", "read", "form"],
      ["POST", "/api/Bookmarks.List", "read", "form"],
      ["POST", "/api/Users.GetPresence", "read", "form"],
      ["POST", "/api/bookmarks.list", "read", "form"],
      ["POST", "/api/users.getPresence", "read", "form"],
      ["POST", "/api/users.lookupByEmail", "read", "form"],
      ["POST", "/api/users.profile.get", "read", "form"],
      ["POST", "/api/search.messages", "read", "form"],
      ["GET", "/api/emoji.list", "read", "none"],
    ] as const) {
      expect(registry.match(method, path)?.operation, path).toMatchObject({
        operationId: "slack.passthrough",
        kind,
        body,
        response: "auto",
        passthrough: true,
      });
    }
    expect(registry.match("POST", "/api/pins.add")?.operation.validationAllowed).toBeUndefined();
  });

  it("refuses the denylist, malformed names, other paths, and other methods", () => {
    for (const [method, path] of [
      ["POST", "/api/oauth.v2.access"],
      ["POST", "/api/oauth.access"],
      ["POST", "/api/OAuth.v2.exchange"],
      ["POST", "/api/openid.connect.token"],
      ["POST", "/api/auth.revoke"],
      ["POST", "/api/Auth.Revoke"],
      ["POST", "/api/pins"],
      ["POST", "/api/pins.add/extra"],
      ["POST", "/api/pins..add"],
      ["POST", "/api/pins.add%2e"],
      ["POST", "/api/"],
      ["POST", "/other/pins.add"],
      ["PUT", "/api/pins.add"],
      ["DELETE", "/api/pins.add"],
      // Other spellings of explicit methods.
      ["GET", "/api/chat.postMessage"],
      ["POST", "/api/Chat.PostMessage"],
      ["GET", "/api/auth.test"],
      ["POST", "/api/FILES.INFO"],
    ] as const) {
      expect(registry.match(method, path), `${method} ${path}`).toBeUndefined();
    }
    expect(new ProviderOperationRegistry(SLACK_OPERATIONS).match("POST", "/api/pins.add")).toBeUndefined();
  });
});

describe("Slack passthrough adapter", () => {
  it("forwards JSON write input as a form without the caller token, classifies it, and skips capture", async () => {
    const { instance, calls, logger, capture } = adapter(() => json({ ok: true }));
    const response = await instance.handle(
      request({ body: textBody('{"channel":"C1","timestamp":"1.2","token":"otrh_local"}') }),
      authorization(),
    );
    expect(JSON.parse(await readBody(response.body))).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://slack.com/api/pins.add");
    expect(bodyText(calls[0])).toBe("channel=C1&timestamp=1.2");
    expect(calls[0]?.init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer real-token" });
    expect(capture).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { code: "PROVIDER_PROXY_PASSTHROUGH", provider: "slack", method: "POST", path: "/api/pins.add" },
      "Provider proxy passthrough request",
    );
  });

  it("sends form-only reads outside the verb list as forms", async () => {
    const { instance, calls } = adapter(() => json({ ok: true, channels: [] }));
    await instance.handle(
      request({
        path: "/api/users.conversations",
        body: textBody('{"types":"private_channel","limit":1,"cursor":"next-page"}'),
      }),
      authorization(),
    );
    expect(bodyText(calls[0])).toBe("types=private_channel&limit=1&cursor=next-page");
    expect(calls[0]?.init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
  });

  it("serializes structured JSON values as form fields for writes", async () => {
    const { instance, calls } = adapter(() => json({ ok: true }));
    await instance.handle(
      request({ path: "/api/chat.postEphemeral", body: textBody('{"channel":"C1","blocks":[{"type":"divider"}]}') }),
      authorization(),
    );
    expect(new URLSearchParams(bodyText(calls[0])).get("blocks")).toBe('[{"type":"divider"}]');
  });

  it("relays Slack rejections and reports unconfirmed writes as unknown", async () => {
    const rejected = adapter(() => json({ ok: false, error: "missing_scope" }));
    const relayed = await rejected.instance.handle(request(), authorization());
    expect(JSON.parse(await readBody(relayed.body))).toEqual({ ok: false, error: "missing_scope" });
    for (const response of [() => json({ ok: true }, 503), () => json({})]) {
      const { instance } = adapter(response);
      await expect(instance.handle(request(), authorization())).rejects.toMatchObject({
        code: "write_outcome_unknown",
      });
    }
  });

  it("sends reads as forms and rewrites protected file URLs", async () => {
    const { instance, calls } = adapter(() =>
      json({ ok: true, items: [{ file: { url_private: "https://files.slack.com/files-pri/T-F/a.png" } }] }),
    );
    const response = await instance.handle(
      request({ path: "/api/pins.list", body: textBody('{"channel":"C1"}') }),
      authorization(),
    );
    expect(bodyText(calls[0])).toBe("channel=C1");
    expect(calls[0]?.init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
    const payload = JSON.parse(await readBody(response.body));
    expect(payload.items[0].file.url_private).toMatch(/^https:\/\/slack\.com\/__opentag__\/handles\//);
  });

  it("forwards GET reads with their query and refuses query credentials and multipart bodies", async () => {
    const { instance, calls } = adapter(() => json({ ok: true, emoji: {} }));
    await instance.handle(
      request({ method: "GET", path: "/api/emoji.list?include_categories=true", headers: {}, body: textBody("") }),
      authorization(),
    );
    expect(calls[0]?.url).toBe("https://slack.com/api/emoji.list?include_categories=true");
    expect(calls[0]?.init.method).toBe("GET");
    await expect(
      instance.handle(
        request({ method: "GET", path: "/api/emoji.list?token=otrh_local", headers: {}, body: textBody("") }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code: "body_invalid" });
    await expect(
      instance.handle(
        request({ headers: { "content-type": "multipart/form-data; boundary=x" }, body: textBody("--x--") }),
        authorization(),
      ),
    ).rejects.toMatchObject({ code: "body_invalid" });
    await expect(
      instance.handle(request({ path: "/api/oauth.v2.access", headers: FORM }), authorization()),
    ).rejects.toMatchObject({ code: "operation_not_registered" });
    await expect(instance.handle(request(), authorization({ purpose: "validation" }))).rejects.toMatchObject({
      code: "validation_scope",
    });
    expect(calls).toHaveLength(1);
  });
});
