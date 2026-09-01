import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeImCredentialGrantResult, RuntimeImOutboxContext } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { assertWithin, ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import type { RuntimeBusinessFrame, RuntimeConnection } from "./runtime-connection.js";

const GRANT_TIMEOUT_MS = 10_000;
const MANAGED_CREDENTIAL_ARTIFACT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.sh|\.ps1|-lark-config|-slack-config)|\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/i;

export class ImCredentialEnvironmentError extends Error {
  constructor(readonly code: string) {
    super("The provider CLI credential environment is unavailable");
    this.name = "ImCredentialEnvironmentError";
  }
}

interface PendingGrant {
  reject(error: Error): void;
  resolve(result: RuntimeImCredentialGrantResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ImCredentialEnvironmentManagerOptions {
  readonly connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames">;
  readonly exchangeFeishuToken?: (
    grant: Extract<RuntimeImCredentialGrantResult, { status: "succeeded" }>["grant"] & { provider: "feishu" },
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly home: string;
  readonly listArtifacts?: (root: string) => Promise<readonly string[]>;
  readonly logger?: Pick<ClientLogger, "warn">;
  readonly platform?: NodeJS.Platform;
  readonly removePath?: (path: string, options: { force: true; recursive?: true }) => Promise<void>;
  readonly writeEnvironmentFile?: (path: string, content: string, mode: number) => Promise<void>;
}

export interface ImCredentialGrantSubject {
  readonly agentId: string;
  readonly placementGeneration: number;
  readonly sessionId: string;
}

export interface PreparedImCredentialEnvironment {
  readonly outboxContext?: RuntimeImOutboxContext;
  readonly path: string;
  readonly provider: "feishu" | "slack";
  /** Private Slack CLI config leaf for this Session; omitted for Feishu. */
  readonly slackConfigDir?: string;
}

export class ImCredentialEnvironmentManager {
  readonly #connection: ImCredentialEnvironmentManagerOptions["connection"];
  readonly #exchangeFeishuToken: NonNullable<ImCredentialEnvironmentManagerOptions["exchangeFeishuToken"]>;
  readonly #platform: NodeJS.Platform;
  readonly #home: string;
  readonly #listArtifacts: NonNullable<ImCredentialEnvironmentManagerOptions["listArtifacts"]>;
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #removePath: NonNullable<ImCredentialEnvironmentManagerOptions["removePath"]>;
  readonly #root: string;
  readonly #startupCleanup: Promise<ImCredentialEnvironmentError | undefined>;
  readonly #writeEnvironmentFile: NonNullable<ImCredentialEnvironmentManagerOptions["writeEnvironmentFile"]>;
  readonly #pending = new Map<string, PendingGrant>();
  readonly #activeSessions = new Set<string>();
  readonly #activeSlackConfigDirs = new Map<string, string>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(options: ImCredentialEnvironmentManagerOptions) {
    this.#connection = options.connection;
    this.#exchangeFeishuToken = options.exchangeFeishuToken ?? exchangeFeishuTenantToken;
    this.#platform = options.platform ?? process.platform;
    this.#listArtifacts = options.listArtifacts ?? listArtifacts;
    this.#logger = options.logger ?? createLogger("im-credential-environment");
    this.#removePath = options.removePath ?? rm;
    this.#writeEnvironmentFile = options.writeEnvironmentFile ?? writeDurableFile;
    const layout = resolveOpenTagHomeLayout(options.home);
    this.#home = layout.home;
    this.#root = join(layout.runtime, "provider-credentials");
    this.#unsubscribe = this.#connection.subscribeBusinessFrames((frame) => this.#handleFrame(frame));
    this.#startupCleanup = this.#cleanupStaleArtifacts().then(
      () => undefined,
      (error: unknown) => credentialEnvironmentError(error, undefined, "stale_cleanup_failed"),
    );
  }

  pathForSession(sessionId: string): string {
    return this.#artifactPath(`${sessionId}${this.#platform === "win32" ? ".ps1" : ".sh"}`);
  }

  activeSlackConfigDirForSession(sessionId: string): string | undefined {
    return this.#activeSlackConfigDirs.get(sessionId);
  }

  async prepare(request: ImCredentialGrantSubject, signal?: AbortSignal): Promise<PreparedImCredentialEnvironment> {
    if (this.#closed) throw new ImCredentialEnvironmentError("client_shutdown");
    try {
      const startupFailure = await this.#startupCleanup;
      if (startupFailure) throw startupFailure;
      const result = await this.#requestGrant(request, signal);
      if (result.status === "rejected") throw new ImCredentialEnvironmentError(result.code);
      this.#activeSessions.add(request.sessionId);
      await ensurePrivateDirectory(this.#home, this.#root);
      const path = this.pathForSession(request.sessionId);
      if (result.grant.provider === "feishu") {
        const environment = await this.#feishuEnvironment(request.sessionId, result.grant, signal);
        await this.#writeEnvironmentFile(path, serializeEnvironment(environment, this.#platform), 0o600);
        return {
          path,
          provider: result.grant.provider,
          ...(result.outboxContext ? { outboxContext: result.outboxContext } : {}),
        };
      }
      const slack = await this.#slackEnvironment(request.sessionId, result.grant);
      await this.#writeEnvironmentFile(path, serializeEnvironment(slack.environment, this.#platform), 0o600);
      this.#activeSlackConfigDirs.set(request.sessionId, slack.configDir);
      return {
        path,
        provider: result.grant.provider,
        slackConfigDir: slack.configDir,
        ...(result.outboxContext ? { outboxContext: result.outboxContext } : {}),
      };
    } catch (error) {
      await this.cleanup(request.sessionId).catch(() => undefined);
      throw credentialEnvironmentError(error, signal, "credential_materialization_failed");
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const slackConfigDir = this.#slackConfigDirPath(sessionId);
    this.#activeSlackConfigDirs.delete(sessionId);
    const results = await Promise.allSettled([
      this.#removePath(this.pathForSession(sessionId), { force: true }),
      this.#removePath(this.#larkConfigDirPath(sessionId), { recursive: true, force: true }),
      this.#removePath(slackConfigDir, { recursive: true, force: true }),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      this.#activeSessions.add(sessionId);
      this.#diagnostic("IM_CREDENTIAL_CLEANUP_FAILED");
      throw new ImCredentialEnvironmentError("cleanup_failed");
    }
    this.#activeSessions.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new ImCredentialEnvironmentError("client_shutdown"));
      this.#pending.delete(requestId);
    }
    const startupFailure = await this.#startupCleanup;
    await Promise.all([...this.#activeSessions].map((sessionId) => this.cleanup(sessionId)));
    if (startupFailure) throw startupFailure;
  }

  async #cleanupStaleArtifacts(): Promise<void> {
    let artifacts: readonly string[];
    try {
      artifacts = await this.#listArtifacts(this.#root);
    } catch (error) {
      this.#diagnostic("IM_CREDENTIAL_STALE_SCAN_FAILED");
      throw credentialEnvironmentError(error, undefined, "stale_cleanup_failed");
    }
    const results = await Promise.allSettled(
      artifacts
        .filter((name) => MANAGED_CREDENTIAL_ARTIFACT.test(name))
        .map((name) =>
          this.#removePath(join(this.#root, name), {
            force: true,
            ...(name.endsWith("-lark-config") || name.endsWith("-slack-config") ? { recursive: true as const } : {}),
          }),
        ),
    );
    if (results.some((result) => result.status === "rejected")) {
      this.#diagnostic("IM_CREDENTIAL_STALE_CLEANUP_FAILED");
      throw new ImCredentialEnvironmentError("stale_cleanup_failed");
    }
  }

  #diagnostic(code: string): void {
    this.#logger.warn({ code }, "Provider credential environment cleanup failed");
  }

  async #slackEnvironment(
    sessionId: string,
    grant: Extract<RuntimeImCredentialGrantResult, { status: "succeeded" }>["grant"] & { provider: "slack" },
  ): Promise<{ configDir: string; environment: Record<string, string | undefined> }> {
    const configDir = await ensurePrivateDirectory(this.#root, this.#slackConfigDirPath(sessionId));
    return {
      configDir,
      environment: {
        SLACK_BOT_TOKEN: grant.botAccessToken,
        SLACK_USER_TOKEN: undefined,
        SLACK_APP_TOKEN: undefined,
        OPENTAG_SLACK_CONFIG_DIR: configDir,
        // Slack 4.6/4.7 empirically honor this undocumented variable. It is only a
        // redundant fallback; the exact-target Turn launcher always supplies the
        // documented --config-dir flag as the load-bearing mechanism.
        SLACK_CONFIG_DIR: configDir,
      },
    };
  }

  #slackConfigDirPath(sessionId: string): string {
    return this.#artifactPath(`${sessionId}-slack-config`);
  }

  #larkConfigDirPath(sessionId: string): string {
    return this.#artifactPath(`${sessionId}-lark-config`);
  }

