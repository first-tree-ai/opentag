import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeImOutboxContext } from "@opentag/shared";
import { assertWithin, ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { serializeEnvironment } from "./im-credential-environment-manager.js";
import type { RuntimeProxyCliMetadata, RuntimeProxyProvider } from "./runtime-credential-frames.js";

export const RUNTIME_PROXY_SHIM_MARKER = "# opentag-runtime-proxy-shim: v1";
export const RUNTIME_PROXY_GIT_HELPER_MARKER = "# opentag-runtime-proxy-git-helper: v1";
export const RUNTIME_PROXY_LAUNCHER_MARKER = "# opentag-runtime-proxy-launcher: v1";
const EXECUTION_MARKER_PREFIX = "# opentag-execution: ";
const MANAGED_SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Environment assembled for one execution; `undefined` unsets the inherited variable. */
export type RuntimeProxyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Execution-scoped routing inputs published to the Agent. They are deliberately not standard
 * tool variables: only the provider launchers translate them into the proxy/CA variables their
 * own CLI process needs, so the Agent's ordinary subprocesses keep public routing and the system
 * trust store. Neither value is a credential.
 */
export const RUNTIME_PROXY_PROVIDER_URL_KEY = "OPENTAG_PROVIDER_PROXY_URL";
export const RUNTIME_PROXY_PROVIDER_CA_KEY = "OPENTAG_PROVIDER_CA_PATH";

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
  readonly executionId?: string;
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
    OPENTAG_EXECUTION_ID: input.executionId,
    GH_HOST: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GH_CONFIG_DIR: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_ASKPASS: undefined,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    SSH_AGENT_PID: undefined,
    SSH_AUTH_SOCK: undefined,
  };
  const github = input.handles.get("github");
  if (github !== undefined) {
    Object.assign(environment, {
      GH_HOST: "github.com",
      GH_TOKEN: github,
      GH_CONFIG_DIR: join(input.layout.executionDir, "gh-config"),
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: `!sh '${input.layout.gitCredentialHelperPath}'`,
      GIT_CONFIG_GLOBAL: input.layout.gitConfigPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
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
    } satisfies Record<string, string | undefined>);
  }
  // GitHub Git/gh and the Slack CLI (including its fixed-origin file handles) reach the
  // execution adapter through these two scoped inputs. Nothing else reads them.
  Object.assign(environment, {
    [RUNTIME_PROXY_PROVIDER_URL_KEY]: input.connectProxyUrl,
    [RUNTIME_PROXY_PROVIDER_CA_KEY]: input.adapterCaCertPath,
  } satisfies Record<string, string>);
  return environment;
}

/**
 * Translate the scoped routing inputs into the standard variables provider CLIs and
 * explicitly-sourced provider shells honor. Apply this only at a provider use site: the Agent
 * runtime's own environment must never carry a global proxy or a private CA.
 */
export function providerRoutingEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const proxyUrl = environment[RUNTIME_PROXY_PROVIDER_URL_KEY];
  const caPath = environment[RUNTIME_PROXY_PROVIDER_CA_KEY];
  if (!proxyUrl || !caPath) return {};
  return {
    CURL_CA_BUNDLE: caPath,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: LOCAL_PROXY_BYPASS,
    SSL_CERT_FILE: caPath,
    https_proxy: proxyUrl,
    no_proxy: LOCAL_PROXY_BYPASS,
  };
}

/**
 * The execution Git configuration referenced through `GIT_CONFIG_GLOBAL`. The empty general
 * `http.proxy` disables every ambient proxy variable for Git, so only the explicit github.com
 * entry is routed through the credential proxy; other hosts (for example a public GitLab clone)
 * connect directly and keep the system CA.
 */
export function renderRuntimeProxyGitConfig(input: {
  readonly caCertPath: string;
  readonly connectProxyUrl: string;
  readonly privateGitProxyUrl?: string;
}): string {
  return `[http]
\tproxy = ${quoteGitConfigValue("")}
[http "https://github.com"]
\tproxy = ${quoteGitConfigValue(input.connectProxyUrl)}
\tsslCAInfo = ${quoteGitConfigValue(input.caCertPath)}
\tsslCAPath = ${quoteGitConfigValue(dirname(input.caCertPath))}
${input.privateGitProxyUrl ? `[http "http://github.com"]\n\tproxy = ${quoteGitConfigValue(input.privateGitProxyUrl)}\n` : ""}`;
}

