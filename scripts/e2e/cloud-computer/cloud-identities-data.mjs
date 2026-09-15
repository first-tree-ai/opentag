import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encryptCredential } from "./binding.mjs";
import { SLACK_REQUIRED_BOT_SCOPES } from "./im-stub.mjs";

const execFileCb = promisify(execFile);

export const E2_IDS = {
  localComputer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  localInstallation: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  localCredential: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  localAgent: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
};

export const CLOUD_CAPABILITY_HEADER = "x-opentag-cloud-identity";
export const CLOUD_STORAGE_URI = "gs://opentag-e2-fixture/sandboxes";
export const SUBSTITUTIONS = [
  {
    name: "fixture-slack-binding",
    scope: "E2 identities",
    detail: "SQL-inserted Slack installation + IM binding with dummy encrypted credentials. No OAuth or Slack HTTP.",
  },
  {
    name: "forged-cloud-repair-code",
    scope: "E2 identities negative",
    detail: "Injected disposable repair-code row targeting Cloud, then exchanged. Not a product credential.",
  },
  {
    name: "fake-cloud-machine-credential",
    scope: "E2 identities negative",
    detail: "Temporary fake Cloud computer_credentials row for register/verify reject, then deleted.",
  },
  {
    name: "db-only-resource-ownership",
    scope: "E2 identities",
    detail: "Synthetic resource name+UID unique update. Not GCP allocation evidence.",
  },
  {
    name: "local-channel-target-url",
    scope: "E2 identities",
    detail: "OPENTAG_PORTABLE_DOWNLOAD_BASE_URL points at loopback so the Server never polls dl.opentag.build.",
  },
];

export function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function loadShared(repositoryRoot) {
  const entry = join(repositoryRoot, "packages/shared/dist/index.mjs");
  if (!existsSync(entry)) throw new Error("Run pnpm build before this check (packages/shared/dist is required)");
  return import(pathToFileURL(entry).href);
}

export async function readCliVersion(repositoryRoot) {
  const pkg = JSON.parse(await readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8"));
  return pkg.version;
}

export function gitState(repositoryRoot) {
  const run = (args) =>
    execFileCb("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).then((result) => result.stdout.trim());
  return Promise.all([run(["rev-parse", "HEAD"]), run(["status", "--porcelain"])]).then(([sha, dirty]) => ({
    gitSha: sha || "unknown",
    gitDirty: dirty.length > 0,
  }));
}

export function e1LocalSeedSql({ accountId, secret }) {
  const secretHash = hashSecret(secret);
  return `
insert into computers (
  id, owner_account_id, current_installation_id, display_name, platform, arch, client_version
) values (
  ${sqlString(E2_IDS.localComputer)}, ${sqlString(accountId)}, ${sqlString(E2_IDS.localInstallation)},
  'E1 upgrade Local fixture', 'linux', 'x64', '0.0.5'
);
insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
values (
  ${sqlString(E2_IDS.localCredential)}, ${sqlString(E2_IDS.localComputer)}, ${sqlString(secretHash)},
  ${sqlString(accountId)}, now()
);
insert into agents (
  id, created_by_user_id, computer_id, name, display_name, runtime_provider, status
) values (
  ${sqlString(E2_IDS.localAgent)}, ${sqlString(accountId)}, ${sqlString(E2_IDS.localComputer)},
  'e1-upgrade-pi', 'E1 upgrade Pi', 'pi', 'active'
);
insert into agent_runtime_configs (agent_id, instructions)
values (${sqlString(E2_IDS.localAgent)}, 'E1 upgrade fixture Pi instructions');
`;
}

export function parameterizedSlackBindingSql({
  agentId,
  encryptionKey,
  installationId,
  bindingId,
  appId,
  teamId,
  botUserId,
  botId,
  teamName,
  botDisplayName,
}) {
  const scopes = SLACK_REQUIRED_BOT_SCOPES.map((scope) => sqlString(scope)).join(", ");
  const encrypted = encryptCredential(encryptionKey, {
    botId,
    botAccessToken: `xoxb-e2-fixture-${bindingId}`,
    signingSecret: `e2-fixture-signing-${bindingId}`,
    grantedScopes: [...SLACK_REQUIRED_BOT_SCOPES],
  });
  return {
    bindingId,
    installationId,
    sql: `
insert into slack_installations (
  id, agent_id, status, external_app_id, external_team_id, external_bot_id,
  external_team_name, bot_display_name, credential_schema_version, credential_generation,
  encrypted_credential, granted_capabilities, activated_at, observed_at, observed_connected_at
) values (
  ${sqlString(installationId)}, ${sqlString(agentId)}, 'active',
  ${sqlString(appId)}, ${sqlString(teamId)}, ${sqlString(botUserId)},
  ${sqlString(teamName)}, ${sqlString(botDisplayName)},
  1, 1, ${sqlString(encrypted)}, ARRAY[${scopes}]::text[], now(), now(), now()
);
insert into im_bindings (
  id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
  external_team_name, bot_display_name, credential_schema_version, credential_generation,
  encrypted_credential, granted_capabilities, slack_installation_id, slack_route_kind,
  activated_at, observed_at, observed_connected_at
) values (
  ${sqlString(bindingId)}, ${sqlString(agentId)}, 'slack', 'active',
  ${sqlString(appId)}, ${sqlString(teamId)}, ${sqlString(botUserId)},
  ${sqlString(teamName)}, ${sqlString(botDisplayName)},
  1, 1, null, ARRAY[${scopes}]::text[], ${sqlString(installationId)}, 'default',
  now(), now(), now()
);
`,
  };
}

export function e2Binding(label, agentId, encryptionKey) {
  const suffix = label.replaceAll(/[^a-z0-9]/gi, "").slice(0, 8);
  return parameterizedSlackBindingSql({
    agentId,
    encryptionKey,
    installationId: randomUUID(),
    bindingId: randomUUID(),
    appId: `A0E2${suffix.toUpperCase()}`,
    teamId: `T0E2${suffix.toUpperCase()}`,
    botUserId: `U0E2${suffix.toUpperCase()}`,
    botId: `B0E2${suffix.toUpperCase()}`,
    teamName: `E2 identities ${label}`,
    botDisplayName: `OpenTag E2 ${label}`,
  });
}

export function fakeCloudCredentialSql({ id, computerId, accountId, secret }) {
  return `
insert into computer_credentials (id, computer_id, secret_hash, issued_by_user_id, issued_at)
values (${sqlString(id)}, ${sqlString(computerId)}, ${sqlString(hashSecret(secret))}, ${sqlString(accountId)}, now());
`;
}

export function deleteCredentialSql(id) {
  return `delete from computer_credentials where id = ${sqlString(id)};`;
}

export function forgedRepairCodeSql({ id, accountId, targetComputerId, code }) {
  return `
insert into computer_connect_codes (
  id, token_hash, issued_by_account_id, mode, target_computer_id, created_at, expires_at
) values (
  ${sqlString(id)}, ${sqlString(hashSecret(code))}, ${sqlString(accountId)}, 'repair',
  ${sqlString(targetComputerId)}, now(), now() + interval '15 minutes'
);
`;
}

export function resourceUniqueProbeSql({ idA, idB, name, uid, field }) {
  return `
begin;
update sandboxes set current_resource_name = ${sqlString(name)}, current_resource_uid = ${sqlString(uid)}
  where id = ${sqlString(idA)};
update sandboxes set current_resource_name = ${sqlString(field === "name" ? name : `${name}-other`)},
  current_resource_uid = ${sqlString(field === "uid" ? uid : randomUUID())}
  where id = ${sqlString(idB)};
commit;
`;
}
