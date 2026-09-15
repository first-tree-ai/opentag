import { randomUUID } from "node:crypto";
import { deleteCredentialSql, fakeCloudCredentialSql, forgedRepairCodeSql } from "./cloud-identities-data.mjs";
import { authComputerWs, record, registerComputerWs, requestJson } from "./cloud-identities-net.mjs";
import { parseConnectCode } from "./observe.mjs";

function exchangeBody({ code, installationId, clientVersion, displayName = "E2 Local" }) {
  return {
    code,
    installationId,
    displayName,
    platform: "linux",
    arch: "x64",
    clientVersion,
  };
}

export async function runLocalConnectCases(ctx) {
  const { fixture, shared, cookiesA, assertions, cliVersion } = ctx;
  const issued = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountComputerConnectCodes,
    body: { mode: "create" },
  });
  record(assertions, "local-connect-issue", issued.ok, issued.status);
  const parsed = parseConnectCode(issued.body.bootstrapCommand);
  fixture.secrets.push(parsed.code);
  const installationId = randomUUID();
  const unmarked = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: undefined,
    method: "POST",
    path: shared.HTTP_PATHS.computerConnectExchange,
    body: exchangeBody({ code: parsed.code, installationId, clientVersion: cliVersion }),
    csrf: false,
  });
  record(assertions, "local-unmarked-exchange", unmarked.ok, unmarked.status);
  fixture.secrets.push(unmarked.body.machineToken);
  record(assertions, "local-unmarked-shape", unmarked.body.runtimeProvider === undefined);
  ctx.localComputerId = unmarked.body.computerId;
  ctx.localInstallationId = unmarked.body.installationId;
  ctx.localMachineToken = unmarked.body.machineToken;
  const wsUrl = shared.runtimeWebSocketUrl(fixture.baseUrl);
  const registered = await registerComputerWs({
    wsUrl,
    machineToken: unmarked.body.machineToken,
    installationId,
    clientVersion: cliVersion,
  });
  record(assertions, "local-ws-register", registered.computerId === unmarked.body.computerId);
  const listed = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountComputers,
  });
  const local = listed.body.computers.find((entry) => entry.computerId === unmarked.body.computerId);
  record(assertions, "local-list-legacy-shape", Boolean(local) && local.kind === undefined);
  record(assertions, "local-live-online", local.connectionStatus === "online");
  registered.socket.close();
  const repairIssue = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountComputerConnectCodes,
    body: { mode: "repair", targetComputerId: unmarked.body.computerId },
  });
  record(assertions, "local-repair-issue", repairIssue.ok, repairIssue.status);
  const repairParsed = parseConnectCode(repairIssue.body.bootstrapCommand);
  fixture.secrets.push(repairParsed.code);
  const repaired = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: undefined,
    method: "POST",
    path: shared.HTTP_PATHS.computerConnectExchange,
    body: exchangeBody({ code: repairParsed.code, installationId, clientVersion: cliVersion }),
    csrf: false,
  });
  record(assertions, "local-repair-preserves-id", repaired.ok && repaired.body.computerId === unmarked.body.computerId);
  fixture.secrets.push(repaired.body.machineToken);
  record(assertions, "local-repair-new-token", repaired.body.machineToken !== unmarked.body.machineToken);
  const prior = await authComputerWs({ wsUrl, machineToken: unmarked.body.machineToken });
  record(assertions, "local-repair-rejects-prior-token", prior.ok === false);
  ctx.localMachineToken = repaired.body.machineToken;
  const cloudToLocal = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.agentComputerRebindPath(ctx.agentA.id),
    body: { computerId: unmarked.body.computerId },
  });
  record(
    assertions,
    "rebind-cloud-to-real-local",
    cloudToLocal.status === 409 && cloudToLocal.body?.error?.code === "AGENT_LIFECYCLE_CONFLICT",
    cloudToLocal.status,
  );

  if (ctx.localBoundAgentA && ctx.localComputerId) {
    const bindLocal = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: cookiesA,
      method: "POST",
      path: shared.agentComputerRebindPath(ctx.localBoundAgentA.id),
      body: { computerId: ctx.localComputerId },
    });
    record(
      assertions,
      "bind-unbound-local",
      bindLocal.ok && bindLocal.body.computerId === ctx.localComputerId,
      bindLocal.status,
    );
    const secondCode = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: cookiesA,
      method: "POST",
      path: shared.HTTP_PATHS.accountComputerConnectCodes,
      body: { mode: "create" },
    });
    record(assertions, "second-local-code", secondCode.ok, secondCode.status);
    const secondParsed = parseConnectCode(secondCode.body.bootstrapCommand);
    fixture.secrets.push(secondParsed.code);
    const secondLocal = await requestJson({
      baseUrl: fixture.baseUrl,
      method: "POST",
      path: shared.HTTP_PATHS.computerConnectExchange,
      body: exchangeBody({ code: secondParsed.code, installationId: randomUUID(), clientVersion: cliVersion }),
      csrf: false,
    });
    record(
      assertions,
      "second-local-created",
      secondLocal.ok && secondLocal.body.computerId !== ctx.localComputerId,
      secondLocal.status,
    );
    fixture.secrets.push(secondLocal.body.machineToken);
    const movedLocal = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: cookiesA,
      method: "POST",
      path: shared.agentComputerRebindPath(ctx.localBoundAgentA.id),
      body: { computerId: secondLocal.body.computerId },
    });
    record(
      assertions,
      "rebind-local-to-local",
      movedLocal.ok && movedLocal.body.computerId === secondLocal.body.computerId,
      movedLocal.status,
    );
    const boundToCloud = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: cookiesA,
      method: "POST",
      path: shared.agentComputerRebindPath(ctx.localBoundAgentA.id),
      body: { computerId: ctx.cloudA.computerId },
    });
    record(
      assertions,
      "rebind-bound-local-to-cloud",
      boundToCloud.status === 409 && boundToCloud.body?.error?.code === "AGENT_LIFECYCLE_CONFLICT",
      boundToCloud.status,
    );
  }
}