function quoteGitConfigValue(value: string): string {
  return /[\s#"';]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
}

export function renderRuntimeProxyGitCredentialHelper(handle: string, privateHttp = false): string {
  // HTTPS is the default. Local publication also permits HTTP through its private GitHub-only Unix channel.
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
if [ "$host" = "github.com" ] && ${privateHttp ? '{ [ "$protocol" = "https" ] || [ "$protocol" = "http" ]; }' : '[ "$protocol" = "https" ]'}; then
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
${
  binary === "gh"
    ? `if [ -n "$OPENTAG_GH_CACHE_HOME" ]; then
  XDG_CACHE_HOME=$OPENTAG_GH_CACHE_HOME
  export XDG_CACHE_HOME
fi
`
    : ""
}${binary === "git" ? renderRuntimeProxyGitPreamble() : ""}exec "$real_binary" "$@"
`;
}

/** Native gh migrates unversioned config at startup, even for `--version`. Pre-migrate
 * generated configuration so sandboxed CLIs never need to write execution material. */
export function renderRuntimeProxyGhConfig(githubApiSocketPath?: string): string {
  return `version: "1"\n${githubApiSocketPath ? `http_unix_socket: ${JSON.stringify(githubApiSocketPath)}\n` : ""}`;
}

/**
 * Shell lines that scope the credential proxy and its execution CA to the process that sources
 * them. They never change the caller's environment and are a no-op without both scoped inputs.
 */
export function renderRuntimeProxyScopePreamble(): string {
  return `if [ -n "$OPENTAG_PROVIDER_PROXY_URL" ] && [ -n "$OPENTAG_PROVIDER_CA_PATH" ]; then
  HTTPS_PROXY=$OPENTAG_PROVIDER_PROXY_URL
  https_proxy=$OPENTAG_PROVIDER_PROXY_URL
  NO_PROXY=127.0.0.1,localhost
  no_proxy=127.0.0.1,localhost
  SSL_CERT_FILE=$OPENTAG_PROVIDER_CA_PATH
  CURL_CA_BUNDLE=$OPENTAG_PROVIDER_CA_PATH
  export HTTPS_PROXY https_proxy NO_PROXY no_proxy SSL_CERT_FILE CURL_CA_BUNDLE
fi`;
}

/** Keep injected CA settings for other origins; older Git retains the authenticated CONNECT route. */
function renderRuntimeProxyGitPreamble(): string {
  return `# Generic config preserves caller trust while GitHub's more specific execution CA wins.
if [ "\${GIT_SSL_CAINFO+x}" = x ]; then
  set -- -c "http.sslCAInfo=$GIT_SSL_CAINFO" "$@"
fi
if [ "\${GIT_SSL_CAPATH+x}" = x ]; then
  set -- -c "http.sslCAPath=$GIT_SSL_CAPATH" "$@"
fi
unset GIT_SSL_CAINFO GIT_SSL_CAPATH
if [ -r "$GIT_CONFIG_GLOBAL" ] && grep -q 'socks5h://localhost/' "$GIT_CONFIG_GLOBAL"; then
  git_version=$("$real_binary" --version) || exit 1
  git_version=\${git_version#git version }
  git_major=\${git_version%%.*}
  git_rest=\${git_version#*.}
  git_minor=\${git_rest%%.*}
  case "$git_major:$git_minor" in
    :*|*:|*[!0-9:]*) echo "opentag: cannot verify native Git Unix proxy support" >&2; exit 1 ;;
  esac
  if [ "$git_major" -lt 2 ] || { [ "$git_major" -eq 2 ] && [ "$git_minor" -lt 47 ]; }; then
    if [ -z "$OPENTAG_PROVIDER_PROXY_URL" ]; then
      echo "opentag: the execution Git CONNECT proxy is unavailable" >&2
      exit 1
    fi
    # Older Git drops SOCKS paths: retain HTTPS CONNECT without granting any sandbox TCP.
    set -- -c "http.http://github.com.proxy=$OPENTAG_PROVIDER_PROXY_URL" "$@"
  else
    # HTTP is confined to the private Unix channel, as with native gh. Stored remote URLs stay HTTPS.
    set -- -c "url.http://github.com/.insteadOf=https://github.com/" "$@"
  fi
fi
`;
}

/**
 * Sandbox-facing provider launcher: it resolves the real binary on PATH and scopes the credential
 * proxy plus its execution CA to exactly this CLI process. The Agent runtime environment itself
 * keeps public routing and the system trust store; only CLI invocations that need a platform
 * provider come through here (or through the pinned Slack launcher that also carries the scope).
 */
export function renderRuntimeProxyProviderLauncher(binary: string): string {
  return `#!/bin/sh
${RUNTIME_PROXY_LAUNCHER_MARKER} binary=${binary}
# OpenTag execution-local provider launcher: scope the credential proxy and CA to this process,
# then exec the real binary with unchanged argv, cwd, stdin, stdout, stderr, signals, and status.
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
${renderRuntimeProxyScopePreamble()}
${binary === "git" ? renderRuntimeProxyGitPreamble() : ""}exec "$real_binary" "$@"
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
    readonly githubApiSocketPath?: string;
    readonly githubGitSocketPath?: string;
    readonly platform: NodeJS.Platform;
    readonly sessionId: string;
  }): Promise<RuntimeProxyExecutionLayout> {
    const layout = this.executionLayout(input.sessionId, input.executionId);
    await ensurePrivateDirectory(this.#home, layout.executionDir);
    await mkdir(layout.larkConfigDir, { mode: 0o700, recursive: true });
    await mkdir(layout.slackConfigDir, { mode: 0o700, recursive: true });
    const github = input.handles.get("github");
    // gh officially supports HTTP over a Unix socket. A private execution socket avoids
    // changing the macOS trust store (Go <=1.26 ignores SSL_CERT_FILE there). Every request
    // still authenticates its local handle and crosses the same Server policy/Relay boundary.
    if (github !== undefined) {
      const configDir = join(layout.executionDir, "gh-config");
      await mkdir(configDir, { mode: 0o700, recursive: true });
      await writeDurableFile(
        join(configDir, "config.yml"),
        renderRuntimeProxyGhConfig(input.githubApiSocketPath),
        0o600,
      );
    }
    // Provider CLIs opened from the stable env file get the standard routing variables there; the
    // manifest stays scoped so the Agent runtime environment never turns them global.
    const routing = providerRoutingEnvironment(input.environment);
    if (github !== undefined && routing.HTTPS_PROXY !== undefined && routing.SSL_CERT_FILE !== undefined) {
      await writeDurableFile(
        layout.gitConfigPath,
        renderRuntimeProxyGitConfig({
          caCertPath: routing.SSL_CERT_FILE,
          connectProxyUrl: routing.HTTPS_PROXY,
          ...(github !== undefined && input.githubGitSocketPath
            ? { privateGitProxyUrl: `socks5h://localhost${input.githubGitSocketPath}` }
            : {}),
        }),
        0o600,
      );
    }
    if (github !== undefined) {
      await writeDurableFile(
        layout.gitCredentialHelperPath,
        renderRuntimeProxyGitCredentialHelper(github, input.githubGitSocketPath !== undefined),
        0o700,
      );
      await chmod(layout.gitCredentialHelperPath, 0o700);
    }
    const serialized = serializeEnvironment(
      {
        ...input.environment,
        ...routing,
        // Only the Local gh shim consumes this pointer. Reuse the adapter's private temporary
        // directory and close cleanup; never redirect the Agent's or another CLI's cache.
        OPENTAG_GH_CACHE_HOME:
          github !== undefined && input.githubApiSocketPath
            ? join(dirname(input.githubApiSocketPath), "cache")
            : undefined,
      },
      input.platform,
    );
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
      if (github === undefined) {
        await rm(shimPath, { force: true });
        continue;
      }
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
