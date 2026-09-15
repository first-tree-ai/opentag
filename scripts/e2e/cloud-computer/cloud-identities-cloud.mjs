import {
  cloudIdentityHeaders,
  concurrentPost,
  readinessV2Headers,
  record,
  refusalShape,
  requestJson,
} from "./cloud-identities-net.mjs";

export async function runCloudComputerCases(ctx) {
  const { fixture, shared, cookiesA, cookiesB, assertions, cliVersion } = ctx;
  const path = shared.HTTP_PATHS.accountCloudComputer;
  const headers = cloudIdentityHeaders();
  const [first, second] = await concurrentPost(
    { baseUrl: fixture.baseUrl, cookies: cookiesA, method: "PUT", path, headers },
    {},
  );
  record(assertions, "cloud-ensure-http-ok", first.ok && second.ok, `${first.status}/${second.status}`);
  shared.AccountCloudComputerEnsureResponseSchema.parse(first.body);
  shared.AccountCloudComputerEnsureResponseSchema.parse(second.body);
  record(assertions, "cloud-ensure-concurrent-same-id", first.body.computerId === second.body.computerId);
  const count = await fixture.postgres.psql(
    `select count(*)::int from computers where owner_account_id = '${ctx.accountA.id}' and kind = 'cloud'`,
  );
  record(assertions, "cloud-ensure-one-row", Number(count) === 1, count);
  const other = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "PUT",
    path,
    body: {},
    headers,
  });
  record(assertions, "cloud-ensure-other-account", other.ok && other.body.computerId !== first.body.computerId);
  const row = await fixture.postgres.psql(
    `select platform || ',' || arch || ',' || client_version || ',' || current_installation_id
     || ',' || coalesce(current_instance_id::text,'') || ',' || coalesce(connected_at::text,'')
     || ',' || coalesce(last_seen_at::text,'')
     from computers where id = '${first.body.computerId}'`,
  );
  const [platform, arch, version, install, instance, connected, seen] = row.split(",");
  record(assertions, "cloud-metadata-linux-x64", platform === "linux" && arch === "x64", row);
  record(assertions, "cloud-metadata-version", version === cliVersion, version);
  record(assertions, "cloud-metadata-install-uuid", Boolean(install), install);
  record(assertions, "cloud-no-instance", instance === "", instance);
  record(assertions, "cloud-no-connected-at", connected === "", connected);
  record(assertions, "cloud-no-last-seen-at", seen === "", seen);
  const creds = await fixture.postgres.psql(
    `select count(*)::int from computer_credentials where computer_id = '${first.body.computerId}'`,
  );
  record(assertions, "cloud-no-credentials", Number(creds) === 0, creds);

  const listed = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
    headers,
  });
  const cloud = listed.body.computers.find((entry) => entry.computerId === first.body.computerId);
  record(assertions, "list-cloud-capable-kind", cloud?.kind === "cloud" && cloud.connectionStatus === "online");

  const legacy = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
  });
  record(
    assertions,
    "list-no-header-hides-cloud",
    !legacy.body.computers.some((entry) => entry.computerId === first.body.computerId || entry.kind === "cloud"),
  );
  const readinessOnly = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
    headers: readinessV2Headers(),
  });
  record(
    assertions,
    "list-readiness-v2-hides-cloud",
    !readinessOnly.body.computers.some((entry) => entry.computerId === first.body.computerId || entry.kind),
  );
  const ready = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
    headers: { ...headers, ...readinessV2Headers() },
  });
  const cloudReady = ready.body.computers.find((entry) => entry.computerId === first.body.computerId);
  const pi = cloudReady?.providerReadiness?.find((entry) => entry.provider === "pi");
  record(
    assertions,
    "cloud-online-does-not-imply-pi-ready",
    cloudReady?.connectionStatus === "online" &&
      pi?.status === "unavailable" &&
      pi.observedAt === null &&
      cloudReady.connectedAt === null &&
      cloudReady.lastSeenAt === null,
  );
  const unknownCapability = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
    headers: { ...readinessV2Headers(), "x-opentag-cloud-identity": "2" },
  });
  record(
    assertions,
    "unknown-cloud-capability-keeps-legacy-shape",
    unknownCapability.ok &&
      unknownCapability.body.computers.every((entry) => entry.kind === undefined) &&
      !unknownCapability.body.computers.some((entry) => entry.computerId === first.body.computerId),
  );
  ctx.cloudA = first.body;
  ctx.cloudB = other.body;
  ctx.cloudSnapshot = await fixture.postgres.psql(
    `select to_jsonb(c)::text from computers c where id='${first.body.computerId}'`,
  );
}

