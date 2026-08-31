import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  ProviderCliExpectedIdentity,
  ProviderCliValidationGrantFrame,
  ProviderCliValidationResultFrame,
} from "@opentag/shared";
import {
  RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES,
  RUNTIME_PROVIDER_CLI_VALIDATION_TIMEOUT_MS,
} from "@opentag/shared";
import { ensurePrivateDirectory } from "../../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../../storage/home-layout.js";
import { findProviderCliCatalogEntry } from "./catalog.js";
import { computeFileIdentity, computeTargetFingerprint } from "./fingerprint.js";
import { providerCliProbeEnvironment } from "./probe.js";
import {
  classifyLarkAuthStatus,
  classifySlackAuthTest,
  classifySpawnFailure,
  extractBoundedJson,
  type ProviderCliValidationClassification,
} from "./validation-classify.js";

const execFileAsync = promisify(execFile);
const PRIVATE_DIRS = ["home", "config", "tmp", "cache", "state", "runtime"] as const;

export function deriveProviderCliValidationRequestKey(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

export type ProviderCliValidationExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    signal?: AbortSignal;
    timeout: number;
    windowsHide: boolean;
  },
) => Promise<{ stderr: string; stdout: string }>;

export interface ProviderCliValidationRunnerOptions {
  readonly exchangeFeishuToken?: (
    grant: Extract<ProviderCliValidationGrantFrame["grant"], { provider: "feishu" }>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly execFile?: ProviderCliValidationExecFile;
  readonly fetch?: typeof fetch;
  readonly home: string;
  readonly now?: () => number;
  readonly verifyTarget?: (request: ProviderCliValidationRequest) => Promise<boolean>;
}

export interface ProviderCliValidationRequest {
  readonly expectedFingerprint: string;
  readonly expectedIdentity: ProviderCliExpectedIdentity;
  readonly expiresAt: string;
  readonly grant: ProviderCliValidationGrantFrame["grant"];
  readonly managedDigest?: string;
  readonly requestId: string;
  readonly targetPath: string;
  readonly version: string;
}

export class FeishuTokenExchangeError extends Error {
  constructor(readonly kind: "rate_limited" | "provider_unreachable" | "credential_rejected" | "aborted" | "invalid") {
    super("Feishu tenant token exchange failed");
    this.name = "FeishuTokenExchangeError";
  }
}

export class ProviderCliValidationRunner {
  readonly #exchangeFeishuToken: NonNullable<ProviderCliValidationRunnerOptions["exchangeFeishuToken"]>;
  readonly #execFile: ProviderCliValidationExecFile;
  readonly #home: string;
  readonly #now: () => number;
  readonly #root: string;
  readonly #verifyTarget: (request: ProviderCliValidationRequest) => Promise<boolean>;
  #busy = false;
  readonly #startupCleanup: Promise<void>;

  constructor(options: ProviderCliValidationRunnerOptions) {
    this.#exchangeFeishuToken =
      options.exchangeFeishuToken ??
      ((grant, signal) => exchangeFeishuTenantToken(grant, signal, options.fetch ?? fetch));
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#now = options.now ?? Date.now;
    this.#verifyTarget = options.verifyTarget ?? verifyTargetFingerprint;
    const layout = resolveOpenTagHomeLayout(options.home);
    this.#home = layout.home;
    this.#root = join(layout.runtime, "provider-cli-validation");
    this.#startupCleanup = this.cleanupAll();
  }

