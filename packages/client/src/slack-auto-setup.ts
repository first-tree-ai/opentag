import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAutoSetupCommand,
  type SlackAutoSetupRuntimeRequest,
  type SlackAutoSetupRuntimeResult,
  SlackProvisionCredentialsSchema,
  slackAppCreationManifest,
} from "@opentag/shared";
import { z } from "zod";
import { prepareSlackCallbackUpdate, runSlackManagement, slackManagementHome } from "./slack-management.js";
import { readPrivateJson, writePrivateJson } from "./storage/private-json-file.js";

type SetupContext = { home: string; project: string; signal: AbortSignal };
type Result = SlackAutoSetupRuntimeResult["result"];
type Failure = Extract<Result, { status: "failed" }>["code"];
class SetupFailure extends Error {
  constructor(
    readonly code: Failure,
    readonly errorCode?: string,
  ) {
    super(code);
  }
}
const NativeLogins = z.record(
  z.string(),
  z.object({ team_id: z.string(), team_domain: z.string(), token: z.string() }).passthrough(),
);
const Authorization = z.object({ ticket: z.string().optional(), teamId: z.string().optional() });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Only fixed codes may cross the credential boundary. Never return CLI output or error messages.
const SAFE_ERROR_CODES = [
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
];
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

/** Fixed CLI steps requested by the authenticated owner; no model or arbitrary command input. */
export class SlackAutoSetup {
  #busy = false;
  constructor(
    readonly options: {
      environment: NodeJS.ProcessEnv;
      accountHome?: string;
      cliEntry?: string;
      run?: typeof runSlackManagement;
    },
  ) {
    // This is the owner's Web management request, independent of a Turn's credential proxy.
    this.options = {
      ...options,
      environment: {
        ...options.environment,
        OPENTAG_RUNTIME_CREDENTIAL_MODE: "legacy",
        OPENTAG_SESSION_SERVER_URL: undefined,
      },
    };
  }

