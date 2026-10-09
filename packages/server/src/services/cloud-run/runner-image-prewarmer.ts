import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { ChannelName } from "@opentag/shared";
import { readBoundedJson } from "./bounded-json.js";
import type { CloudRunAdminConfig } from "./cloud-run-admin.js";
import type { AccessTokenProvider } from "./token-provider.js";

const PURPOSE = "runner-image-prewarm";
const PROBE_COMMAND = ["/usr/local/bin/runner-entrypoint"];
const PROBE_ARGS = [
  "/usr/local/bin/node",
  "-e",
  "require('node:http').createServer((req,res)=>res.end('image-import-probe')).listen(8080,'0.0.0.0');setTimeout(()=>process.exit(0),120000)",
];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export interface RunnerImagePrewarmerOptions {
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  preparationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export interface RunnerImagePrewarmResult {
  image: string;
  resourceName: string;
  uid: string;
  preparationMs: number;
  importedAt: unknown;
  runningAt: unknown;
  cacheRetentionGuaranteed: false;
}

/** Separate probe identity and command: this never allocates a business Sandbox or Session. */
export class RunnerImagePrewarmer {
  readonly resourceName: string;
  readonly image: string;
  readonly #config: CloudRunAdminConfig;
  readonly #environment: ChannelName;
  readonly #target: string;
  readonly #id: string;
  readonly #options: RunnerImagePrewarmerOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: NonNullable<RunnerImagePrewarmerOptions["sleep"]>;
  readonly #collection: string;
  readonly #v1: string;
  readonly #v2: string;

  constructor(environment: ChannelName, config: CloudRunAdminConfig, options: RunnerImagePrewarmerOptions) {
    this.#config = config;
    this.#environment = environment;
    this.image = config.image;
    // Stable across digest changes so a restart can remove the previous owned probe as well.
    this.#target = createHash("sha256")
      .update(
        JSON.stringify([
          environment,
          config.project,
          config.region,
          config.serviceAccount,
          config.vpc.network,
          config.vpc.subnetwork,
          config.vpc.executionTag,
          config.image.split("@")[0],
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    this.#id = `ot-warm-${environment[0]}-${this.#target}`;
    this.resourceName = `projects/${config.project}/locations/${config.region}/instances/${this.#id}`;
    this.#collection = `https://${config.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.project}/instances`;
    this.#v1 = `${this.#collection}/${this.#id}`;
    this.#v2 = `https://run.googleapis.com/v2/${this.resourceName}`;
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal });
      });
  }

  body(): Record<string, unknown> {
    const config = this.#config;
    return {
      apiVersion: "run.googleapis.com/v1",
      kind: "Instance",
      metadata: {
        name: this.#id,
        labels: {
          "opentag-purpose": PURPOSE,
          "opentag-prewarm-target": this.#target,
          "opentag-env": this.#environment,
        },
        annotations: {
          "run.googleapis.com/launch-stage": "BETA",
          "run.googleapis.com/ingress": "internal",
          "run.googleapis.com/default-url-disabled": "true",
          "run.googleapis.com/invoker-iam-disabled": "false",
          "run.googleapis.com/network-interfaces": JSON.stringify([
            { network: config.vpc.network, subnetwork: config.vpc.subnetwork, tags: [config.vpc.executionTag] },
          ]),
          "run.googleapis.com/vpc-access-egress": "all-traffic",
          "run.googleapis.com/cpu-throttling": "false",
        },
      },
      spec: {
        serviceAccountName: config.serviceAccount,
        restartPolicy: "Never",
        containers: [
          {
            image: config.image,
            command: PROBE_COMMAND,
            args: PROBE_ARGS,
            ports: [{ containerPort: 8080 }],
            resources: { limits: { cpu: "1", memory: "512Mi" } },
          },
        ],
      },
    };
  }

  /** One create attempt. An unknown response is reconciled by the same deterministic name. */
  async prepare(
    signal?: AbortSignal,
    assertLeadership: () => Promise<void> = async () => undefined,
  ): Promise<RunnerImagePrewarmResult> {
    const started = this.#now();
    const deadline = started + (this.#options.preparationTimeoutMs ?? 300_000);
    const state: { owned: boolean; uid?: string } = { owned: false };
    let result: RunnerImagePrewarmResult | undefined;
    let failure: unknown;
    try {
      result = await this.#prepare(started, deadline, state, assertLeadership, signal);
    } catch (error) {
      failure = error;
    }
    // Cleanup gets its own bounded budget and fresh tokens, even during graceful shutdown.
    if (state.owned) {
      try {
        await this.#cleanup(state.uid, assertLeadership);
      } catch (error) {
        throw new AggregateError(failure ? [failure, error] : [error], "Runner image prewarm cleanup failed");
      }
    }
    if (!result) throw failure;
    return result;
  }

  async #prepare(
    started: number,
    deadline: number,
    state: { owned: boolean; uid?: string },
    assertLeadership: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<RunnerImagePrewarmResult> {
    let existing = await this.#request("GET", this.#v1, deadline, signal);
    if (existing) {
      const identity = this.#assertOwned(existing, false);
      state.uid = identity.uid;
      state.owned = true;
      if (identity.image !== this.image || record(existing.metadata).deletionTimestamp) {
        state.owned = false;
        await this.#cleanup(state.uid, assertLeadership);
        existing = null;
        state.uid = undefined;
        state.owned = false;
      }
    }
    if (!existing) {
      await assertLeadership();
      state.owned = true;
      // The response can be lost after acceptance; never retry this POST blindly.
      const created = await this.#request("POST", this.#collection, deadline, signal, this.body());
      if (!created) throw new Error("Runner image prewarm create returned HTTP 404");
      // Some versions return an operation instead of the Instance; capture a returned UID when available.
      if (record(created.metadata).uid) state.uid = this.#assertOwned(created, false).uid;
    }
    return this.#waitReady(started, deadline, state, signal);
  }

  async #waitReady(
    started: number,
    deadline: number,
    state: { uid?: string },
    signal?: AbortSignal,
  ): Promise<RunnerImagePrewarmResult> {
    while (this.#now() < deadline) {
      signal?.throwIfAborted();
      const view = await this.#request("GET", this.#v1, deadline, signal);
      if (view) {
        const identity = this.#assertOwned(view, false);
        if (identity.image !== this.image || (state.uid && state.uid !== identity.uid)) {
          throw new Error("Runner image prewarm identity changed");
        }
        state.uid = identity.uid;
        const conditions = record(view.status).conditions;
        const entries = Array.isArray(conditions) ? conditions.map(record) : [];
        const imported = entries.find((entry) => entry.type === "ContainerReady" && entry.status === "True");
        const running = entries.find((entry) => entry.type === "Running" && entry.status === "True");
        if (imported && running && this.#now() < deadline) {
          return {
            image: this.image,
            resourceName: this.resourceName,
            uid: identity.uid,
            preparationMs: this.#now() - started,
            importedAt: imported.lastTransitionTime,
            runningAt: running.lastTransitionTime,
            cacheRetentionGuaranteed: false,
          };
        }
      }
      await this.#sleep(Math.min(2_000, Math.max(0, deadline - this.#now())), signal);
    }
    throw new Error("Runner image prewarm readiness deadline exceeded");
  }

  #assertOwned(view: Record<string, unknown>, v2: boolean): { uid: string; image: string } {
    const metadata = v2 ? view : record(view.metadata);
    const labels = record(metadata.labels);
    const spec = v2 ? view : record(view.spec);
    const containers = spec.containers;
    const container = Array.isArray(containers) && containers.length === 1 ? record(containers[0]) : {};
    const image = container.image;
    const account = v2 ? spec.serviceAccount : spec.serviceAccountName;
    const repository = this.image.split("@")[0];
    if (
      labels["opentag-purpose"] !== PURPOSE ||
      labels["opentag-prewarm-target"] !== this.#target ||
      labels["opentag-env"] !== this.#environment ||
      account !== this.#config.serviceAccount ||
      !isDeepStrictEqual(container.command, PROBE_COMMAND) ||
      !isDeepStrictEqual(container.args, PROBE_ARGS) ||
      (Array.isArray(container.env) ? container.env.length !== 0 : container.env !== undefined) ||
      typeof image !== "string" ||
      !image.startsWith(`${repository}@sha256:`) ||
      !/@sha256:[0-9a-f]{64}$/.test(image)
    )
      throw new Error("Runner image prewarm ownership mismatch; refusing to use or delete resource");
    if (typeof metadata.uid !== "string" || !metadata.uid) throw new Error("Runner image prewarm has no UID");
    return { uid: metadata.uid, image };
  }

  async #cleanup(expectedUid: string | undefined, assertLeadership: () => Promise<void>): Promise<void> {
    const deadline = this.#now() + (this.#options.cleanupTimeoutMs ?? 120_000);
    const current = await this.#request("GET", this.#v2, deadline);
    if (!current) return;
    const identity = this.#assertOwned(current, true);
    if (expectedUid && identity.uid !== expectedUid) throw new Error("Runner image prewarm cleanup UID changed");
    if (typeof current.etag !== "string" || !current.etag)
      throw new Error("Runner image prewarm cleanup requires etag");
    if (!current.deleteTime) {
      await assertLeadership();
      await this.#request("DELETE", `${this.#v2}?etag=${encodeURIComponent(current.etag)}`, deadline);
    }
    while (this.#now() < deadline) {
      const after = await this.#request("GET", this.#v2, deadline);
      if (!after) return;
      if (this.#assertOwned(after, true).uid !== identity.uid)
        throw new Error("Runner image prewarm cleanup UID changed");
      await this.#sleep(Math.min(2_000, Math.max(0, deadline - this.#now())));
    }
    throw new Error("Runner image prewarm deletion deadline exceeded");
  }

  async #request(
    method: string,
    url: string,
    deadline: number,
    signal?: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.#config.apiTimeoutMs, deadline - this.#now())));
    let token: string;
    try {
      // The existing metadata provider caches safely and refreshes one minute before expiry.
      token = await this.#options.tokenProvider();
    } catch {
      throw new Error("Runner image prewarm credentials unavailable");
    }
    signal?.throwIfAborted();
    if (this.#now() >= deadline) throw new Error("Runner image prewarm request deadline exceeded");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error(`Runner image prewarm ${method} transport failure`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Runner image prewarm ${method} failed with HTTP ${response.status}`);
    try {
      return record(await readBoundedJson(response));
    } catch {
      throw new Error(`Runner image prewarm ${method} returned invalid JSON`);
    }
  }
}
