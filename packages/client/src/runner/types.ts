export const RUNNER_IDENTITY_SCHEMA_VERSION = 1;
export const RUNNER_CLI_NAME = "opentag-runner";

export type RunnerChannel = "dev" | "staging" | "prod";
export type RunnerCommand = "probe" | "accept" | "identity" | "skills";
export type RunnerMode = "offline" | "real";

export interface RunnerToolLock {
  readonly git?: string;
  readonly gh?: string;
  readonly node: string;
  readonly piPackage: string;
  readonly piVersion: string;
  readonly pnpm: string;
}

export interface RunnerIdentity {
  readonly channel: RunnerChannel;
  readonly cliPackageName: string;
  readonly contextTreeVersion: string;
  readonly imageId?: string;
  readonly nodeVersion: string;
  readonly piPackage: string;
  readonly piVersion: string;
  readonly pnpmVersion: string;
  readonly schemaVersion: typeof RUNNER_IDENTITY_SCHEMA_VERSION;
  readonly sourceDirty: boolean;
  readonly sourceSha: string;
  readonly toolLock: RunnerToolLock;
  readonly version: string;
}

export interface RunnerCliInvocation {
  readonly command: RunnerCommand;
  readonly json: boolean;
  readonly mode: RunnerMode;
  readonly piConfigDir?: string;
  readonly provider?: string;
  readonly workspace?: string;
}

export type RunnerCliParseResult =
  | { readonly ok: true; readonly invocation: RunnerCliInvocation }
  | { readonly ok: false; readonly error: string; readonly exitCode: number };

export interface RunnerAcceptanceEvent {
  readonly name: string;
  readonly status: "failed" | "skipped" | "passed";
  readonly detail?: string;
}

/** Sanitized acceptance evidence: counts and names only, never command lines or contents. */
export interface RunnerAcceptanceEvidence {
  readonly cancel?: {
    readonly livePidsBeforeCancel: number;
    readonly trackedPiPids: number;
  };
  readonly skillsLoaded?: readonly string[];
  readonly tools?: {
    readonly names: readonly string[];
    readonly successfulCount: number;
  };
}

export interface RunnerAcceptanceReport {
  readonly events: readonly RunnerAcceptanceEvent[];
  readonly evidence?: RunnerAcceptanceEvidence;
  readonly failed: boolean;
  readonly firstTaskMs?: number;
  readonly identity?: RunnerIdentity;
  readonly model: "failed" | "skipped" | "passed";
  readonly offline: "failed" | "passed";
  readonly skillArguments?: readonly string[];
}
