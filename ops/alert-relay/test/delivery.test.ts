import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver } from "../src/deliver.ts";
import { FeishuError } from "../src/feishu.ts";
import { messageText, parseIncident } from "../src/incident.ts";
import { config, payload, testFeishu } from "./support.ts";

test("GCP renotify suppresses repeated open reminders, while recovery is an ordinary message", async () => {
  const feishu = testFeishu();
  const run = (state: string, repeated: boolean) =>
    deliver(
      parseIncident(payload(state, repeated), config),
      config,
      feishu,
      () => undefined,
      AbortSignal.timeout(1000),
    );
  assert.equal(await run("open", true), "ignored_renotification");
  assert.deepEqual(feishu.calls, { messages: 0, sms: 0 });
  assert.equal(await run("open", false), "complete");
  assert.deepEqual(feishu.calls, { messages: 1, sms: 1 });
  assert.equal(await run("closed", true), "complete");
  assert.deepEqual(feishu.calls, { messages: 2, sms: 1 });
});

test("stateless forwarding retains no incident deduplication or out-of-order history", async () => {
  const feishu = testFeishu();
  const run = (state: string) =>
    deliver(parseIncident(payload(state), config), config, feishu, () => undefined, AbortSignal.timeout(1000));
  await run("closed");
  await Promise.all([run("open"), run("open")]);
  assert.deepEqual(feishu.calls, { messages: 3, sms: 2 });
});

test("partial SMS rejection and uncertain outcomes do not retry external operations", async () => {
  const feishu = testFeishu();
  const incident = parseIncident(payload(), config);
  const events: unknown[] = [];
  const log = (_severity: string, event: string, fields: Record<string, unknown>) => events.push({ event, ...fields });
  const partial = { ...feishu, urgent: async () => [config.recipients[0] as string] };
  assert.equal(await deliver(incident, config, partial, log, AbortSignal.timeout(1000)), "failed");
  const uncertain = {
    ...feishu,
    urgent: async () => {
      throw new FeishuError("unknown", "transport_outcome_unknown");
    },
  };
  assert.equal(await deliver(incident, config, uncertain, log, AbortSignal.timeout(1000)), "unknown");
  assert.equal(feishu.calls.messages, 2);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events).includes(incident.id));
  assert.ok(!JSON.stringify(events).includes(incident.summary));
});

test("payload validates project, policy, state, repeat flag and times, and ignores untrusted URLs", () => {
  const good = payload();
  const invalid = [
    { ...good, version: "0.1" },
    { ...good, incident: { ...good.incident, scoping_project_id: "other-project" } },
    {
      ...good,
      incident: { ...good.incident, condition: { name: "projects/test-project/alertPolicies/1/conditions/2" } },
    },
    { ...good, incident: { ...good.incident, state: "unknown" } },
    { ...good, incident: { ...good.incident, renotify: "true" } },
    { ...good, incident: { ...good.incident, started_at: Number.MAX_SAFE_INTEGER } },
    { ...payload("closed"), incident: { ...payload("closed").incident, ended_at: 1 } },
  ];
  for (const input of invalid) assert.throws(() => parseIncident(input, config));
  const incident = parseIncident(
    { ...good, incident: { ...good.incident, url: "https://example.invalid/secret" } },
    config,
  );
  assert.ok(messageText(incident).includes("console.cloud.google.com"));
  assert.ok(!messageText(incident).includes("example.invalid"));
});
