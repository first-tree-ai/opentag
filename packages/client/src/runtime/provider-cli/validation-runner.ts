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
import { type ClientLogger, createLogger } from "../../observability/logger.js";
import { ensurePrivateDirectory } from "../../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../../storage/home-layout.js";
import { runtimeProxyErrorReason } from "../runtime-credential-frames.js";
import { findProviderCliCatalogEntry } from "./catalog.js";
import { computeFileIdentity, computeTargetFingerprint } from "./fingerprint.js";
import { providerCliProbeEnvironment } from "./probe.js";
import {
  classifyLarkAuthStatus,
  classifySlackAuthTest,
  classifySpawnFailure,
  extractBoundedJson,
  isFeishuCredentialRejectedCode,
  isFeishuRateLimitCode,
  isLocalValidationError,
  type ProviderCliValidationClassification,
} from "./validation-classify.js";

const execFileAsync = promisify(execFile);
const defaultValidationLogger = createLogger("provider-cli-validation");
const PRIVATE_DIRS = ["home", "config", "tmp", "cache", "state", "runtime"] as const;
const MAX_WAITING_VALIDATIONS = 8;

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

/**
 * One Server-authorized validation execution: read-only identity scope, no business
 * Session, no raw grant material. The environment carries execution-local handles and
 * loopback TLS settings only; `signal` fires when the Server revokes the execution.
 */
export interface ProviderCliProxyValidationSession {
  /** Extra CLI flags inserted after the managed `--skip-update --config-dir` prefix. */
  readonly arguments?: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  cleanup(): Promise<void>;
}

export interface ProviderCliValidationRunnerOptions {
  readonly exchangeFeishuToken?: (
    grant: Extract<ProviderCliValidationGrantFrame["grant"], { provider: "feishu" }>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly execFile?: ProviderCliValidationExecFile;
  readonly fetch?: typeof fetch;
  readonly home: string;
  readonly logger?: ClientLogger;
  readonly now?: () => number;
  /**
   * Proxy credential mode: raw grant material is never accepted. Proxy mode requires
   * `openProxyValidation` to open a Server-issued validation execution
   * (`source.kind === "validation"`); without it readiness clearly rejects
   * (`needs_attention`) instead of falling back to raw Cloud tokens.
   */
  readonly openProxyValidation?: (
    request: ProviderCliValidationRequest,
    signal?: AbortSignal,
  ) => Promise<ProviderCliProxyValidationSession | undefined>;
  readonly proxyCredentialMode?: boolean;
  readonly verifyTarget?: (request: ProviderCliValidationRequest) => Promise<boolean>;
}

export interface ProviderCliValidationRequest {
  readonly expectedFingerprint: string;
  readonly expectedIdentity: ProviderCliExpectedIdentity;
  readonly expiresAt: string;
  /** Legacy Local raw material; proxy validation runs carry `validationRunId` instead. */
  readonly grant?: ProviderCliValidationGrantFrame["grant"];
  /** Proxy mode: Server-issued validation run identity (never invented by the Client). */
  readonly validationRunId?: string;
  /** Proxy mode: Agent the Server fenced the validation run to. */
  readonly agentId?: string;
  readonly managedDigest?: string;
  readonly requestId: string;
  readonly targetPath: string;
  readonly version: string;
}

type ProviderCliValidationGrantRequest = ProviderCliValidationRequest & {
  readonly grant: ProviderCliValidationGrantFrame["grant"];
};

type ProviderCliValidationFence = Omit<ProviderCliValidationResultFrame, "status" | "reason" | "type">;
type ProviderCliValidationResult = Omit<ProviderCliValidationResultFrame, "type">;

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
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #openProxyValidation?: ProviderCliValidationRunnerOptions["openProxyValidation"];
  readonly #proxyCredentialMode: boolean;
  readonly #root: string;
  readonly #verifyTarget: (request: ProviderCliValidationRequest) => Promise<boolean>;
  readonly #startupCleanup: Promise<void>;
  readonly #validationWaiters = new Set<() => void>();
  #validating = false;

