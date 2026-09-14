import { createCipheriv, randomBytes } from "node:crypto";
import { SLACK_FIXTURE, SLACK_REQUIRED_BOT_SCOPES } from "./im-stub.mjs";

export function encryptCredential(encryptionKey, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function fixtureSlackBindingSql({ agentId, encryptionKey }) {
  const installationId = "22222222-2222-4222-8222-222222222222";
  const bindingId = "33333333-3333-4333-8333-333333333333";
  const scopes = SLACK_REQUIRED_BOT_SCOPES.map((scope) => sqlString(scope)).join(", ");
  const encrypted = encryptCredential(encryptionKey, {
    botId: SLACK_FIXTURE.botId,
    botAccessToken: SLACK_FIXTURE.botAccessToken,
    signingSecret: SLACK_FIXTURE.signingSecret,
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
  ${sqlString(SLACK_FIXTURE.appId)}, ${sqlString(SLACK_FIXTURE.teamId)}, ${sqlString(SLACK_FIXTURE.botUserId)},
  ${sqlString(SLACK_FIXTURE.teamName)}, ${sqlString(SLACK_FIXTURE.botDisplayName)},
  1, 1, ${sqlString(encrypted)}, ARRAY[${scopes}]::text[], now(), now(), now()
);

insert into im_bindings (
  id, agent_id, provider, status, external_app_id, external_team_id, external_bot_id,
  external_team_name, bot_display_name, credential_schema_version, credential_generation,
  encrypted_credential, granted_capabilities, slack_installation_id, slack_route_kind,
  activated_at, observed_at, observed_connected_at
) values (
  ${sqlString(bindingId)}, ${sqlString(agentId)}, 'slack', 'active',
  ${sqlString(SLACK_FIXTURE.appId)}, ${sqlString(SLACK_FIXTURE.teamId)}, ${sqlString(SLACK_FIXTURE.botUserId)},
  ${sqlString(SLACK_FIXTURE.teamName)}, ${sqlString(SLACK_FIXTURE.botDisplayName)},
  1, 1, null, ARRAY[${scopes}]::text[], ${sqlString(installationId)}, 'default',
  now(), now(), now()
);
`,
  };
}