  async run(request: SlackAutoSetupRuntimeRequest, signal?: AbortSignal): Promise<Result> {
    if (this.#busy) return { status: "failed", code: "busy" };
    this.#busy = true;
    try {
      return await this.#execute(request, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(240_000)]));
    } catch (error) {
      return this.#failure(error);
    } finally {
      this.#busy = false;
    }
  }

  async #execute(request: SlackAutoSetupRuntimeRequest, signal: AbortSignal): Promise<Result> {
    const context = { home: slackManagementHome(this.options.environment), project: `web-${request.agentId}`, signal };
    const directory = join(context.home, context.project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      if (request.input.action === "authorize") return await this.#authorize(context, request.input.force);
      if (request.input.action === "callbacks") return await this.#callbacks(context, request.input);
      return await this.#install(context, request.agentId, request.input);
    } finally {
      for (const name of ["login-output.txt", "login-complete.txt", "last-error.txt"])
        await rm(this.#path(context, name), { force: true });
    }
  }

  #path(context: SetupContext, name: string) {
    return join(context.home, context.project, name);
  }
  #save(context: SetupContext, name: string, value: unknown) {
    return writePrivateJson(context.home, this.#path(context, name), value);
  }
  #failure(error: unknown): Extract<Result, { status: "failed" }> {
    return {
      status: "failed",
      code: error instanceof SetupFailure ? error.code : "failed",
      ...(error instanceof SetupFailure && error.errorCode ? { errorCode: error.errorCode } : {}),
    };
  }
  async #json(context: SetupContext, name: string): Promise<unknown> {
    return readPrivateJson(context.home, this.#path(context, name), (value) => value);
  }
  async #logins(context: SetupContext) {
    return (
      (await readPrivateJson(context.home, join(context.home, "config", "credentials.json"), (value) =>
        NativeLogins.parse(value),
      )) ?? {}
    );
  }
  async #command(context: SetupContext, args: string[], name: string, code: Failure, team?: string) {
    try {
      const exit = await (this.options.run ?? runSlackManagement)(args, {
        projectDir: context.project,
        outputFile: `${context.project}/${name}`,
        errorFile: `${context.project}/last-error.txt`,
        nonInteractive: true,
        environment: this.options.environment,
        accountHome: this.options.accountHome,
        signal: context.signal,
        ...(args[0] === "platform" && args[1] === "deploy" ? { requestAppApproval: true } : {}),
        ...(team ? { team } : {}),
      });
      if (exit !== 0) throw new SetupFailure(code);
    } catch {
      const output = await readFile(this.#path(context, "last-error.txt"), "utf8").catch(() => "");
      const errorCode = SAFE_ERROR_CODES.find((value) => output.includes(`(${value})`));
      throw new SetupFailure(code, errorCode);
    }
  }
  async #authorization(context: SetupContext) {
    return Authorization.parse((await this.#json(context, "authorization.json")) ?? {});
  }
  async #authorize(context: SetupContext, force = false): Promise<Result> {
    if (!this.options.cliEntry) throw new SetupFailure("capability_missing");
    const authorization = await this.#authorization(context);
    const stored = Object.values(await this.#logins(context)).find((x) => x.team_id === authorization.teamId);
    if (stored && !force && !authorization.ticket) return { status: "authorized", teamName: stored.team_domain };
    await this.#command(context, ["auth", "login", "--no-prompt"], "login-output.txt", "authorization_failed");
    const output = await readFile(this.#path(context, "login-output.txt"), "utf8");
    const ticket = /\/slackauthticket\s+([A-Za-z0-9+/=_-]+)/.exec(output)?.[1];
    if (!ticket) throw new SetupFailure("authorization_failed");
    await this.#save(context, "authorization.json", {
      ticket,
      ...(authorization.teamId ? { teamId: authorization.teamId } : {}),
    });
    return { status: "authorization_required", ticket };
  }
  async #team(context: SetupContext, challenge?: string, expectedTeam?: string): Promise<string> {
    const authorization = await this.#authorization(context);
    if (authorization.teamId && !authorization.ticket) return authorization.teamId;
    if (!authorization.ticket || !challenge) throw new SetupFailure("authorization_failed");
    const before = await this.#logins(context);
    await this.#command(
      context,
      ["auth", "login", "--ticket", authorization.ticket, "--challenge", challenge],
      "login-complete.txt",
      "authorization_failed",
    );
    const changed = Object.entries(await this.#logins(context)).filter(
      ([key, value]) => !isDeepStrictEqual(before[key], value),
    );
    const team = changed.length === 1 ? changed[0]?.[1].team_id : undefined;
    if (!team || (authorization.teamId && team !== authorization.teamId) || (expectedTeam && team !== expectedTeam))
      throw new SetupFailure("authorization_failed");
    await this.#save(context, "authorization.json", { teamId: team });
    return team;
  }
  async #callbacks(
    context: SetupContext,
    input: Extract<SlackAutoSetupCommand, { action: "callbacks" }>,
  ): Promise<Result> {
    const created = z
      .object({ ok: z.literal(true), app_id: z.literal(input.appId) })
      .safeParse(await this.#creationResponse(context).catch(() => undefined));
    if (!created.success) throw new SetupFailure("manual_required");
    const team = await this.#team(context, input.challenge, input.teamId);
    if (team !== input.teamId) throw new SetupFailure("authorization_failed");
    // After checking this project's App and Team, the request acknowledges the encrypted Server binding.
    await this.#save(context, "create-response.json", { ok: true, app_id: input.appId });
    await rm(this.#path(context, "credentials.json"), { force: true });
    await this.#command(
      context,
      ["api", "apps.manifest.export", "--json", JSON.stringify({ app_id: input.appId })],
      "remote.json",
      "callbacks_failed",
      input.teamId,
    );
    await this.#save(context, "provision-result.json", {
      ok: true,
      result: {
        interactionsUrl: input.interactionsUrl,
        slack: {
          eventsUrl: input.eventsUrl,
          binding: {
            identity: {
              provider: "slack",
              appId: input.appId,
              teamId: input.teamId,
              botUserId: input.botUserId,
              enterpriseId: input.enterpriseId,
              appIdEvidence: "configured",
            },
          },
        },
      },
    });
    await prepareSlackCallbackUpdate({
      manifestFile: `${context.project}/remote.json`,
      provisionResultFile: `${context.project}/provision-result.json`,
      outputFile: `${context.project}/callback-update.json`,
      environment: this.options.environment,
    });
    const update = z
      .object({ app_id: z.string(), manifest: z.string() })
      .parse(await this.#json(context, "callback-update.json"));
    for (const method of ["validate", "update"])
      await this.#command(
        context,
        ["api", `apps.manifest.${method}`, "--json", JSON.stringify(update)],
        `${method}.json`,
        "callbacks_failed",
        input.teamId,
      );
    await this.#command(
      context,
      ["api", "apps.manifest.export", "--json", JSON.stringify({ app_id: input.appId })],
      "verified.json",
      "callbacks_failed",
      input.teamId,
    );
    const raw = await readFile(this.#path(context, "verified.json"), "utf8");
    const verified = JSON.parse(raw.slice(raw.indexOf("{")));
    const settings = verified.manifest?.settings;
    if (
      settings?.interactivity?.is_enabled !== true ||
      settings.interactivity.request_url !== input.interactionsUrl ||
      settings?.event_subscriptions?.request_url !== input.eventsUrl ||
      !isDeepStrictEqual(
        [...(settings.event_subscriptions.bot_events ?? [])].sort(),
        [...SLACK_SUBSCRIBED_BOT_EVENTS].sort(),
      )
    )
      throw new SetupFailure("callbacks_failed");
    return { status: "connected" };
  }
  async #create(
    context: SetupContext,
    agentId: string,
    input: Extract<SlackAutoSetupCommand, { action: "install" }>,
    team: string,
  ): Promise<string> {
    const createPath = this.#path(context, "create-response.json");
    if (!existsSync(createPath)) {
      const manifest = slackAppCreationManifest(agentId, input.displayName);
      await this.#save(context, "manifest.json", manifest);
      const json = JSON.stringify({ manifest: JSON.stringify(manifest) });
      await this.#command(
        context,
        ["api", "apps.manifest.validate", "--json", json],
        "creation-validation.json",
        "failed",
        team,
      );
      // Opening the output before the request fences off uncertain creates, including interrupted requests.
      try {
        await this.#command(
          context,
          ["api", "apps.manifest.create", "--json", json],
          "create-response.json",
          "create_uncertain",
          team,
        );
      } catch {
        // Inspect even nonzero exits: the CLI can save a definite Slack rejection before throwing.
        return this.#createdApp(context);
      }
    }
    return this.#createdApp(context);
  }
  async #creationResponse(context: SetupContext): Promise<unknown> {
    try {
      const raw = await readFile(this.#path(context, "create-response.json"), "utf8");
      return JSON.parse(raw.slice(raw.indexOf("{")));
    } catch {
      throw new SetupFailure("create_uncertain");
    }
  }
  async #createdApp(context: SetupContext): Promise<string> {
    const response = await this.#creationResponse(context);
    const rejected = z
      .object({ ok: z.literal(false), error: z.string() })
      .passthrough()
      .safeParse(response);
    if (rejected.success && !("app_id" in rejected.data) && CREATE_REJECTIONS.has(rejected.data.error)) {
      await rm(this.#path(context, "create-response.json"));
      throw new SetupFailure("create_failed");
    }
    const created = z.object({ ok: z.literal(true), app_id: z.string().min(1) }).safeParse(response);
    if (!created.success) throw new SetupFailure("create_uncertain");
    return created.data.app_id;
  }
  async #install(
    context: SetupContext,
    agentId: string,
    input: Extract<SlackAutoSetupCommand, { action: "install" }>,
  ): Promise<Result> {
    try {
      const cli = this.options.cliEntry;
      if (!cli) throw new SetupFailure("capability_missing");
      const team = await this.#team(context, input.challenge);
      const appId = await this.#create(context, agentId, input, team);
      const cached = await this.#json(context, "credentials.json");
      if (cached) return this.#installed(cached, appId, team);
      const creation = z
        .object({ credentials: z.object({ signing_secret: z.string().min(1) }) })
        .safeParse(await this.#creationResponse(context));
      if (!creation.success) throw new SetupFailure("manual_required");
      try {
        const approval = await this.#approval(context, appId, team);
        if (approval) return approval;
        const deployed = await this.#deploy(context, appId, team, cli);
        if (deployed) return deployed;
        return this.#installed(await this.#json(context, "credentials.json"), appId, team);
      } catch (error) {
        return {
          ...this.#failure(error instanceof SetupFailure ? error : new SetupFailure("install_failed")),
          appId,
          teamId: team,
        };
      }
    } finally {
      await rm(this.#path(context, "credentials.json"), { force: true });
    }
  }
  async #approval(context: SetupContext, appId: string, teamId: string): Promise<Result | undefined> {
    await this.#command(
      context,
      ["api", "apps.approvals.requests.list", "--json", JSON.stringify({ app_id: appId })],
      "approval-status.json",
      "install_failed",
      teamId,
    );
    const raw = await readFile(this.#path(context, "approval-status.json"), "utf8");
    // The native request is scoped to this App and the logged-in workspace (plus its governing org).
    const { requests } = z
      .object({
        ok: z.literal(true),
        requests: z.array(
          z.object({
            id: z.string().min(1),
            status: z.enum(["pending", "approved", "denied", "cancelled"]),
            can_self_approve: z.boolean().optional().default(false),
          }),
        ),
      })
      .parse(JSON.parse(raw.slice(raw.indexOf("{"))));
    // A historical request can remain unresolved even when this account is now allowed to install.
    const restricted = requests.filter((request) => !request.can_self_approve);
    if (restricted.some((request) => request.status === "denied"))
      return { status: "failed", code: "approval_denied", appId, teamId };
    if (restricted.some((request) => request.status === "pending"))
      return { status: "approval_pending", appId, teamId };
  }
  #installed(raw: unknown, appId: string, team: string): Result {
    const credentials = SlackProvisionCredentialsSchema.parse(raw);
    if (credentials.appId !== appId || credentials.teamId !== team) throw new SetupFailure("install_failed");
    return { status: "installed", credentials };
  }
  async #deploy(context: SetupContext, appId: string, team: string, cli: string) {
    await this.#save(context, ".slack/config.json", { manifest: { source: "remote" } });
    await this.#save(context, ".slack/hooks.json", {
      hooks: { "get-hooks": `${shellQuote(process.execPath)} hooks.mjs` },
    });
    const scripts = {
      "manifest.mjs":
        "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('manifest.json','utf8'));\n",
      "hooks.mjs": `process.stdout.write(JSON.stringify(${JSON.stringify({ runtime: "node", hooks: { "get-manifest": `${shellQuote(process.execPath)} manifest.mjs`, deploy: `${shellQuote(process.execPath)} ${shellQuote(cli)} slack capture-deploy --create-response-file ${context.project}/create-response.json --output-file ${context.project}/credentials.json` } })}));\n`,
    };
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(this.#path(context, name), content, { mode: 0o600 });
      await chmod(this.#path(context, name), 0o600);
    }
    await this.#command(
      context,
      // This private project's App/Team are already fenced by its creation record. Re-linking only replaces that local mapping.
      ["app", "link", "--team", team, "--app", appId, "--environment", "deployed", "--force"],
      "link-output.txt",
      "install_failed",
    );
    let failure: unknown;
    try {
      await this.#command(
        context,
        ["platform", "deploy", "--team", team, "--app", appId],
        "deploy-output.txt",
        "install_failed",
      );
    } catch (error) {
      failure = error;
    }
    if (failure instanceof SetupFailure && failure.errorCode === "http_request_failed") throw failure;
    if (failure || !(await this.#json(context, "credentials.json"))) {
      try {
        const approval = await this.#approval(context, appId, team);
        if (approval) return approval;
      } catch (error) {
        throw failure ?? error;
      }
      throw failure ?? new SetupFailure("install_failed");
    }
  }
}