  constructor(options: ProviderCliValidationRunnerOptions) {
    this.#exchangeFeishuToken =
      options.exchangeFeishuToken ??
      ((grant, signal) => exchangeFeishuTenantToken(grant, signal, options.fetch ?? fetch));
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#now = options.now ?? Date.now;
    this.#openProxyValidation = options.openProxyValidation;
    this.#proxyCredentialMode = options.proxyCredentialMode ?? false;
    this.#verifyTarget = options.verifyTarget ?? verifyTargetFingerprint;
    const layout = resolveOpenTagHomeLayout(options.home);
    this.#home = layout.home;
    this.#logger = options.logger ?? createLogger("provider-cli-validation");
    this.#root = join(layout.runtime, "provider-cli-validation");
    this.#startupCleanup = this.cleanupAll();
  }

  async run(
    request: ProviderCliValidationRequest,
    fence: ProviderCliValidationFence,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationResult> {
    await this.#startupCleanup;
    signal?.throwIfAborted();
    if (this.#proxyCredentialMode && (!this.#openProxyValidation || !request.validationRunId)) {
      return { ...fence, status: "needs_attention" };
    }
    const expiresAt = Date.parse(request.expiresAt);
    if (expiresAt <= this.#now()) {
      return { ...fence, status: "retrying", reason: "validation_expired" };
    }
    if (this.#validating) {
      if (this.#validationWaiters.size >= MAX_WAITING_VALIDATIONS) {
        return { ...fence, status: "retrying", reason: "validation_busy" };
      }
      if (!(await this.#waitForValidationSlot(expiresAt, signal))) {
        return { ...fence, status: "retrying", reason: "validation_expired" };
      }
    }
    this.#validating = true;
    try {
      signal?.throwIfAborted();
      if (expiresAt <= this.#now()) return { ...fence, status: "retrying", reason: "validation_expired" };
      return this.#proxyCredentialMode
        ? await this.#runProxyValidation(request, fence, signal)
        : await this.#runLocalValidation(request, fence, signal);
    } finally {
      // Transfer ownership before another caller can bypass the oldest waiter.
      const next = this.#validationWaiters.values().next().value;
      if (next) next();
      else this.#validating = false;
    }
  }

  #waitForValidationSlot(expiresAt: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const removeWaiter = () => {
        clearTimeout(expiryTimer);
        signal?.removeEventListener("abort", onAbort);
        this.#validationWaiters.delete(start);
      };
      const start = () => {
        removeWaiter();
        resolve(true);
      };
      const onAbort = () => {
        removeWaiter();
        reject(abortError());
      };
      const expiryTimer = setTimeout(
        () => {
          removeWaiter();
          resolve(false);
        },
        Math.min(expiresAt - this.#now(), 2_147_483_647),
      );
      this.#validationWaiters.add(start);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #runLocalValidation(
    request: ProviderCliValidationRequest,
    fence: ProviderCliValidationFence,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationResult> {
    const requestKey = deriveProviderCliValidationRequestKey(request.requestId);
    const workDir = join(this.#root, requestKey);
    try {
      await this.#prepareWorkDirectory(workDir);
      if (!(await this.#verifyTarget(request))) {
        return { ...fence, status: "retrying", reason: "artifact_changed" };
      }
      signal?.throwIfAborted();
      if (Date.parse(request.expiresAt) <= this.#now()) {
        return { ...fence, status: "retrying", reason: "validation_expired" };
      }
      const catalog = findProviderCliCatalogEntry(fence.provider);
      const env = scrubbedEnvironment(workDir, catalog?.managedEnvironment ?? {});
      if (!request.grant) return { ...fence, status: "needs_attention" };
      const classification = await this.#classifyRequest(
        request as ProviderCliValidationGrantRequest,
        env,
        workDir,
        signal,
      );
      return validationResult(fence, classification);
    } catch (error) {
      this.#logger.debug(
        {
          code: validationRunFailureCode(error),
          error: runtimeProxyErrorReason(error),
        },
        "Provider CLI validation run failed",
      );
      return validationFailureResult(fence, error, signal, this.#logger);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async #prepareWorkDirectory(workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
    await ensurePrivateDirectory(this.#home, workDir);
    await chmod(workDir, 0o700);
    await Promise.all(PRIVATE_DIRS.map((child) => mkdir(join(workDir, child), { mode: 0o700 })));
  }

  /**
   * Proxy readiness: open a Server-issued validation execution with read-only identity
   * scope, run the same native identity probe with the execution-local environment, and
   * always release the execution before reporting. Missing validation authority is an
   * explicit `needs_attention`; raw grant material is never used.
   */
  async #runProxyValidation(
    request: ProviderCliValidationRequest,
    fence: ProviderCliValidationFence,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationResult> {
    const requestKey = deriveProviderCliValidationRequestKey(request.requestId);
    const workDir = join(this.#root, requestKey);
    let session: ProviderCliProxyValidationSession | undefined;
    try {
      await this.#prepareWorkDirectory(workDir);
      if (!(await this.#verifyTarget(request))) {
        return { ...fence, status: "retrying", reason: "artifact_changed" };
      }
      signal?.throwIfAborted();
      if (Date.parse(request.expiresAt) <= this.#now()) {
        return { ...fence, status: "retrying", reason: "validation_expired" };
      }
      session = await this.#openProxyValidation?.(request, signal);
      if (!session) return { ...fence, status: "needs_attention" };
      const combinedSignal = combineSignals(signal, session.signal);
      combinedSignal?.throwIfAborted();
      if (Date.parse(request.expiresAt) <= this.#now()) {
        return { ...fence, status: "retrying", reason: "validation_expired" };
      }
      const catalog = findProviderCliCatalogEntry(fence.provider);
      const env = applySessionEnvironment(
        scrubbedEnvironment(workDir, catalog?.managedEnvironment ?? {}),
        session.environment,
      );
      const classification = await this.#classifyProxyRequest(
        fence.provider,
        request,
        env,
        workDir,
        session.arguments ?? [],
        combinedSignal,
      );
      return validationResult(fence, classification);
    } catch (error) {
      this.#logger.debug(
        {
          code: validationRunFailureCode(error),
          error: runtimeProxyErrorReason(error),
        },
        "Provider CLI proxy validation run failed",
      );
      return validationFailureResult(fence, error, signal, this.#logger);
    } finally {
      await session?.cleanup().catch((error: unknown) => {
        this.#logger.debug(
          { code: "validation_session_cleanup_failed", error: runtimeProxyErrorReason(error) },
          "Proxy validation session cleanup failed",
        );
      });
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Read-only identity probes only; the Server enforces the validation purpose scope. */
  async #classifyProxyRequest(
    provider: "feishu" | "slack",
    request: ProviderCliValidationRequest,
    env: NodeJS.ProcessEnv,
    workDir: string,
    extraArguments: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationClassification> {
    if (provider === "slack") {
      return this.#runProcess(
        request.targetPath,
        ["--skip-update", "--config-dir", join(workDir, "config"), ...extraArguments, "api", "auth.test"],
        env,
        workDir,
        (payload) =>
          classifySlackAuthTest(
            payload,
            request.expectedIdentity as Extract<ProviderCliExpectedIdentity, { provider: "slack" }>,
            this.#logger,
          ),
        signal,
      );
    }
    if (provider === "feishu" && request.expectedIdentity.provider === "feishu") {
      env.LARKSUITE_CLI_REMOTE_META = "off";
      return this.#runProcess(
        request.targetPath,
        ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson", ...extraArguments],
        env,
        workDir,
        (payload) =>
          classifyLarkAuthStatus(
            payload,
            request.expectedIdentity as Extract<ProviderCliExpectedIdentity, { provider: "feishu" }>,
            this.#logger,
          ),
        signal,
      );
    }
    return { status: "needs_attention" };
  }

  async #classifyRequest(
    request: ProviderCliValidationGrantRequest,
    env: NodeJS.ProcessEnv,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationClassification> {
    if (request.grant.provider === "slack") {
      env.SLACK_BOT_TOKEN = request.grant.botAccessToken;
      return this.#runProcess(
        request.targetPath,
        ["--skip-update", "--config-dir", join(workDir, "config"), "api", "auth.test"],
        env,
        workDir,
        (payload) =>
          classifySlackAuthTest(
            payload,
            request.expectedIdentity as Extract<ProviderCliExpectedIdentity, { provider: "slack" }>,
            this.#logger,
          ),
        signal,
      );
    }
    return this.#classifyFeishuRequest(request, env, workDir, signal);
  }

  async #classifyFeishuRequest(
    request: ProviderCliValidationGrantRequest,
    env: NodeJS.ProcessEnv,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<ProviderCliValidationClassification> {
    if (request.grant.provider !== "feishu") return { status: "needs_attention" };
    if (request.expectedIdentity.provider !== "feishu") {
      return { status: "needs_attention", reason: "identity_mismatch" };
    }
    const expectedIdentity = request.expectedIdentity;
    if (request.grant.appId !== expectedIdentity.appId || request.grant.teamBrand !== expectedIdentity.teamBrand) {
      return { status: "needs_attention", reason: "identity_mismatch" };
    }
    const tenantAccessToken = await this.#exchangeFeishuToken(request.grant, signal);
    if (Date.parse(request.expiresAt) <= this.#now()) {
      return { status: "retrying", reason: "validation_expired" };
    }
    env.LARKSUITE_CLI_APP_ID = request.grant.appId;
    env.LARKSUITE_CLI_CONFIG_DIR = join(workDir, "config");
    env.LARKSUITE_CLI_BRAND = request.grant.teamBrand;
    env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN = tenantAccessToken;
    env.LARKSUITE_CLI_REMOTE_META = "off";
    delete env.LARKSUITE_CLI_APP_SECRET;
    delete env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
    return this.#runProcess(
      request.targetPath,
      ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson"],
      env,
      workDir,
      (payload) => classifyLarkAuthStatus(payload, expectedIdentity, this.#logger),
      signal,
    );
  }

  async cleanupAll(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.#logger.debug(
        { code: "validation_cleanup_scan_failed", error: runtimeProxyErrorReason(error) },
        "Provider CLI validation cleanup scan failed",
      );
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
      signal?.throwIfAborted();
      return classifyProcessOutput(result, classify, this.#logger);
    } catch (error) {
      this.#logger.debug(
        {
          code: validationProcessFailureCode(error),
          error: runtimeProxyErrorReason(error),
        },
        "Provider CLI validation process failed",
      );
      return classifyProcessFailure(error, signal, classify, this.#logger);
    }
  }
}

function validationRunFailureCode(error: unknown): "validation_local_setup_failed" | "validation_run_failed" {
  return isLocalValidationError(error) ? "validation_local_setup_failed" : "validation_run_failed";
}

function validationProcessFailureCode(error: unknown): "validation_process_spawn_failed" | "validation_process_failed" {
  return isLocalValidationError(error) ? "validation_process_spawn_failed" : "validation_process_failed";
}

function applySessionEnvironment(
  env: NodeJS.ProcessEnv,
  sessionEnvironment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(sessionEnvironment)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}

function validationResult(
  fence: ProviderCliValidationFence,
  classification: ProviderCliValidationClassification,
): ProviderCliValidationResult {
  if (classification.status === "ready") return { ...fence, status: "ready" };
  return {
    ...fence,
    status: classification.status,
    ...(classification.reason ? { reason: classification.reason } : {}),
  };
}

function validationFailureResult(
  fence: ProviderCliValidationFence,
  error: unknown,
  signal?: AbortSignal,
  logger: ClientLogger = defaultValidationLogger,
): ProviderCliValidationResult {
  if (isAbortError(error) || signal?.aborted) throw abortError();
  if (!(error instanceof FeishuTokenExchangeError)) return validationResult(fence, classifySpawnFailure(error, logger));
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

function classifyProcessOutput(
  output: { readonly stderr: string; readonly stdout: string },
  classify: (payload: unknown) => ProviderCliValidationClassification,
  logger: ClientLogger,
): ProviderCliValidationClassification {
  if (combinedBytes(output.stdout, output.stderr) > RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES) {
    return { status: "needs_attention" };
  }
  const payload =
    extractBoundedJson(output.stdout, RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES, logger) ??
    extractBoundedJson(output.stderr, RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES, logger);
  return payload === undefined ? { status: "retrying", reason: "provider_unreachable" } : classify(payload);
}

function classifyProcessFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  classify: (payload: unknown) => ProviderCliValidationClassification,
  logger: ClientLogger,
): ProviderCliValidationClassification {
  if (isAbortError(error) || signal?.aborted) throw abortError();
  const output = processOutput(error);
  if (output && combinedBytes(output.stdout, output.stderr) > RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES) {
    return { status: "needs_attention" };
  }
  const payload =
    extractBoundedJson(output?.stdout ?? "", RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES, logger) ??
    extractBoundedJson(output?.stderr ?? "", RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES, logger);
  if (payload !== undefined) return classify(payload);
  return classifySpawnFailure(error, logger);
}

async function verifyTargetFingerprint(request: ProviderCliValidationRequest): Promise<boolean> {
  if (!isAbsolute(request.targetPath)) return false;
  try {
    const identity = await computeFileIdentity(request.targetPath);
    return computeTargetFingerprint(identity, request.version, request.managedDigest) === request.expectedFingerprint;
  } catch (error) {
    defaultValidationLogger.debug(
      { code: "validation_target_verification_failed", error: runtimeProxyErrorReason(error) },
      "Provider CLI validation target verification failed",
    );
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
  } catch (error) {
    defaultValidationLogger.debug(
      { code: "feishu_token_exchange_request_failed", error: runtimeProxyErrorReason(error) },
      "Feishu tenant token exchange request failed",
    );
    if (combined.aborted && signal?.aborted) throw new FeishuTokenExchangeError("aborted");
    throw new FeishuTokenExchangeError("provider_unreachable");
  }
  if (response.status === 429) throw new FeishuTokenExchangeError("rate_limited");
  if (response.status >= 500) throw new FeishuTokenExchangeError("provider_unreachable");
  const buffer = await readBoundedResponseBody(response, RUNTIME_PROVIDER_CLI_VALIDATION_MAX_OUTPUT_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    defaultValidationLogger.debug(
      { code: "feishu_token_exchange_invalid_json", error: runtimeProxyErrorReason(error) },
      "Feishu tenant token exchange response was invalid",
    );
    throw new FeishuTokenExchangeError(response.status >= 500 ? "provider_unreachable" : "invalid");
  }
  return tenantTokenFromBody(body, response.ok);
}

function tenantTokenFromBody(body: unknown, ok: boolean): string {
  if (!isRecord(body)) throw new FeishuTokenExchangeError("credential_rejected");
  if (isFeishuRateLimitCode(body.code)) throw new FeishuTokenExchangeError("rate_limited");
  if (isFeishuCredentialRejectedCode(body.code)) throw new FeishuTokenExchangeError("credential_rejected");
  if (typeof body.code === "number" && body.code !== 0) {
    throw new FeishuTokenExchangeError("provider_unreachable");
  }
  if (!ok || body.code !== 0 || typeof body.tenant_access_token !== "string") {
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