  #artifactPath(name: string): string {
    const path = join(this.#root, name);
    assertWithin(this.#root, path);
    return path;
  }

  async #feishuEnvironment(
    sessionId: string,
    grant: Extract<RuntimeImCredentialGrantResult, { status: "succeeded" }>["grant"] & { provider: "feishu" },
    signal?: AbortSignal,
  ): Promise<Record<string, string | undefined>> {
    const configDir = this.#larkConfigDirPath(sessionId);
    await ensurePrivateDirectory(this.#root, configDir);
    const tenantAccessToken = await this.#exchangeFeishuToken(grant, signal);
    return {
      LARKSUITE_CLI_APP_ID: grant.appId,
      LARKSUITE_CLI_APP_SECRET: grant.appSecret,
      LARKSUITE_CLI_CONFIG_DIR: configDir,
      LARKSUITE_CLI_BRAND: grant.teamBrand,
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: tenantAccessToken,
      LARKSUITE_CLI_USER_ACCESS_TOKEN: undefined,
    };
  }

  #requestGrant(request: ImCredentialGrantSubject, signal?: AbortSignal): Promise<RuntimeImCredentialGrantResult> {
    if (signal?.aborted) return Promise.reject(new ImCredentialEnvironmentError("aborted"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        const pending = this.#pending.get(requestId);
        if (pending) clearTimeout(pending.timer);
        this.#pending.delete(requestId);
      };
      const onAbort = () => {
        cleanup();
        reject(new ImCredentialEnvironmentError("aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ImCredentialEnvironmentError("timeout"));
      }, GRANT_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(requestId, {
        timer,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.#connection
        .send(
          {
            type: "im:credential",
            requestId,
            sessionId: request.sessionId,
            agentId: request.agentId,
            placementGeneration: request.placementGeneration,
          },
          { priority: "result", signal },
        )
        .catch((error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new ImCredentialEnvironmentError("send_failed"));
        });
    });
  }

  #handleFrame(frame: RuntimeBusinessFrame): void {
    if (frame.type !== "im:credential:result") return;
    const result = frame as RuntimeImCredentialGrantResult;
    this.#pending.get(result.requestId)?.resolve(result);
  }
}

async function listArtifacts(root: string): Promise<readonly string[]> {
  try {
    return await readdir(root);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function credentialEnvironmentError(
  error: unknown,
  signal: AbortSignal | undefined,
  fallbackCode: string,
): ImCredentialEnvironmentError {
  if (error instanceof ImCredentialEnvironmentError) return error;
  return new ImCredentialEnvironmentError(signal?.aborted ? "aborted" : fallbackCode);
}

async function exchangeFeishuTenantToken(
  grant: { appId: string; appSecret: string; teamBrand: "feishu" | "lark" },
  signal?: AbortSignal,
): Promise<string> {
  const origin = grant.teamBrand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const response = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: grant.appId, app_secret: grant.appSecret }),
    signal,
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== "string") {
    throw new ImCredentialEnvironmentError("feishu_token_exchange_failed");
  }
  return body.tenant_access_token;
}

export function serializeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  const entries = Object.entries(environment);
  if (platform === "win32") {
    return `${entries
      .map(([key, value]) =>
        value === undefined
          ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue`
          : `$env:${key} = '${value.replaceAll("'", "''")}'`,
      )
      .join("\n")}\n`;
  }
  return `${entries
    .map(([key, value]) =>
      value === undefined ? `unset ${key}` : `export ${key}='${value.replaceAll("'", "'\"'\"'")}'`,
    )
    .join("\n")}\n`;
}