export async function runAgentCases(ctx) {
  const { fixture, shared, cookiesA, cookiesB, assertions } = ctx;
  const created = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: {
      name: "e2-cloud-pi",
      displayName: "E2 Cloud Pi",
      runtimeProvider: "pi",
      computerId: ctx.cloudA.computerId,
      creationIntentId: ctx.intentId,
    },
  });
  record(assertions, "create-pi-cloud-agent", created.ok && created.body.runtimeProvider === "pi", created.status);
  ctx.agentA = created.body;
  await verifyCloudSetupBoundary(ctx);
  for (const runtimeProvider of ["codex", "claude-code"]) {
    const rejected = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: cookiesA,
      method: "POST",
      path: shared.HTTP_PATHS.accountAgents,
      body: {
        name: `e2-cloud-${runtimeProvider}`,
        displayName: runtimeProvider,
        runtimeProvider,
        computerId: ctx.cloudA.computerId,
      },
    });
    record(
      assertions,
      `reject-cloud-${runtimeProvider}`,
      rejected.status === 409 && rejected.body?.error?.code === "AGENT_LIFECYCLE_CONFLICT",
      rejected.status,
    );
  }
  const patched = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "PATCH",
    path: shared.agentByIdPath(ctx.agentA.id),
    body: { expectedRevision: ctx.agentA.revision, runtimeProvider: "codex" },
  });
  record(assertions, "runtime-provider-immutable", !patched.ok, patched.status);
  const local = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: { name: "e2-local-pi", displayName: "E2 Local Pi", runtimeProvider: "pi" },
  });
  record(assertions, "create-unbound-local-agent", local.ok, local.status);
  ctx.localAgentA = local.body;
  const localBound = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: { name: "e2-local-bound", displayName: "E2 Local Bound", runtimeProvider: "pi" },
  });
  record(assertions, "create-second-unbound-local-agent", localBound.ok, localBound.status);
  ctx.localBoundAgentA = localBound.body;
  const toCloud = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.agentComputerRebindPath(ctx.localAgentA.id),
    body: { computerId: ctx.cloudA.computerId },
  });
  record(
    assertions,
    "rebind-unbound-local-to-cloud",
    toCloud.status === 409 && toCloud.body?.error?.code === "AGENT_LIFECYCLE_CONFLICT",
    toCloud.status,
  );
  const same = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.agentComputerRebindPath(ctx.agentA.id),
    body: { computerId: ctx.cloudA.computerId },
  });
  record(assertions, "rebind-cloud-same-id", same.ok && same.body.computerId === ctx.cloudA.computerId, same.status);
  const foreign = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: { name: "e2-steal-cloud", displayName: "Steal", runtimeProvider: "pi", computerId: ctx.cloudA.computerId },
  });
  record(assertions, "foreign-create-agent-cloud-id", !foreign.ok, foreign.status);
  const missing = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: { name: "e2-missing-cloud", displayName: "Missing", runtimeProvider: "pi", computerId: crypto.randomUUID() },
  });
  record(
    assertions,
    "foreign-create-matches-missing-computer",
    foreign.status === 404 && JSON.stringify(refusalShape(foreign)) === JSON.stringify(refusalShape(missing)),
  );
  ctx.foreignAgentCreate = foreign;
  const rebindForeign = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path: shared.agentComputerRebindPath(ctx.agentA.id),
    body: { computerId: ctx.cloudB.computerId },
  });
  record(assertions, "foreign-rebind", !rebindForeign.ok, rebindForeign.status);
  const missingAgent = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesB,
    method: "POST",
    path: shared.agentComputerRebindPath(crypto.randomUUID()),
    body: { computerId: ctx.cloudB.computerId },
  });
  record(
    assertions,
    "foreign-rebind-matches-missing-agent",
    rebindForeign.status === 404 &&
      JSON.stringify(refusalShape(rebindForeign)) === JSON.stringify(refusalShape(missingAgent)),
  );
  ctx.foreignRebind = rebindForeign;
}

async function verifyCloudSetupBoundary(ctx) {
  for (const [method, path] of [
    ["GET", ctx.shared.agentSetupPath(ctx.agentA.id)],
    ["POST", ctx.shared.agentSetupRefreshPath(ctx.agentA.id)],
  ]) {
    const result = await requestJson({
      baseUrl: ctx.fixture.baseUrl,
      cookies: ctx.cookiesA,
      method,
      path,
    });
    record(
      ctx.assertions,
      `cloud-refuses-local-setup-${method.toLowerCase()}`,
      result.status === 404 && result.body?.error?.code === "RESOURCE_NOT_FOUND",
      result.status,
    );
  }
}
