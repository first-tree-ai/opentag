import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ProviderCliManager, resolveAccountHome, resolveOpenTagHome } from "@opentag/client";
import { SlackProvisionCredentialsSchema } from "@opentag/shared";
import { z } from "zod";

const CLOUD_SLACK_BINARY = "/opt/opentag/tools/bin/slack";

export function slackManagementHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OPENTAG_SESSION_SERVER_URL || environment.OPENTAG_RUNTIME_CREDENTIAL_MODE === "proxy"
    ? "/tmp/opentag/slack-management"
    : join(resolveOpenTagHome(environment), "slack-management");
}

export function slackManagementEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("SLACK_") &&
        !/^(https?_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)$/i.test(
          key,
        ),
    ),
  );
}

function privatePath(home: string, path: string): string {
  const output = resolve(home, path);
  const child = relative(home, output);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(child)
  ) {
    throw new Error("Slack management files must stay inside the private management directory");
  }
  return output;
}

async function privateFile(home: string, path: string) {
  const output = privatePath(home, path);
  if (relative(home, output).split(/[\\/]/u)[0] === "config")
    throw new Error("Output files cannot overwrite the native Slack management login");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await chmod(dirname(output), 0o700);
  const file = await open(
    output,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await file.chmod(0o600);
  return file;
}

export async function runSlackManagement(
  args: string[],
  options: {
    outputFile?: string;
    projectDir?: string;
    team?: string;
    environment?: NodeJS.ProcessEnv;
    binary?: string;
    accountHome?: string;
  } = {},
): Promise<number> {
  const isApi = validateManagementArguments(args, options.team, options.outputFile);
  const environment = options.environment ?? process.env;
  const home = slackManagementHome(environment);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const configDir = join(home, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  const cwd = privatePath(home, options.projectDir ?? "project");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const output = options.outputFile ? await privateFile(home, options.outputFile) : undefined;
  try {
    const nativeEnvironment = slackManagementEnvironment(environment);
    const binary = options.binary ?? (await slackManagementBinary(nativeEnvironment, options.accountHome));
    const baseArgs = ["--apihost", "https://slack.com", "--skip-update", "--no-color", "--config-dir", configDir];
    if (isApi) {
      // The raw API command does not read native authorization. Refresh first; never inject a stale snapshot.
      const refreshed = await invokeSlack(binary, [...baseArgs, "auth", "list"], cwd, nativeEnvironment, "ignore");
      if (refreshed !== 0)
        throw new Error(
          "Slack management login could not be refreshed; recover native authorization before continuing",
        );
      nativeEnvironment.SLACK_USER_TOKEN = await managementToken(home, options.team ?? "");
    }
    const code = await invokeSlack(
      binary,
      [...baseArgs, ...(options.team ? ["--team", options.team] : []), ...args],
      cwd,
      nativeEnvironment,
      output?.fd ?? "inherit",
    );
    if (code === 0 && isApi && options.outputFile) {
      await readSlackApiResponse(privatePath(home, options.outputFile));
    }
    return code;
  } finally {
    await output?.close();
  }
}

async function slackManagementBinary(
  environment: NodeJS.ProcessEnv,
  accountHome = resolveAccountHome(),
): Promise<string> {
  if (existsSync(CLOUD_SLACK_BINARY)) return CLOUD_SLACK_BINARY;
  // Local PATH starts with the Turn messaging launcher, which deliberately rejects management authority flags.
  const inspected = await new ProviderCliManager({ accountHome, env: environment }).inspect("slack");
  if (inspected.readiness !== "ready" || inspected.launcher.status !== "valid") {
    throw new Error("Native Slack CLI is unavailable; run `provider-cli ensure --provider slack` before continuing");
  }
  return inspected.launcher.path;
}

/** Called only by the official deploy hook; writes the complete material without logging it. */
export async function captureSlackDeploy(options: {
  createResponseFile: string;
  outputFile: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const home = slackManagementHome(environment);
  const created = await readSlackApiResponse(privatePath(home, options.createResponseFile));
  const result = z
    .object({
      ok: z.literal(true),
      app_id: z.string().min(1),
      credentials: z.object({ signing_secret: z.string().min(1) }),
    })
    .safeParse(created);
  if (!result.success) throw new Error("The App creation response has no usable Signing Secret");
  const botAccessToken = environment.SLACK_BOT_TOKEN;
  if (!botAccessToken) throw new Error("The Slack deploy hook did not receive SLACK_BOT_TOKEN");
  const response = await (options.fetchImpl ?? fetch)("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${botAccessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const identity = z
    .object({
      ok: z.literal(true),
      team_id: z.string().min(1),
      user_id: z.string().min(1),
      bot_id: z.string().min(1),
      app_id: z.string().optional(),
    })
    .safeParse(await response.json());
  if (!response.ok || !identity.success || (identity.data.app_id && identity.data.app_id !== result.data.app_id)) {
    throw new Error("Slack did not validate this deployment's Bot identity");
  }
  const credentials = SlackProvisionCredentialsSchema.parse({
    appId: result.data.app_id,
    teamId: identity.data.team_id,
    botUserId: identity.data.user_id,
    botAccessToken,
    signingSecret: result.data.credentials.signing_secret,
  });
  const file = await privateFile(home, options.outputFile);
  try {
    await file.writeFile(JSON.stringify(credentials));
  } finally {
    await file.close();
  }
}

async function invokeSlack(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdout: number | "ignore" | "inherit",
): Promise<number> {
  const child = spawn(binary, args, { cwd, env, stdio: ["inherit", stdout, "inherit"] });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function readSlackApiResponse(path: string): Promise<Record<string, unknown>> {
  let response: unknown;
  try {
    const text = await readFile(path, "utf8");
    response = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    throw new Error("Slack did not return readable JSON; keep the current App and inspect the private response");
  }
  const parsed = z
    .object({ ok: z.literal(true) })
    .passthrough()
    .safeParse(response);
  if (!parsed.success)
    throw new Error(
      "Slack API returned ok=false; inspect the private response and recover the same step, without repeating an uncertain App creation",
    );
  return parsed.data;
}

async function managementToken(home: string, team: string): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(home, "config", "credentials.json"), "utf8"));
  } catch {
    throw new Error("Slack native management login is missing; complete ticket/challenge authorization first");
  }
  const parsed = z.record(z.string(), z.object({ team_id: z.string(), token: z.string().min(1) })).safeParse(value);
  if (!parsed.success) throw new Error("Slack native management credentials could not be read");
  const matches = Object.values(parsed.data).filter((entry) => entry.team_id === team);
  if (matches.length !== 1) throw new Error("No unambiguous native Slack management login for the requested Team");
  return matches[0]?.token ?? "";
}

function validateManagementArguments(
  args: string[],
  team: string | undefined,
  outputFile: string | undefined,
): boolean {
  if (args.some((arg) => /^(--apihost|--config-dir|--token)(=|$)/.test(arg))) {
    throw new Error(
      "Slack management uses its own official API host and native login; do not override routing or tokens",
    );
  }
  const isApi = args[0] === "api" && !args.includes("--help");
  if (isApi && (!outputFile || !team)) {
    throw new Error(
      "Raw management API calls require --team and --output-file to select native authorization and keep responses private",
    );
  }
  return isApi;
}