  async run(
    request: ProviderCliValidationRequest,
    fence: Omit<ProviderCliValidationResultFrame, "status" | "reason" | "type">,
    signal?: AbortSignal,
  ): Promise<Omit<ProviderCliValidationResultFrame, "type">> {
    await this.#startupCleanup;
    signal?.throwIfAborted();
    if (Date.parse(request.expiresAt) <= this.#now()) {
      return { ...fence, status: "retrying", reason: "validation_expired" };
    }
    if (this.#busy) {
      return { ...fence, status: "retrying", reason: "validation_busy" };
    }
    this.#busy = true;
    const requestKey = deriveProviderCliValidationRequestKey(request.requestId);
    const workDir = join(this.#root, requestKey);
    try {
      await rm(workDir, { recursive: true, force: true });
      await ensurePrivateDirectory(this.#home, workDir);
      await chmod(workDir, 0o700);
      for (const child of PRIVATE_DIRS) {
        await mkdir(join(workDir, child), { mode: 0o700 });
      }
      if (!(await this.#verifyTarget(request))) {
        return { ...fence, status: "retrying", reason: "artifact_changed" };
      }
      if (Date.parse(request.expiresAt) <= this.#now()) {
        return { ...fence, status: "retrying", reason: "validation_expired" };
      }
      const catalog = findProviderCliCatalogEntry(fence.provider);
      const env = scrubbedEnvironment(workDir, catalog?.managedEnvironment ?? {});
      let classification: ProviderCliValidationClassification;
      if (request.grant.provider === "slack") {
        env.SLACK_BOT_TOKEN = request.grant.botAccessToken;
        classification = await this.#runProcess(
          request.targetPath,
          ["--skip-update", "--config-dir", join(workDir, "config"), "api", "auth.test"],
          env,
          workDir,
          (payload) =>
            classifySlackAuthTest(
              payload,
              request.expectedIdentity as Extract<ProviderCliExpectedIdentity, { provider: "slack" }>,
            ),
          signal,
        );
      } else {
        const tenantAccessToken = await this.#exchangeFeishuToken(request.grant, signal);
        if (Date.parse(request.expiresAt) <= this.#now()) {
          return { ...fence, status: "retrying", reason: "validation_expired" };
        }
        env.LARKSUITE_CLI_APP_ID = request.grant.appId;
        env.LARKSUITE_CLI_APP_SECRET = request.grant.appSecret;
        env.LARKSUITE_CLI_CONFIG_DIR = join(workDir, "config");
        env.LARKSUITE_CLI_BRAND = request.grant.teamBrand;
        env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = tenantAccessToken;
        delete env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
        classification = await this.#runProcess(
          request.targetPath,
          ["auth", "status", "--verify", "--json"],
          env,
          workDir,
          (payload) =>
            classifyLarkAuthStatus(
              payload,
              request.expectedIdentity as Extract<ProviderCliExpectedIdentity, { provider: "feishu" }>,
            ),
          signal,
        );
      }
      return classification.status === "ready"
        ? { ...fence, status: "ready" }
        : {
            ...fence,
            status: classification.status,
            ...(classification.reason ? { reason: classification.reason } : {}),
          };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError();
      if (error instanceof FeishuTokenExchangeError) {
        if (error.kind === "aborted") throw abortError();
        if (error.kind === "rate_limited") return { ...fence, status: "retrying", reason: "rate_limited" };
        if (error.kind === "provider_unreachable") {
          return { ...fence, status: "retrying", reason: "provider_unreachable" };
        }
        if (error.kind === "credential_rejected") {
          return { ...fence, status: "needs_attention", reason: "credential_rejected" };
        }
        return { ...fence, status: "needs_attention" };
      }
      const classification = classifySpawnFailure(error);
      return classification.status === "ready"
        ? { ...fence, status: "ready" }
        : {
            ...fence,
            status: classification.status,
            ...(classification.reason ? { reason: classification.reason } : {}),
          };
    } finally {
      try {
        await rm(workDir, { recursive: true, force: true });
      } finally {
        this.#busy = false;
      }
    }
  }

  async cleanupAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const results = await Promise.allSettled(
      names.map((name) => rm(join(this.#root, name), { recursive: true, force: true })),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Provider CLI validation cleanup failed");
    }
  }

  async #runProcess(
    targetPath: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    classify: (payload: unknown) => ProviderCliValidationClassification,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationClassification> {
    if (!isAbsolute(targetPath)) return { status: "needs_attention" };
    signal?.throwIfAborted();
    try {
      const result = await this.#execFile(targetPath, args, {
        cwd,
        env,
        maxBuffer: RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES,
        timeout: RUNTIME_PROVIDER_CLI_VALIDATION_TIMEOUT_MS,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      });
      if (combinedBytes(result.stdout, result.stderr) > RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES) {
        return { status: "needs_attention" };
      }
      const payload = extractBoundedJson(result.stdout) ?? extractBoundedJson(result.stderr);
      if (payload === undefined) return { status: "needs_attention" };
      return classify(payload);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError();
      const output = processOutput(error);
      if (output && combinedBytes(output.stdout, output.stderr) > RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES) {
        return { status: "needs_attention" };
      }
      const payload = extractBoundedJson(output?.stdout ?? "") ?? extractBoundedJson(output?.stderr ?? "");
      if (payload !== undefined) return classify(payload);
      if (isTimeout(error)) return { status: "retrying", reason: "provider_unreachable" };
      throw error;
    }
  }
}

async function verifyTargetFingerprint(request: ProviderCliValidationRequest): Promise<boolean> {
  if (!isAbsolute(request.targetPath)) return false;
  try {
    const identity = await computeFileIdentity(request.targetPath);
    return computeTargetFingerprint(identity, request.version, request.managedDigest) === request.expectedFingerprint;
  } catch {
    return false;
  }
}

function scrubbedEnvironment(workDir: string, managedEnvironment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...providerCliProbeEnvironment(join(workDir, "home")),
    ...managedEnvironment,
    XDG_CONFIG_HOME: join(workDir, "config"),
    XDG_CACHE_HOME: join(workDir, "cache"),
    XDG_STATE_HOME: join(workDir, "state"),
    XDG_RUNTIME_DIR: join(workDir, "runtime"),
    TMPDIR: join(workDir, "tmp"),
    TMP: join(workDir, "tmp"),
    TEMP: join(workDir, "tmp"),
  };
  for (const key of [
    "SLACK_BOT_TOKEN",
    "SLACK_USER_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_CONFIG_DIR",
    "LARKSUITE_CLI_APP_ID",
    "LARKSUITE_CLI_APP_SECRET",
    "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
    "LARKSUITE_CLI_USER_ACCESS_TOKEN",
    "LARKSUITE_CLI_CONFIG_DIR",
  ]) {
    delete env[key];
  }
  return env;
}

function combinedBytes(stdout: string, stderr: string): number {
  return Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
}

function processOutput(error: unknown): { stdout: string; stderr: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return {
    stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
    stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
  };
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "killed" in error && error.killed === true;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") ||
    (error instanceof Error && error.message === "The operation was aborted")
  );
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    signal?: AbortSignal;
    timeout: number;
    windowsHide: boolean;
  },
): Promise<{ stderr: string; stdout: string }> {
  const result = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function exchangeFeishuTenantToken(
  grant: Extract<ProviderCliValidationGrantFrame["grant"], { provider: "feishu" }>,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = RUNTIME_PROVIDER_CLI_VALIDATION_TIMEOUT_MS,
): Promise<string> {
  if (signal?.aborted) throw new FeishuTokenExchangeError("aborted");
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const origin = grant.teamBrand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: grant.appId, app_secret: grant.appSecret }),
      signal: combined,
    });
  } catch {
    if (combined.aborted && signal?.aborted) throw new FeishuTokenExchangeError("aborted");
    throw new FeishuTokenExchangeError("provider_unreachable");
  }
  if (response.status === 429) throw new FeishuTokenExchangeError("rate_limited");
  if (response.status >= 500) throw new FeishuTokenExchangeError("provider_unreachable");
  const buffer = await readBoundedResponseBody(response, RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new FeishuTokenExchangeError(response.status >= 500 ? "provider_unreachable" : "invalid");
  }
  if (!response.ok) throw new FeishuTokenExchangeError("credential_rejected");
  if (!isRecord(body) || body.code !== 0 || typeof body.tenant_access_token !== "string") {
    throw new FeishuTokenExchangeError("credential_rejected");
  }
  return body.tenant_access_token;
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new FeishuTokenExchangeError("invalid");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
