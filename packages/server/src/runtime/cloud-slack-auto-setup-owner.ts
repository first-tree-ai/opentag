import { isDeepStrictEqual } from "node:util";
import {
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAutoSetupCommand,
  type SlackAutoSetupRuntimeRequest,
  type SlackAutoSetupRuntimeResult,
  SlackProvisionCredentialsSchema,
  slackAppCreationManifest,
} from "@opentag/shared";
import { z } from "zod";

type Result = SlackAutoSetupRuntimeResult["result"];
type Failure = Extract<Result, { status: "failed" }>["code"];
type NativeLogin = {
  teamId: string;
  teamDomain: string;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  updatedAt: number;
};
type CreationState =
  | { status: "uncertain" }
  | {
      status: "created";
      appId: string;
      teamId?: string;
      signingSecret?: string;
      approvalPending?: boolean;
      approvalDenied?: boolean;
      connected?: boolean;
    };
type ProjectState = {
  authorization: { ticket?: string; teamId?: string };
  creation?: CreationState;
};

class SetupFailure extends Error {
  constructor(
    readonly code: Failure,
    readonly errorCode?: string,
  ) {
    super(code);
  }
}

const SLACK_API_ORIGIN = "https://slack.com/api";
const SLACK_CLI_VERSION = "4.10.0";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_TEAMS_PER_COMPUTER = 16;
const TOKEN_ROTATION_WINDOW_SECONDS = 300;
const APPROVAL_REQUEST_REASON =
  "This request has been automatically generated according to project environment settings.";

// Only fixed codes may cross the credential boundary. Never return upstream error messages or tokens.
const SAFE_ERROR_CODES = new Set([
  "invalid_auth",
  "token_expired",
  "token_revoked",
  "not_authed",
  "missing_scope",
  "access_denied",
  "no_permission",
  "not_allowed_token_type",
  "app_approval_request_denied",
  "comment_required",
  "invalid_manifest",
  "invalid_arguments",
  "ratelimited",
  "http_request_failed",
  "http_response_invalid",
  "app_install_error",
  "app_deploy_error",
  "app_found",
  "sdk_hook_invocation_failed",
  "prompt_interactivity_required",
]);

// Only documented pre-creation rejections are safe to retry. Internal/unknown failures may be partial.
const CREATE_REJECTIONS = new Set([
  "access_denied",
  "account_inactive",
  "feature_not_enabled",
  "invalid_app",
  "invalid_arguments",
  "invalid_auth",
  "invalid_manifest",
  "invalid_team_id",
  "managed_app_limit_reached",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_team",
  "ratelimited",
  "token_expired",
  "token_revoked",
]);

function safeErrorCode(error: unknown): string | undefined {
  return typeof error === "string" && SAFE_ERROR_CODES.has(error) ? error : undefined;
}

/**
 * Direct HTTPS Slack App management for Cloud Agents.
 *
 * Secrets (workspace login tokens, pending tickets, and pre-bind signing secrets) are bounded by
 * TTL (`ttlMs`) and LRU caps (`maxEntries` Computers/projects and `maxTeamsPerComputer` teams per
 * Computer). Unresolved App creation fences (`uncertain` or `created` before `callbacks` completes)
 * are never capacity-evicted within the process lifetime, and an unforced `authorize` or
 * unchallenged `install` against an empty project fails closed with `manual_required` so a Server
 * restart cannot silently issue a fresh ticket that creates a duplicate App.
 */
export class CloudSlackAutoSetupOwner {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #callTimeoutMs: number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxTeamsPerComputer: number;
  #pending = new Map<string, { abort: () => void; finish: (result: Result) => void }>();
  #logins = new Map<string, { updatedAt: number; teams: Map<string, NativeLogin> }>();
  #projects = new Map<string, { updatedAt: number; state: ProjectState }>();

  constructor(
    options: {
      fetchImpl?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      callTimeoutMs?: number;
      ttlMs?: number;
      maxEntries?: number;
      maxTeamsPerComputer?: number;
    } = {},
  ) {
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#timeoutMs = options.timeoutMs ?? 240_000;
    this.#callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxTeamsPerComputer = options.maxTeamsPerComputer ?? DEFAULT_MAX_TEAMS_PER_COMPUTER;
  }

