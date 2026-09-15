import { e2Binding } from "./cloud-identities-data.mjs";
import { cloudIdentityHeaders, concurrentPost, record, refusalShape, requestJson } from "./cloud-identities-net.mjs";

export async function runSandboxCases(ctx) {
  const { fixture, shared, cookiesA, cookiesB, assertions } = ctx;
  const firstBinding = e2Binding("a1", ctx.agentA.id, fixture.encryptionKey);
  await fixture.postgres.psql(firstBinding.sql);
  ctx.bindingA = firstBinding;
  const path = shared.HTTP_PATHS.accountSandboxes;
  const headers = cloudIdentityHeaders();
  const channel = {
    imBindingId: firstBinding.bindingId,
    channelId: "C0E2CHANNEL",
    conversationKind: "channel",
    kind: "channel",
  };
  const [left, right] = await concurrentPost({ baseUrl: fixture.baseUrl, cookies: cookiesA, path, headers }, channel);
  record(assertions, "sandbox-ensure-ok", left.ok && right.ok, `${left.status}/${right.status}`);
  shared.AccountSandboxResponseSchema.parse(left.body);
  record(
    assertions,
    "sandbox-concurrent-same",
    left.body.sandboxId === right.body.sandboxId &&
      left.body.sessionId === right.body.sessionId &&
      left.body.storageUri === right.body.storageUri,
  );
  const count = await fixture.postgres.psql(
    `select count(*)::int from sandboxes where session_id = '${left.body.sessionId}'`,
  );
  record(assertions, "sandbox-one-row", Number(count) === 1, count);
  record(assertions, "sandbox-unallocated", left.body.lifecycle === "unallocated");
  record(assertions, "sandbox-env-gen-0", left.body.environmentGeneration === 0);
  record(
    assertions,
    "sandbox-resources-null",
    left.body.currentResourceName === null &&
      left.body.currentResourceUid === null &&
      left.body.currentOperationName === null,
  );
  ctx.sandboxA = left.body;

  const otherChannel = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, channelId: "C0E2OTHER" },
  });
  record(assertions, "sandbox-other-channel", otherChannel.ok && otherChannel.body.sandboxId !== left.body.sandboxId);
  ctx.sandboxOtherChannel = otherChannel.body;

  const thread = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, kind: "thread", threadKey: "T0E2THREAD" },
  });
  record(assertions, "sandbox-thread-distinct", thread.ok && thread.body.sandboxId !== left.body.sandboxId);

  const secondAgent = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: {
      name: "e2-cloud-pi-b",
      displayName: "E2 Cloud Pi B",
      runtimeProvider: "pi",
      computerId: ctx.cloudA.computerId,
    },
  });
  record(assertions, "second-cloud-agent", secondAgent.ok, secondAgent.status);
  const secondBinding = e2Binding("a2", secondAgent.body.id, fixture.encryptionKey);
  await fixture.postgres.psql(secondBinding.sql);
  const otherBinding = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, imBindingId: secondBinding.bindingId },
  });
  record(assertions, "sandbox-other-binding", otherBinding.ok && otherBinding.body.sandboxId !== left.body.sandboxId);

  const agentB = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: {
      name: "e2-cloud-pi",
      displayName: "E2 Cloud Pi B account",
      runtimeProvider: "pi",
      computerId: ctx.cloudB.computerId,
    },
  });
  record(assertions, "account-b-cloud-agent", agentB.ok, agentB.status);
  const bindingB = e2Binding("b1", agentB.body.id, fixture.encryptionKey);
  await fixture.postgres.psql(bindingB.sql);
  const userB = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path,
    headers,
    body: { ...channel, imBindingId: bindingB.bindingId },
  });
  record(assertions, "sandbox-other-user", userB.ok && userB.body.sandboxId !== left.body.sandboxId);
  ctx.sandboxB = userB.body;
  ctx.agentB = agentB.body;
  ctx.bindingB = bindingB;

  const ownership = await fixture.postgres.psql(`
select count(*)::int from sandboxes s
join sessions sess on sess.id = s.session_id
join im_bindings b on b.id = sess.im_binding_id
join agents a on a.id = b.agent_id
join session_placements p on p.session_id = sess.id
where s.id = '${left.body.sandboxId}'
  and a.created_by_user_id = '${ctx.accountA.id}'
  and p.computer_id = '${ctx.cloudA.computerId}'
`);
  record(assertions, "sandbox-sql-owner-placement", Number(ownership) === 1, ownership);
  const countIdentities = () =>
    fixture.postgres.psql(
      "select (select count(*) from sessions)::text || ',' || (select count(*) from session_placements)::text || ',' || (select count(*) from sandboxes)::text",
    );
  const beforeRefusals = await countIdentities();

  const extraAccount = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, accountId: ctx.accountB.id },
  });
  record(assertions, "reject-self-reported-accountId", extraAccount.status === 400, extraAccount.status);
  const extraAgent = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, agentId: ctx.agentA.id },
  });
  record(assertions, "reject-self-reported-agentId", extraAgent.status === 400, extraAgent.status);
  const badThread = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, kind: "thread" },
  });
  record(assertions, "reject-malformed-thread", badThread.status === 400, badThread.status);

  const foreignEnsure = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path,
    headers,
    body: channel,
  });
  record(assertions, "foreign-ensure-binding", foreignEnsure.status === 404, foreignEnsure.status);
  const foreignGet = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "GET",
    path: shared.accountSandboxPath(left.body.sandboxId),
    headers,
  });
  record(assertions, "foreign-query-sandbox", foreignGet.status === 404, foreignGet.status);
  const unknownGet = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.accountSandboxPath("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    headers,
  });
  record(
    assertions,
    "foreign-unknown-same-shape",
    JSON.stringify(refusalShape(foreignGet)) === JSON.stringify(refusalShape(unknownGet)),
  );
  const unknownEnsure = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path,
    headers,
    body: { ...channel, imBindingId: crypto.randomUUID() },
  });
  record(
    assertions,
    "foreign-ensure-matches-unknown-binding",
    JSON.stringify(refusalShape(foreignEnsure)) === JSON.stringify(refusalShape(unknownEnsure)),
  );
  ctx.foreignEnsure = foreignEnsure;
  ctx.foreignGet = foreignGet;

  record(
    assertions,
    "no-partial-session-placement-sandbox-rows",
    (await countIdentities()) === beforeRefusals,
    beforeRefusals,
  );
  record(
    assertions,
    "distinct-session-uris",
    new Set([left.body, otherChannel.body, thread.body, otherBinding.body, userB.body].map((row) => row.storageUri))
      .size === 5,
  );
}
