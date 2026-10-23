import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { FeishuClient, FeishuError } from "../src/feishu.ts";
import { relayServer } from "../src/server.ts";
import { config, payload, testFeishu } from "./support.ts";

test("HTTP rejects unauthorized, malformed, oversized and unlisted notifications without effects", async () => {
  const feishu = testFeishu();
  const server = relayServer(config, feishu, () => undefined).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  try {
    const unauthorized = await fetch(`${url}/monitoring`, { method: "POST", body: JSON.stringify(payload()) });
    assert.equal(unauthorized.status, 401);
    assert.ok(unauthorized.headers.get("www-authenticate"));
    for (const body of [
      "{",
      JSON.stringify({ ...payload(), version: "0.1" }),
      JSON.stringify({ value: "x".repeat(70_000) }),
    ]) {
      assert.equal((await fetch(`${url}/monitoring`, { method: "POST", headers, body })).status, 400);
    }
    assert.equal(
      (await fetch(`${url}/monitoring`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" } }))
        .status,
      415,
    );
    assert.deepEqual(feishu.calls, { messages: 0, sms: 0 });
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/readyz`, { headers })).status, 200);
    assert.equal(
      (await fetch(`${url}/monitoring`, { method: "POST", headers, body: JSON.stringify(payload()) })).status,
      200,
    );
    assert.deepEqual(feishu.calls, { messages: 1, sms: 1 });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("Feishu uses an application token and exactly the configured SMS recipients", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (input, options) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(options?.body)) });
    if (url.includes("oauth/v3/token")) return Response.json({ code: 0, access_token: "token", expires_in: 7200 });
    if (url.includes("urgent_sms")) return Response.json({ code: 0, data: { invalid_user_id_list: ["ou_second"] } });
    return Response.json({ code: 0, data: { message_id: "om_created" } });
  };
  const client = new FeishuClient(config, transport);
  const signal = AbortSignal.timeout(2_000);
  const token = await client.token(signal);
  await client.token(signal);
  const message = await client.send("Example", token, signal);
  const accepted = await client.urgent(message, config.recipients, token, signal);
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.body.uuid, undefined);
  assert.deepEqual(calls[2]?.body.user_id_list, config.recipients);
  assert.deepEqual(accepted, ["ou_first"]);
  assert.ok(calls[2]?.url.endsWith("/om_created/urgent_sms?user_id_type=open_id"));
});

test("platform failures distinguish explicit rejection from uncertain external outcomes", async () => {
  const make = (transport: typeof fetch) => new FeishuClient(config, transport);
  const signal = AbortSignal.timeout(2_000);
  const rejected = make(async () => Response.json({ code: 230001 }, { status: 400 }));
  await assert.rejects(
    rejected.send("Example", "token", signal),
    (error) => error instanceof FeishuError && error.outcome === "rejected",
  );
  const unknown = make(async () => {
    throw new Error("secret-value-that-must-not-be-logged");
  });
  await assert.rejects(
    unknown.send("Example", "token", signal),
    (error) => error instanceof FeishuError && error.outcome === "unknown" && !error.message.includes("secret-value"),
  );
  const unavailable = make(async () => Response.json({ code: 500 }, { status: 503 }));
  await assert.rejects(
    unavailable.send("Example", "token", signal),
    (error) => error instanceof FeishuError && error.outcome === "unknown",
  );
});