  async start(input: Omit<SlackAutoSetupRuntimeRequest, "type" | "requestId">): Promise<Result> {
    if (this.#pending.size >= 32 || this.#pending.has(input.computerId)) {
      return { status: "failed", code: "busy" };
    }
    const controller = new AbortController();
    return new Promise<Result>((resolve) => {
      const finish = (result: Result) => {
        if (this.#pending.get(input.computerId) !== entry) return;
        clearTimeout(timer);
        this.#pending.delete(input.computerId);
        resolve(result);
      };
      const entry = { abort: () => controller.abort(), finish };
      const timer = setTimeout(() => {
        controller.abort();
        finish({ status: "failed", code: "computer_unavailable" });
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(input.computerId, entry);
      void this.#execute(input, controller.signal)
        .then(finish)
        .catch((error) => finish(this.#failure(error)));
    });
  }

  close(): void {
    for (const pending of [...this.#pending.values()]) {
      pending.abort();
      pending.finish({ status: "failed", code: "computer_unavailable" });
    }
  }

  async #execute(
    request: Omit<SlackAutoSetupRuntimeRequest, "type" | "requestId">,
    signal: AbortSignal,
  ): Promise<Result> {
    const now = this.#now();
    this.#prune(now);
    const projectKey = `${request.computerId}:${request.agentId}`;
    const project = this.#project(projectKey, now);
    const logins = this.#loginsFor(request.computerId, now);
    if (request.input.action === "authorize") {
      return this.#authorize(project, logins, signal, request.input.force);
    }
    if (request.input.action === "callbacks") {
      return this.#callbacks(project, logins, request.input, signal);
    }
    return this.#install(project, logins, request.agentId, request.input, signal);
  }

  #prune(now: number): void {
    this.#pruneProjects(now);
    this.#pruneLogins(now);
  }

  #pruneProjects(now: number): void {
    for (const [key, entry] of this.#projects) {
      if (now - entry.updatedAt < this.#ttlMs) continue;
      const { creation, authorization } = entry.state;
      if (!creation) {
        this.#projects.delete(key);
        continue;
      }
      // Expire secrets/tickets after TTL while preserving the tiny App creation fence.
      delete authorization.ticket;
      if (creation.status === "created") delete creation.signingSecret;
    }
  }

  #pruneLogins(now: number): void {
    for (const [computerId, entry] of this.#logins) {
      if (now - entry.updatedAt >= this.#ttlMs) {
        this.#logins.delete(computerId);
        continue;
      }
      this.#pruneTeamLogins(entry.teams, now);
    }
  }

  #pruneTeamLogins(teams: Map<string, NativeLogin>, now: number): void {
    for (const [teamId, login] of teams) {
      if (now - login.updatedAt >= this.#ttlMs) teams.delete(teamId);
    }
  }

  #project(key: string, now: number): ProjectState {
    const existing = this.#projects.get(key);
    if (existing) {
      this.#projects.delete(key);
      existing.updatedAt = now;
      this.#projects.set(key, existing);
      return existing.state;
    }
    this.#evictProjectsIfNeeded();
    const state: ProjectState = { authorization: {} };
    this.#projects.set(key, { updatedAt: now, state });
    return state;
  }

  #evictProjectsIfNeeded(): void {
    this.#evictResolvedProjectsIfNeeded();
    const activeCount = [...this.#projects.values()].filter(
      (entry) =>
        !entry.state.creation ||
        Boolean(entry.state.authorization.ticket) ||
        (entry.state.creation.status === "created" && Boolean(entry.state.creation.signingSecret)),
    ).length;
    if (activeCount < this.#maxEntries) return;
    // Prefer evicting transient authorize-only entries so other tenants cannot drop an App creation fence.
    for (const [candidateKey, candidate] of this.#projects) {
      if (!candidate.state.creation) {
        this.#projects.delete(candidateKey);
        return;
      }
    }
    // If all active entries have creation fences, strip secrets on the oldest one while keeping its fence.
    for (const candidate of this.#projects.values()) {
      const creation = candidate.state.creation;
      if (candidate.state.authorization.ticket || (creation?.status === "created" && creation.signingSecret)) {
        delete candidate.state.authorization.ticket;
        if (creation?.status === "created") delete creation.signingSecret;
        break;
      }
    }
  }

  #evictResolvedProjectsIfNeeded(): void {
    let resolvedCount = 0;
    let oldestResolvedKey: string | undefined;
    for (const [key, entry] of this.#projects) {
      if (entry.state.creation?.status === "created" && entry.state.creation.connected) {
        resolvedCount += 1;
        oldestResolvedKey ??= key;
      }
    }
    if (resolvedCount >= this.#maxEntries && oldestResolvedKey !== undefined) {
      this.#projects.delete(oldestResolvedKey);
    }
  }

  #loginsFor(computerId: string, now: number): Map<string, NativeLogin> {
    const existing = this.#logins.get(computerId);
    if (existing) {
      this.#logins.delete(computerId);
      existing.updatedAt = now;
      this.#logins.set(computerId, existing);
      return existing.teams;
    }
    if (this.#logins.size >= this.#maxEntries) {
      const oldest = this.#logins.keys().next().value;
      if (oldest !== undefined) this.#logins.delete(oldest);
    }
    const teams = new Map<string, NativeLogin>();
    this.#logins.set(computerId, { updatedAt: now, teams });
    return teams;
  }

