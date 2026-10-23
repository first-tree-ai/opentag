import type { Config } from "./config.ts";

export class FeishuError extends Error {
  readonly outcome: "rejected" | "unknown";
  readonly code: string;
  constructor(outcome: "rejected" | "unknown", code: string) {
    super("Feishu operation did not complete successfully");
    this.outcome = outcome;
    this.code = code;
  }
}

type ResponseBody = {
  code?: number;
  access_token?: string;
  expires_in?: number;
  data?: {
    message_id?: string;
    invalid_user_id_list?: string[];
  };
};

export class FeishuClient {
  readonly #config: Pick<Config, "appId" | "appSecret" | "chatId" | "userIdType">;
  readonly #fetch: typeof fetch;
  #cached: { token: string; until: number } | undefined;

  constructor(config: Pick<Config, "appId" | "appSecret" | "chatId" | "userIdType">, fetcher: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetcher;
  }

  async token(signal: AbortSignal): Promise<string> {
    if (this.#cached && this.#cached.until > Date.now()) return this.#cached.token;
    const response = await this.#fetch("https://accounts.feishu.cn/oauth/v3/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.#config.appId,
        client_secret: this.#config.appSecret,
      }),
    });
    const data = (await response.json()) as ResponseBody;
    if (!response.ok || data.code !== 0 || !data.access_token || typeof data.expires_in !== "number") {
      throw new FeishuError("rejected", "token_unavailable");
    }
    this.#cached = { token: data.access_token, until: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
    return this.#cached.token;
  }

  async #call(path: string, method: string, body: unknown, token: string, signal: AbortSignal): Promise<ResponseBody> {
    let response: Response;
    try {
      response = await this.#fetch(`https://open.feishu.cn/open-apis/im/v1/messages${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new FeishuError("unknown", "transport_outcome_unknown");
    }
    let data: ResponseBody;
    try {
      data = (await response.json()) as ResponseBody;
    } catch {
      throw new FeishuError("unknown", "invalid_platform_response");
    }
    if (!response.ok || data.code !== 0) {
      if (response.status >= 500) throw new FeishuError("unknown", "platform_outcome_unknown");
      throw new FeishuError("rejected", `platform_${typeof data.code === "number" ? data.code : response.status}`);
    }
    return data;
  }

  async send(text: string, token: string, signal: AbortSignal): Promise<string> {
    const data = await this.#call(
      "?receive_id_type=chat_id",
      "POST",
      {
        receive_id: this.#config.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
      token,
      signal,
    );
    if (!data.data?.message_id || !/^om_[\w]+$/.test(data.data.message_id)) {
      throw new FeishuError("unknown", "message_identity_missing");
    }
    return data.data.message_id;
  }

  async urgent(messageId: string, recipients: string[], token: string, signal: AbortSignal): Promise<string[]> {
    const data = await this.#call(
      `/${encodeURIComponent(messageId)}/urgent_sms?user_id_type=${this.#config.userIdType}`,
      "PATCH",
      {
        user_id_list: recipients,
      },
      token,
      signal,
    );
    const invalid = data.data?.invalid_user_id_list;
    if (!Array.isArray(invalid) || invalid.some((id) => typeof id !== "string" || !recipients.includes(id))) {
      throw new FeishuError("unknown", "invalid_recipient_response");
    }
    return recipients.filter((id) => !invalid.includes(id));
  }
}
