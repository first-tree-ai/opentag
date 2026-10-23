export function readConfig(env: NodeJS.ProcessEnv) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing configuration: ${key}`);
    return value;
  };
  const project = required("GOOGLE_CLOUD_PROJECT");
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(project)) throw new Error("Invalid project identifier");
  const policies = required("ALERT_POLICY_IDS")
    .split(",")
    .map((value) => value.trim());
  if (!policies.length || policies.some((value) => !/^\d+$/.test(value))) throw new Error("Invalid policy allowlist");
  const recipients = required("FEISHU_URGENT_USER_IDS")
    .split(",")
    .map((value) => value.trim());
  const userIdType = required("FEISHU_USER_ID_TYPE");
  if (!["open_id", "user_id", "union_id"].includes(userIdType)) throw new Error("Invalid recipient ID type");
  if (
    recipients.length !== 2 ||
    new Set(recipients).size !== 2 ||
    recipients.some((id) => !/^[\w-]{3,100}$/.test(id))
  ) {
    throw new Error("Exactly two distinct SMS recipients are required");
  }
  const appId = required("FEISHU_APP_ID");
  const chatId = required("FEISHU_CHAT_ID");
  if (!/^cli_[a-z0-9]+$/.test(appId) || !/^oc_[a-z0-9]+$/.test(chatId)) throw new Error("Invalid Feishu configuration");
  const username = required("WEBHOOK_USERNAME");
  const password = required("WEBHOOK_PASSWORD");
  if (username.includes(":") || password.length < 32) throw new Error("Invalid webhook credentials");
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  return {
    project,
    policies: new Set(policies),
    recipients,
    userIdType,
    appId,
    chatId,
    appSecret: required("FEISHU_APP_SECRET"),
    username,
    password,
    port,
    revision: env.SOURCE_REVISION ?? "unknown",
  };
}

export type Config = ReturnType<typeof readConfig>;