export async function runCloudGuardCases(ctx) {
  const { fixture, shared, cookiesA, assertions, cliVersion, accountA } = ctx;
  const cloudRepair = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountComputerConnectCodes,
    body: { mode: "repair", targetComputerId: ctx.cloudA.computerId },
  });
  record(assertions, "repair-issue-cloud-rejected", !cloudRepair.ok, cloudRepair.status);

  const forgedId = randomUUID();
  const forgedCode = `otcc_e2forged_${randomUUID().replaceAll("-", "")}`;
  await fixture.postgres.psql(
    forgedRepairCodeSql({
      id: forgedId,
      accountId: accountA.id,
      targetComputerId: ctx.cloudA.computerId,
      code: forgedCode,
    }),
  );
  const forgedExchange = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: undefined,
    method: "POST",
    path: shared.HTTP_PATHS.computerConnectExchange,
    body: exchangeBody({ code: forgedCode, installationId: randomUUID(), clientVersion: cliVersion }),
    csrf: false,
  });
  record(assertions, "forged-repair-exchange-cloud-rejected", !forgedExchange.ok, forgedExchange.status);

  const createForCollision = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountComputerConnectCodes,
    body: { mode: "create" },
  });
  const cloudInstall = await fixture.postgres.psql(
    `select current_installation_id from computers where id = '${ctx.cloudA.computerId}'`,
  );
  const collide = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: undefined,
    method: "POST",
    path: shared.HTTP_PATHS.computerConnectExchange,
    body: exchangeBody({
      code: parseConnectCode(createForCollision.body.bootstrapCommand).code,
      installationId: cloudInstall.trim(),
      clientVersion: cliVersion,
    }),
    csrf: false,
  });
  record(assertions, "installation-collision-cloud-rejected", !collide.ok, collide.status);

  const fakeId = randomUUID();
  const fakeSecret = `e2fake${randomUUID().replaceAll("-", "")}`;
  await fixture.postgres.psql(
    fakeCloudCredentialSql({
      id: fakeId,
      computerId: ctx.cloudA.computerId,
      accountId: accountA.id,
      secret: fakeSecret,
    }),
  );
  const wsUrl = shared.runtimeWebSocketUrl(fixture.baseUrl);
  const fakeAuth = await authComputerWs({ wsUrl, machineToken: `otmc_${fakeId}.${fakeSecret}` });
  record(assertions, "fake-cloud-credential-auth-rejected", fakeAuth.ok === false, fakeAuth.errorCode);
  await fixture.postgres.psql(deleteCredentialSql(fakeId));
  const leftover = await fixture.postgres.psql(
    `select count(*)::int from computer_credentials where computer_id = '${ctx.cloudA.computerId}'`,
  );
  record(assertions, "fake-cloud-credential-removed", Number(leftover) === 0, leftover);
  const install = await fixture.postgres.psql(
    `select current_installation_id from computers where id = '${ctx.cloudA.computerId}'`,
  );
  record(assertions, "cloud-identity-not-overwritten", install === cloudInstall, install);
}
