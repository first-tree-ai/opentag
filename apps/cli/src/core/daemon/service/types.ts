export type DaemonServiceState = "active" | "inactive" | "not-installed" | "unknown";
export type DaemonServicePlatform = "launchd" | "systemd" | "unsupported";

export interface RuntimeOwnerInfo {
  consistency: "consistent" | "malformed" | "missing" | "stale" | "unmanaged" | "unverified";
  pid?: number;
}

export interface DaemonServiceInfo {
  configuredHome?: string;
  currentHome: string;
  definitionPath: string;
  detail?: string;
  drifted?: boolean;
  logHint: string;
  pid?: number;
  platform: DaemonServicePlatform;
  runtimeOwner?: RuntimeOwnerInfo;
  serviceId: string;
  state: DaemonServiceState;
}

export interface ResolvedCliInvocation {
  args: string[];
  program: string;
}

export interface CommandRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CommandResult {
  code: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface ServiceRunner {
  run(program: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
}

export interface DaemonServiceBackend {
  readonly platform: DaemonServicePlatform;
  installAndStart(): Promise<DaemonServiceInfo>;
  preflight(): Promise<void>;
  /**
   * Rewrite the on-disk service definition from the current binary's templates without restarting
   * the service. Used by the portable upgrade handoff so the definition the supervisor reloads
   * comes from the newly installed version.
   */
  refreshDefinition(): Promise<DaemonServiceInfo>;
  restart(): Promise<DaemonServiceInfo>;
  start(): Promise<DaemonServiceInfo>;
  status(): Promise<DaemonServiceInfo>;
  stop(): Promise<DaemonServiceInfo>;
  uninstall(): Promise<DaemonServiceInfo>;
}

export type DaemonServiceErrorCode =
  | "BUSY"
  | "CONFIGURATION"
  | "MANAGER_UNAVAILABLE"
  | "NOT_INSTALLED"
  | "OPERATION_FAILED"
  | "UNSUPPORTED_PLATFORM";

export class DaemonServiceError extends Error {
  override readonly name = "DaemonServiceError";

  constructor(
    readonly code: DaemonServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