  #setTeamLogin(logins: Map<string, NativeLogin>, login: NativeLogin): void {
    if (logins.has(login.teamId)) {
      logins.delete(login.teamId);
    } else if (logins.size >= this.#maxTeamsPerComputer) {
      const oldest = logins.keys().next().value;
      if (oldest !== undefined) logins.delete(oldest);
    }
    logins.set(login.teamId, login);
  }

  #failure(error: unknown): Extract<Result, { status: "failed" }> {
    return {
      status: "failed",
      code: error instanceof SetupFailure ? error.code : "failed",
      ...(error instanceof SetupFailure && error.errorCode ? { errorCode: error.errorCode } : {}),
    };
  }

  async #authorize(
    project: ProjectState,
    logins: Map<string, NativeLogin>,
    signal: AbortSignal,
    force = false,
  ): Promise<Result> {
    const fenced = this.#fencedAuthorization(project, logins, force);
    if (fenced) return fenced;
    const stored = project.authorization.teamId ? logins.get(project.authorization.teamId) : undefined;
    if (stored && !force && !project.authorization.ticket) {
      return { status: "authorized", teamName: stored.teamDomain };
    }
    // An unforced authorize against an empty Cloud project fails closed to manual_required so a
    // Server restart cannot silently issue a fresh ticket that creates a duplicate App.
    if (!project.creation && !project.authorization.teamId && !project.authorization.ticket && !force) {
      return { status: "failed", code: "manual_required" };
    }
    const response = await this.#postForm(
      "apps.hosted.generateAuthTicket",
      { slack_cli_version: SLACK_CLI_VERSION },
      signal,
      "authorization_failed",
    );
    const parsed = z.object({ ok: z.literal(true), ticket: z.string().min(1) }).safeParse(response);
    if (!parsed.success) throw new SetupFailure("authorization_failed");
    project.authorization = {
      ticket: parsed.data.ticket,
      ...(project.authorization.teamId ? { teamId: project.authorization.teamId } : {}),
    };
    return { status: "authorization_required", ticket: parsed.data.ticket };
  }

  #fencedAuthorization(project: ProjectState, logins: Map<string, NativeLogin>, force: boolean): Result | undefined {
    const creation = project.creation;
    if (!creation) return undefined;
    if (creation.status === "uncertain") return { status: "failed", code: "create_uncertain" };
    if (force) return undefined;
    return this.#fencedCreatedAuthorization(project, creation, logins);
  }

  #fencedCreatedAuthorization(
    project: ProjectState,
    creation: Extract<CreationState, { status: "created" }>,
    logins: Map<string, NativeLogin>,
  ): Result | undefined {
    const { appId, teamId, signingSecret, approvalDenied, approvalPending } = creation;
    if (approvalDenied) {
      return { status: "failed", code: "approval_denied", appId, ...(teamId ? { teamId } : {}) };
    }
    if (approvalPending && teamId) {
      return signingSecret
        ? { status: "approval_pending", appId, teamId }
        : { status: "failed", code: "manual_required", appId, teamId };
    }
    if (signingSecret) return undefined;
    const stored = project.authorization.teamId ? logins.get(project.authorization.teamId) : undefined;
    if (stored && !project.authorization.ticket) {
      return { status: "authorized", teamName: stored.teamDomain };
    }
    return { status: "failed", code: "manual_required", appId, ...(teamId ? { teamId } : {}) };
  }

  async #team(
    project: ProjectState,
    logins: Map<string, NativeLogin>,
    signal: AbortSignal,
    challenge?: string,
    expectedTeam?: string,
  ): Promise<{ teamId: string; token: string }> {
    if (project.authorization.teamId && !project.authorization.ticket) {
      return this.#storedTeam(project.authorization.teamId, logins, signal, expectedTeam);
    }
    return this.#exchangeTicket(project, logins, signal, challenge, expectedTeam);
  }

  async #storedTeam(
    teamId: string,
    logins: Map<string, NativeLogin>,
    signal: AbortSignal,
    expectedTeam?: string,
  ): Promise<{ teamId: string; token: string }> {
    if (expectedTeam && teamId !== expectedTeam) throw new SetupFailure("authorization_failed");
    const stored = logins.get(teamId);
    if (!stored) throw new SetupFailure("authorization_failed");
    const now = this.#now();
    stored.updatedAt = now;
    this.#setTeamLogin(logins, stored);
    const nowSeconds = Math.floor(now / 1_000);
    const shouldRotate =
      Boolean(stored.refreshToken) &&
      (stored.expiresAt === undefined || nowSeconds + TOKEN_ROTATION_WINDOW_SECONDS >= stored.expiresAt);
    if (!shouldRotate || !stored.refreshToken) return { teamId: stored.teamId, token: stored.token };
    const rotatedResponse = await this.#postForm(
      "tooling.tokens.rotate",
      { refresh_token: stored.refreshToken },
      signal,
      "authorization_failed",
    );
    const rotated = z
      .object({
        ok: z.literal(true),
        token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        exp: z.number().int().optional(),
        team_id: z.string().min(1).optional(),
      })
      .safeParse(rotatedResponse);
    if (!rotated.success || (rotated.data.team_id && rotated.data.team_id !== stored.teamId)) {
      throw new SetupFailure("authorization_failed");
    }
    stored.token = rotated.data.token;
    if (rotated.data.refresh_token) stored.refreshToken = rotated.data.refresh_token;
    if (rotated.data.exp !== undefined) stored.expiresAt = rotated.data.exp;
    return { teamId: stored.teamId, token: stored.token };
  }

  async #exchangeTicket(
    project: ProjectState,
    logins: Map<string, NativeLogin>,
    signal: AbortSignal,
    challenge?: string,
    expectedTeam?: string,
  ): Promise<{ teamId: string; token: string }> {
    if (!project.authorization.ticket || !challenge) throw new SetupFailure("authorization_failed");
    const exchangedResponse = await this.#postForm(
      "apps.hosted.exchangeAuthTicket",
      {
        ticket: project.authorization.ticket,
        challenge,
        slack_cli_version: SLACK_CLI_VERSION,
      },
      signal,
      "authorization_failed",
    );
    const exchanged = z
      .object({
        ok: z.literal(true),
        token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        exp: z.number().int().optional(),
        team_id: z.string().min(1),
        team_domain: z.string().optional(),
      })
      .safeParse(exchangedResponse);
    if (!exchanged.success) throw new SetupFailure("authorization_failed");
    const teamId = exchanged.data.team_id;
    const expected = expectedTeam ?? project.authorization.teamId;
    if (
      (project.authorization.teamId && teamId !== project.authorization.teamId) ||
      (expected && teamId !== expected)
    ) {
      throw new SetupFailure("authorization_failed");
    }
    this.#setTeamLogin(logins, {
      teamId,
      teamDomain: exchanged.data.team_domain || teamId,
      token: exchanged.data.token,
      updatedAt: this.#now(),
      ...(exchanged.data.refresh_token ? { refreshToken: exchanged.data.refresh_token } : {}),
      ...(exchanged.data.exp !== undefined ? { expiresAt: exchanged.data.exp } : {}),
    });
    project.authorization = { teamId };
    return { teamId, token: exchanged.data.token };
  }

  async #create(
    project: ProjectState,
    agentId: string,
    displayName: string,
    teamId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<{ appId: string; signingSecret: string }> {
    if (!project.creation) {
      const manifest = slackAppCreationManifest(agentId, displayName);
      const payload = { manifest: JSON.stringify(manifest) };
      await this.#api("apps.manifest.validate", token, payload, signal, "failed");
      // Fence before the creation request so an interrupted or ambiguous response within this Server process lifetime does not repeat creation.
      project.creation = { status: "uncertain" };
      const response = await this.#requestJson("apps.manifest.create", token, payload, signal, "create_uncertain");
      const rejected = z
        .object({ ok: z.literal(false), error: z.string() })
        .passthrough()
        .safeParse(response);
      if (rejected.success && !("app_id" in rejected.data) && CREATE_REJECTIONS.has(rejected.data.error)) {
        project.creation = undefined;
        throw new SetupFailure("create_failed", safeErrorCode(rejected.data.error));
      }
      const created = z
        .object({
          ok: z.literal(true),
          app_id: z.string().min(1),
          credentials: z.object({ signing_secret: z.string().min(1) }),
        })
        .safeParse(response);
      if (!created.success) {
        throw new SetupFailure("create_uncertain", safeErrorCode(rejected.success ? rejected.data.error : undefined));
      }
      project.creation = {
        status: "created",
        appId: created.data.app_id,
        teamId,
        signingSecret: created.data.credentials.signing_secret,
      };
    }
    if (project.creation.status !== "created") throw new SetupFailure("create_uncertain");
    if (!project.creation.signingSecret) throw new SetupFailure("manual_required");
    return { appId: project.creation.appId, signingSecret: project.creation.signingSecret };
  }

  async #install(
    project: ProjectState,
    logins: Map<string, NativeLogin>,
    agentId: string,
    input: Extract<SlackAutoSetupCommand, { action: "install" }>,
    signal: AbortSignal,
  ): Promise<Result> {
    if (project.creation?.status === "uncertain") {
      return { status: "failed", code: "create_uncertain" };
    }
    // An unchallenged Continue on an empty project means the Server restarted mid-setup; fence and require manual recovery.
    if (!input.challenge && !project.creation && !project.authorization.teamId) {
      project.creation = { status: "uncertain" };
      return { status: "failed", code: "manual_required" };
    }
    const { teamId, token } = await this.#team(project, logins, signal, input.challenge);
    const { appId, signingSecret } = await this.#create(project, agentId, input.displayName, teamId, token, signal);
    try {
      const approval = await this.#approval(appId, teamId, token, signal);
      if (approval) {
        this.#recordApprovalOutcome(project, approval);
        return approval;
      }
      const deployed = await this.#developerInstall(appId, teamId, token, signal);
      if ("status" in deployed) {
        this.#recordApprovalOutcome(project, deployed);
        return deployed;
      }
      const botUserId = await this.#verifyBotIdentity(deployed.botAccessToken, appId, teamId, signal);
      if (project.creation?.status === "created") {
        project.creation.approvalPending = false;
        project.creation.approvalDenied = false;
      }
      return {
        status: "installed",
        credentials: SlackProvisionCredentialsSchema.parse({
          appId,
          teamId,
          botUserId,
          botAccessToken: deployed.botAccessToken,
          signingSecret,
        }),
      };
    } catch (error) {
      return {
        ...this.#failure(error instanceof SetupFailure ? error : new SetupFailure("install_failed")),
        appId,
        teamId,
      };
    }
  }

  #recordApprovalOutcome(project: ProjectState, outcome: Result): void {
    if (project.creation?.status !== "created") return;
    if (outcome.status === "approval_pending") {
      project.creation.approvalPending = true;
      project.creation.approvalDenied = false;
    } else if (outcome.status === "failed" && outcome.code === "approval_denied") {
      project.creation.approvalDenied = true;
      project.creation.approvalPending = false;
    }
  }

  async #developerInstall(
    appId: string,
    teamId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Result | { botAccessToken: string }> {
    const installResponse = await this.#requestJson(
      "apps.developerInstall",
      token,
      {
        app_id: appId,
        bot_scopes: [...SLACK_REQUIRED_BOT_SCOPES],
        outgoing_domains: [],
      },
      signal,
      "install_failed",
    );
    const installFailed = z
      .object({
        ok: z.literal(false),
        error: z.string(),
        team_id: z.string().optional(),
      })
      .passthrough()
      .safeParse(installResponse);
    if (installFailed.success) {
      if (installFailed.data.error === "app_approval_request_eligible") {
        const requestTeamId = installFailed.data.team_id;
        await this.#api(
          "apps.approvals.requests.create",
          token,
          {
            app: appId,
            bot_scopes: SLACK_REQUIRED_BOT_SCOPES.join(","),
            reason: APPROVAL_REQUEST_REASON,
            domains: [],
            ...(requestTeamId && !requestTeamId.startsWith("E") ? { team_id: requestTeamId } : {}),
          },
          signal,
          "install_failed",
        );
        return { status: "approval_pending", appId, teamId };
      }
      if (installFailed.data.error === "app_approval_request_pending") {
        return { status: "approval_pending", appId, teamId };
      }
      if (installFailed.data.error === "app_approval_request_denied") {
        return {
          status: "failed",
          code: "approval_denied",
          appId,
          teamId,
          errorCode: "app_approval_request_denied",
        };
      }
      throw new SetupFailure("install_failed", safeErrorCode(installFailed.data.error));
    }
    const installed = z
      .object({
        ok: z.literal(true),
        api_access_tokens: z.object({ bot: z.string().min(1) }),
      })
      .safeParse(installResponse);
    if (!installed.success) throw new SetupFailure("install_failed");
    return { botAccessToken: installed.data.api_access_tokens.bot };
  }

  async #approval(appId: string, teamId: string, token: string, signal: AbortSignal): Promise<Result | undefined> {
    const response = await this.#api(
      "apps.approvals.requests.list",
      token,
      { app_id: appId },
      signal,
      "install_failed",
    );
    const parsed = z
      .object({
        ok: z.literal(true),
        requests: z
          .array(
            z.object({
              id: z.string().min(1),
              status: z.enum(["pending", "approved", "denied", "cancelled"]),
              can_self_approve: z.boolean().optional().default(false),
            }),
          )
          .optional()
          .default([]),
      })
      .safeParse(response);
    if (!parsed.success) throw new SetupFailure("install_failed");
    const restricted = parsed.data.requests.filter((request) => !request.can_self_approve);
    if (restricted.some((request) => request.status === "denied")) {
      return { status: "failed", code: "approval_denied", appId, teamId };
    }
    if (restricted.some((request) => request.status === "pending")) {
      return { status: "approval_pending", appId, teamId };
    }
  }

  async #verifyBotIdentity(
    botAccessToken: string,
    appId: string,
    teamId: string,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(`${SLACK_API_ORIGIN}/auth.test`, {
        method: "POST",
        headers: { authorization: `Bearer ${botAccessToken}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#callTimeoutMs)]),
      });
    } catch {
      throw new SetupFailure("install_failed", "http_request_failed");
    }
    if (signal.aborted) throw new SetupFailure("install_failed", "http_request_failed");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SetupFailure("install_failed", response.ok ? "http_response_invalid" : "http_request_failed");
    }
    if (!response.ok) {
      throw new SetupFailure("install_failed", extractErrorCode(body) ?? "http_request_failed");
    }
    const identity = z
      .object({
        ok: z.literal(true),
        user_id: z.string().min(1),
        team_id: z.string().min(1).optional(),
        app_id: z.string().optional(),
      })
      .safeParse(body);
    if (
      !identity.success ||
      (identity.data.team_id && identity.data.team_id !== teamId) ||
      (identity.data.app_id && identity.data.app_id !== appId)
    ) {
      throw new SetupFailure("install_failed", extractErrorCode(body));
    }
    return identity.data.user_id;
  }

  async #callbacks(
    project: ProjectState,
    logins: Map<string, NativeLogin>,
    input: Extract<SlackAutoSetupCommand, { action: "callbacks" }>,
    signal: AbortSignal,
  ): Promise<Result> {
    if (project.creation?.status !== "created" || project.creation.appId !== input.appId) {
      throw new SetupFailure("manual_required");
    }
    const { teamId, token } = await this.#team(project, logins, signal, input.challenge, input.teamId);
    if (teamId !== input.teamId) throw new SetupFailure("authorization_failed");
    // After checking this project's App and Team, acknowledge the encrypted Server binding and clear the creation secret.
    project.creation = { status: "created", appId: input.appId, teamId };
    const record = z.record(z.string(), z.unknown());
    const exportedResponse = await this.#api(
      "apps.manifest.export",
      token,
      { app_id: input.appId },
      signal,
      "callbacks_failed",
    );
    const exported = z
      .object({
        ok: z.literal(true),
        manifest: z.object({ settings: record.optional() }).passthrough(),
      })
      .safeParse(exportedResponse);
    if (!exported.success) throw new SetupFailure("callbacks_failed");
    const remote = exported.data.manifest;
    const settings = remote.settings ?? {};
    const manifest = {
      ...remote,
      settings: {
        ...settings,
        event_subscriptions: {
          ...(record.safeParse(settings.event_subscriptions).data ?? {}),
          request_url: input.eventsUrl,
          bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS],
        },
        interactivity: {
          ...(record.safeParse(settings.interactivity).data ?? {}),
          is_enabled: true,
          request_url: input.interactionsUrl,
        },
      },
    };
    const update = { app_id: input.appId, manifest: JSON.stringify(manifest) };
    await this.#api("apps.manifest.validate", token, update, signal, "callbacks_failed");
    await this.#api("apps.manifest.update", token, update, signal, "callbacks_failed");
    const verifiedResponse = await this.#api(
      "apps.manifest.export",
      token,
      { app_id: input.appId },
      signal,
      "callbacks_failed",
    );
    const verified = z
      .object({
        manifest: z
          .object({
            settings: z
              .object({
                interactivity: z
                  .object({ is_enabled: z.boolean().optional(), request_url: z.string().optional() })
                  .optional(),
                event_subscriptions: z
                  .object({ request_url: z.string().optional(), bot_events: z.array(z.string()).optional() })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .safeParse(verifiedResponse);
    const verifiedSettings = verified.data?.manifest?.settings;
    if (
      verifiedSettings?.interactivity?.is_enabled !== true ||
      verifiedSettings.interactivity.request_url !== input.interactionsUrl ||
      verifiedSettings?.event_subscriptions?.request_url !== input.eventsUrl ||
      !isDeepStrictEqual(
        [...(verifiedSettings.event_subscriptions.bot_events ?? [])].sort(),
        [...SLACK_SUBSCRIBED_BOT_EVENTS].sort(),
      )
    ) {
      throw new SetupFailure("callbacks_failed");
    }
    project.creation = { status: "created", appId: input.appId, teamId, connected: true };
    return { status: "connected" };
  }

  async #postForm(
    method: string,
    params: Record<string, string>,
    signal: AbortSignal,
    code: Failure,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${SLACK_API_ORIGIN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#callTimeoutMs)]),
      });
    } catch {
      throw new SetupFailure(code, "http_request_failed");
    }
    if (signal.aborted) throw new SetupFailure(code, "http_request_failed");
    const body = await parseSlackJson(response, code);
    const ok = z
      .object({ ok: z.literal(true) })
      .passthrough()
      .safeParse(body);
    if (!ok.success) throw new SetupFailure(code, extractErrorCode(body));
    return ok.data;
  }

  async #requestJson(
    method: string,
    token: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    code: Failure,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${SLACK_API_ORIGIN}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#callTimeoutMs)]),
      });
    } catch {
      throw new SetupFailure(code, "http_request_failed");
    }
    if (signal.aborted) throw new SetupFailure(code, "http_request_failed");
    return parseSlackJson(response, code);
  }

  async #api(
    method: string,
    token: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    code: Failure,
  ): Promise<Record<string, unknown>> {
    const body = await this.#requestJson(method, token, payload, signal, code);
    const ok = z
      .object({ ok: z.literal(true) })
      .passthrough()
      .safeParse(body);
    if (!ok.success) throw new SetupFailure(code, extractErrorCode(body));
    return ok.data;
  }
}

async function parseSlackJson(response: Response, code: Failure): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SetupFailure(code, response.ok ? "http_response_invalid" : "http_request_failed");
  }
  const record = z.record(z.string(), z.unknown()).safeParse(body);
  if (!record.success) {
    throw new SetupFailure(code, response.ok ? "http_response_invalid" : "http_request_failed");
  }
  if (!response.ok) {
    throw new SetupFailure(code, extractErrorCode(record.data) ?? "http_request_failed");
  }
  return record.data;
}

function extractErrorCode(body: unknown): string | undefined {
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return parsed.success ? safeErrorCode(parsed.data.error) : undefined;
}
