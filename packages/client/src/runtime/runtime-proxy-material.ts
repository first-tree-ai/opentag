import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeImOutboxContext } from "@opentag/shared";
import { assertWithin, ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { serializeEnvironment } from "./im-credential-environment-manager.js";
import type { RuntimeProxyCliMetadata, RuntimeProxyProvider } from "./runtime-credential-frames.js";

export const RUNTIME_PROXY_SHIM_MARKER = "# opentag-runtime-proxy-shim: v1";
export const RUNTIME_PROXY_GIT_HELPER_MARKER = "# opentag-runtime-proxy-git-helper: v1";
const EXECUTION_MARKER_PREFIX = "# opentag-execution: ";
const MANAGED_SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Environment assembled for one execution; `undefined` unsets the inherited variable. */
export type RuntimeProxyEnvironment = Readonly<Record<string, string | undefined>>;

export interface RuntimeProxyExecutionLayout {
  readonly adapterCaCertPath: string;
  readonly executionDir: string;
  readonly gitCredentialHelperPath: string;
  readonly gitConfigPath: string;
  readonly larkConfigDir: string;
  readonly slackConfigDir: string;
}

export interface RuntimeProxyEnvironmentInput {
  readonly adapterCaCertPath: string;
  readonly cliMetadata: (provider: RuntimeProxyProvider) => RuntimeProxyCliMetadata | undefined;
  readonly connectProxyUrl: string;
  readonly handles: ReadonlyMap<RuntimeProxyProvider, string>;
  readonly layout: RuntimeProxyExecutionLayout;
  readonly slackApiHost: string;
}

/** Parse the non-secret outbox context returned for an IM provider, when present. */
export function runtimeProxyOutboxContext(
  cli: RuntimeProxyCliMetadata | undefined,
): RuntimeImOutboxContext | undefined {
  if (!cli || !("outboxContext" in cli)) return undefined;
  const outbox = cli.outboxContext;
  if (!outbox || typeof outbox !== "object") return undefined;
  return outbox as unknown as RuntimeImOutboxContext;
}

/** Loopback endpoints never go through the CONNECT proxy (Slack `--apihost`). */
const LOCAL_PROXY_BYPASS = "127.0.0.1,localhost";

/**
 * Build the CLI environment for one execution. Sandbox-visible values only: the local
 * handle, loopback addresses, the public CA path, and non-secret CLI metadata. No
 * capability, platform token, App Secret, Bot Token, or machine token. No `GH_REPO`:
 * GitHub target resolution stays with cwd, `-R`, and the canonical remote path.
 */
export function buildRuntimeProxyEnvironment(input: RuntimeProxyEnvironmentInput): RuntimeProxyEnvironment {
  const environment: Record<string, string | undefined> = {
    // Scrub ambient platform credentials and agent-forwarding from CLI subprocesses.
    OPENTAG_GITHUB_REPOSITORIES: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    SSH_AGENT_PID: undefined,
    SSH_AUTH_SOCK: undefined,
  };
  const github = input.handles.get("github");
  if (github !== undefined) {
    const cli = input.cliMetadata("github");
    const repositories = cli?.provider === "github" ? cli.repositories : [];
    Object.assign(environment, {
      GH_TOKEN: github,
      OPENTAG_GITHUB_REPOSITORIES: JSON.stringify(repositories),
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: `!sh '${input.layout.gitCredentialHelperPath}'`,
      GIT_CONFIG_GLOBAL: input.layout.gitConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_SSL_CAINFO: input.adapterCaCertPath,
      GIT_TERMINAL_PROMPT: "0",
      HTTPS_PROXY: input.connectProxyUrl,
      NO_PROXY: LOCAL_PROXY_BYPASS,
      https_proxy: input.connectProxyUrl,
      no_proxy: LOCAL_PROXY_BYPASS,
      SSL_CERT_FILE: input.adapterCaCertPath,
    } satisfies Record<string, string>);
  }
  const feishu = input.handles.get("feishu");
  if (feishu !== undefined) {
    const cli = input.cliMetadata("feishu");
    const feishuCli = cli?.provider === "feishu" ? cli : undefined;
    Object.assign(environment, {
      LARKSUITE_CLI_APP_ID: feishuCli?.appId ?? "",
      LARKSUITE_CLI_APP_SECRET: undefined,
      LARKSUITE_CLI_BRAND: feishuCli?.teamBrand ?? "feishu",
      LARKSUITE_CLI_CA_PATH: input.adapterCaCertPath,
      LARKSUITE_CLI_CONFIG_DIR: input.layout.larkConfigDir,
      LARKSUITE_CLI_DEFAULT_AS: "bot",
      LARKSUITE_CLI_PROXY_ADDRESS: input.connectProxyUrl,
      LARKSUITE_CLI_PROXY_ENABLE: "1",
      LARKSUITE_CLI_STRICT_MODE: "bot",
      LARKSUITE_CLI_TENANT_ACCESS_TOKEN: feishu,
      LARKSUITE_CLI_USER_ACCESS_TOKEN: undefined,
    } satisfies Record<string, string | undefined>);
  }
  const slack = input.handles.get("slack");
  if (slack !== undefined) {
    Object.assign(environment, {
      OPENTAG_SLACK_CONFIG_DIR: input.layout.slackConfigDir,
      SLACK_APP_TOKEN: undefined,
      SLACK_BOT_TOKEN: slack,
      SLACK_CONFIG_DIR: input.layout.slackConfigDir,
      SLACK_USER_TOKEN: undefined,
      SSL_CERT_FILE: input.adapterCaCertPath,
      // Slack file handle URLs stay on the fixed slack.com origin and go through the
      // loopback CONNECT proxy; the direct --apihost endpoint must never be proxied.
      HTTPS_PROXY: input.connectProxyUrl,
      NO_PROXY: LOCAL_PROXY_BYPASS,
      https_proxy: input.connectProxyUrl,
      no_proxy: LOCAL_PROXY_BYPASS,
    } satisfies Record<string, string | undefined>);
  }
  return environment;
}

export function renderRuntimeProxyGitCredentialHelper(handle: string): string {
  // The helper answers only the github.com HTTPS credential query with the local handle.
  return `#!/bin/sh
${RUNTIME_PROXY_GIT_HELPER_MARKER}
# OpenTag execution-local Git credential helper; do not edit.
action="$1"
[ "$action" = "get" ] || exit 0
host=""
protocol=""
while IFS= read -r line; do
  case "$line" in
    host=*) host=\${line#host=} ;;
    protocol=*) protocol=\${line#protocol=} ;;
  esac
  [ -n "$host" ] && [ -n "$protocol" ] && break
done
if [ "$host" = "github.com" ] && [ "$protocol" = "https" ]; then
  printf 'username=x-access-token\\npassword=%s\\n' '${handle.replaceAll("'", "'\"'\"'")}'
fi
exit 0
`;
}

export function renderRuntimeProxyShim(binary: string, environmentFilePath: string): string {
  return `#!/bin/sh
${RUNTIME_PROXY_SHIM_MARKER} binary=${binary}
# OpenTag execution-local shim: load the current proxy environment, then exec the real
# binary with unchanged argv, cwd, stdin, stdout, stderr, signals, and exit status.
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
real_binary=""
old_ifs=$IFS
IFS=:
for path_dir in $PATH; do
  [ "$path_dir" = "$self_dir" ] && continue
  if [ -x "$path_dir/${binary}" ]; then
    real_binary="$path_dir/${binary}"
    break
  fi
done
IFS=$old_ifs
if [ -z "$real_binary" ]; then
  echo "opentag: ${binary} is unavailable on PATH" >&2
  exit 127
fi
if [ ! -r '${environmentFilePath.replaceAll("'", "'\"'\"'")}' ]; then
  echo "opentag: the provider proxy environment is unavailable" >&2
  exit 1
fi
. '${environmentFilePath.replaceAll("'", "'\"'\"'")}'
exec "$real_binary" "$@"
`;
}

/**
 * Per-Session proxy material store. The stable env file/manifest/shims point at the
 * current execution; every rotating secret-bearing artifact lives under
 * `executions/<executionId>/` so a stale cleanup cannot delete successor material.
 */
export class RuntimeProxyMaterialStore {
  readonly #home: string;
  readonly #root: string;

  constructor(options: { readonly home: string }) {
    const layout = resolveOpenTagHomeLayout(options.home);
    this.#home = layout.home;
    this.#root = join(layout.runtime, "provider-proxy");
  }

  get root(): string {
    return this.#root;
  }

  sessionDir(sessionId: string): string {
    return this.#within(this.#root, sessionId);
  }

  /** Stable per-Session env file path wired to `OPENTAG_PROVIDER_ENV_FILE`. */
  environmentFilePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "current.sh");
  }

  manifestPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "current.json");
  }

  shimDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "bin");
  }

  executionLayout(sessionId: string, executionId: string): RuntimeProxyExecutionLayout {
    const executionDir = this.#within(this.sessionDir(sessionId), "executions", executionId);
    return {
      adapterCaCertPath: join(executionDir, "loopback-ca.pem"),
      executionDir,
      gitConfigPath: join(executionDir, "gitconfig"),
      gitCredentialHelperPath: join(executionDir, "git-credential-helper.sh"),
      larkConfigDir: join(executionDir, "lark-config"),
      slackConfigDir: join(executionDir, "slack-config"),
    };
  }

  /**
   * Publish one execution's material atomically: per-execution artifacts first, then
   * the stable env file and manifest, then the git/gh shims.
   */
  async publish(input: {
    readonly adapterCaCertPath: string;
    readonly environment: RuntimeProxyEnvironment;
    readonly executionId: string;
    readonly handles: ReadonlyMap<RuntimeProxyProvider, string>;
    readonly platform: NodeJS.Platform;
    readonly sessionId: string;
  }): Promise<RuntimeProxyExecutionLayout> {
    const layout = this.executionLayout(input.sessionId, input.executionId);
    await ensurePrivateDirectory(this.#home, layout.executionDir);
    await mkdir(layout.larkConfigDir, { mode: 0o700, recursive: true });
    await mkdir(layout.slackConfigDir, { mode: 0o700, recursive: true });
    const github = input.handles.get("github");
    if (github !== undefined) {
      await writeDurableFile(layout.gitConfigPath, "", 0o600);
      await writeDurableFile(layout.gitCredentialHelperPath, renderRuntimeProxyGitCredentialHelper(github), 0o700);
      await chmod(layout.gitCredentialHelperPath, 0o700);
    }
    const serialized = serializeEnvironment(input.environment, input.platform);
    const marked = `${EXECUTION_MARKER_PREFIX}${input.executionId}\n${serialized}`;
    await writeDurableFile(this.environmentFilePath(input.sessionId), marked, 0o600);
    // JSON has no `undefined`: unset markers serialize as null and the launcher deletes them.
    const manifestEnvironment = Object.fromEntries(
      Object.entries(input.environment).map(([key, value]) => [key, value ?? null]),
    );
    await writeDurableFile(
      this.manifestPath(input.sessionId),
      `${JSON.stringify({ schemaVersion: 1, executionId: input.executionId, environment: manifestEnvironment }, undefined, 2)}\n`,
      0o600,
    );
    const shimDir = this.shimDir(input.sessionId);
    await ensurePrivateDirectory(this.#home, shimDir);
    const environmentFilePath = this.environmentFilePath(input.sessionId);
    for (const binary of ["git", "gh"] as const) {
      const shimPath = join(shimDir, binary);
      await writeDurableFile(shimPath, renderRuntimeProxyShim(binary, environmentFilePath), 0o700);
      await chmod(shimPath, 0o700);
    }
    return layout;
  }

  /** Execution marker recorded in the stable env file; undefined when absent/foreign. */
  async publishedExecution(sessionId: string): Promise<string | undefined> {
    let content: string;
    try {
      content = await readFile(this.environmentFilePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const firstLine = content.split("\n", 1)[0] ?? "";
    return firstLine.startsWith(EXECUTION_MARKER_PREFIX) ? firstLine.slice(EXECUTION_MARKER_PREFIX.length) : undefined;
  }

  /**
   * Exact-execution cleanup: remove the execution directory; remove the stable env
   * file and manifest only while they still belong to this execution.
   */
  async cleanupExecution(sessionId: string, executionId: string): Promise<void> {
    await rm(this.executionLayout(sessionId, executionId).executionDir, { recursive: true, force: true });
    const published = await this.publishedExecution(sessionId).catch(() => undefined);
    if (published !== executionId) return;
    await rm(this.environmentFilePath(sessionId), { force: true });
    await rm(this.manifestPath(sessionId), { force: true });
  }

  /** Remove every proxy artifact for the Session (Session stop / shutdown). */
  async cleanupSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /** Startup sweep: remove every managed Session directory left by a previous run. */
  async cleanupStale(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((entry) => MANAGED_SESSION_DIR.test(entry))
        .map((entry) => rm(join(this.#root, entry), { recursive: true, force: true })),
    );
  }

  #within(root: string, ...segments: string[]): string {
    const path = join(root, ...segments);
    assertWithin(this.#root, path);
    return path;
  }
}
