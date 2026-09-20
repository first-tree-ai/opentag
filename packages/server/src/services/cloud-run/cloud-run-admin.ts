import type { ChannelName } from "@opentag/shared";
import { readBoundedJson } from "./bounded-json.js";
import { CloudRunAdminError } from "./errors.js";
import {
  RUNNER_INSTANCE_LABELS,
  RUNNER_INSTANCE_MANAGED_BY,
  type RunnerInstanceIdentityInput,
  runnerInstanceId,
  runnerInstanceLabels,
  runnerInstanceLabelsMatch,
  runnerInstanceResourceName,
} from "./instance-identity.js";
import type { AccessTokenProvider } from "./token-provider.js";

export interface CloudRunAdminConfig {
  project: string;
  region: string;
  serviceAccount: string;
  image: string;
  vpc: { network: string; subnetwork: string; executionTag: string };
  apiTimeoutMs: number;
}
export interface RunnerInstanceSpec extends RunnerInstanceIdentityInput {
  environment: ChannelName;
  backendUrl: string;
  bootstrapToken: string;
  /**
   * E7 physical control credential. Delivered to the Instance alongside the Session bootstrap
   * token so a Runner process restart can re-attach to whichever Sandbox currently holds this
   * physical instance; legacy Runners ignore the extra env var.
   */
  controlToken?: string;
  /** E5: arm the Runner-side workspace restore/save path; set only for workspace-enabled allocations. */
  workspacePersistence?: boolean;
}
export interface CloudRunInstanceView {
  name: string;
  uid: string;
  /** Provider spec generation, distinct from the Sandbox's environment generation. */
  generation?: string;
  labels: Record<string, string>;
  networkInterfaces: readonly { network?: string; subnetwork?: string; tags: readonly string[] }[];
  vpcEgress?: string;
  terminalState?: string;
  reconciling: boolean;
  etag?: string;
  /** Provider-observed allocation capability; undefined is unverified, never legacy proof. */
  workspacePersistence?: boolean;
  policy?: {
    ingress: unknown;
    defaultUriDisabled: unknown;
    invokerIamDisabled: unknown;
    restartPolicy: unknown;
    serviceAccount: unknown;
    containers: unknown;
  };
}
export interface CloudRunCreateResult {
  outcome: "created" | "adopted";
  instance: CloudRunInstanceView;
  operationName?: string;
}
export interface CloudRunAdminOptions {
  fetchImpl?: typeof fetch;
  tokenProvider: AccessTokenProvider;
  apiBaseUrl?: string;
  regionalApiBaseUrl?: (region: string) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
// A 400 rejected before allocation may use the equivalent regional v1 representation. No other
// error retries POST: a timeout/5xx may already have created the deterministic resource.
const VPC_REJECTION =
  "metadata.annotations[run.googleapis.com/vpc-access-egress]: The run.googleapis.com/vpc-access-egress annotation cannot be set without also setting the run.googleapis.com/vpc-access-connector annotation or the run.googleapis.com/network-interfaces annotation.";
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

function workspacePersistenceOf(value: unknown): boolean | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const container = record(value[0]);
  if (container.name !== "runner") return undefined;
  if (container.env === undefined) return false;
  if (!Array.isArray(container.env)) return undefined;
  if (container.env.some((entry) => typeof record(entry).name !== "string")) return undefined;
  const flags = container.env.map(record).filter((entry) => entry.name === "OPENTAG_RUNNER_WORKSPACE_PERSISTENCE");
  if (flags.length === 0) return false;
  return flags.length === 1 && flags[0]?.value === "1" && flags[0]?.valueSource === undefined ? true : undefined;
}
export class CloudRunAdmin {
  readonly #config: CloudRunAdminConfig;
  readonly #fetch: typeof fetch;
  readonly #tokenProvider: AccessTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #regionalApiBaseUrl: (region: string) => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  constructor(config: CloudRunAdminConfig, options: CloudRunAdminOptions) {
    this.#config = config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://run.googleapis.com";
    this.#regionalApiBaseUrl = options.regionalApiBaseUrl ?? ((r) => `https://${r}-run.googleapis.com`);
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }
  instanceIdFor(identity: RunnerInstanceIdentityInput): string {
    return runnerInstanceId(identity);
  }
  resourceNameFor(id: string): string {
    return runnerInstanceResourceName(this.#config.project, this.#config.region, id);
  }
  async createInstance(
    spec: RunnerInstanceSpec,
    options: { onOperation?: (name: string) => Promise<void> } = {},
  ): Promise<CloudRunCreateResult> {
    const id = runnerInstanceId(spec);
    const name = this.resourceNameFor(id);
    const parent = `projects/${this.#config.project}/locations/${this.#config.region}`;
    const response = await this.#request(
      "POST",
      `${this.#apiBaseUrl}/v2/${parent}/instances?instanceId=${encodeURIComponent(id)}`,
      this.#v2Body(spec),
    );
    if (response.status === 409) return { outcome: "adopted", instance: await this.#adopt(name, spec) };
    if (response.status === 400) {
      const body = record(await readBoundedJson(response));
      const message = record(body.error).message;
      if (message === VPC_REJECTION) return this.#createV1(spec, id, name);
    }
    if (!response.ok) throw this.#httpError(response, "create");
    const operation = record(await readBoundedJson(response));
    if (typeof operation.name !== "string")
      throw new CloudRunAdminError("unknown", "Cloud Run create returned no operation name");
    this.#assertOperationName(operation.name);
    await options.onOperation?.(operation.name);
    return { outcome: "created", operationName: operation.name, instance: await this.#adopt(name, spec, true) };
  }
  async getInstance(name: string, timeoutMs = this.#config.apiTimeoutMs): Promise<CloudRunInstanceView | undefined> {
    this.#assertResourceName(name);
    const r = await this.#request(
      "GET",
      `${this.#apiBaseUrl}/v2/${name}`,
      undefined,
      Math.min(timeoutMs, this.#config.apiTimeoutMs),
    );
    if (r.status === 404) return undefined;
    if (!r.ok) throw this.#httpError(r, "get");
    const body = record(await readBoundedJson(r));
    if (body.name !== name)
      throw new CloudRunAdminError("ownership_mismatch", "Cloud Run read returned a different resource name");
    if (typeof body.uid !== "string" || !body.uid || body.uid.length > 128)
      throw new CloudRunAdminError("unknown", "Cloud Run read returned no UID");
    const vpc = record(body.vpcAccess);
    const workspacePersistence = workspacePersistenceOf(body.containers);
    return {
      name,
      uid: body.uid,
      ...(typeof body.generation === "string" ? { generation: body.generation } : {}),
      labels: strings(body.labels),
      reconciling: body.reconciling === true,
      ...(workspacePersistence === undefined ? {} : { workspacePersistence }),
      networkInterfaces: Array.isArray(vpc.networkInterfaces)
        ? vpc.networkInterfaces.map((n) => {
            const nic = record(n);
            return {
              network: typeof nic.network === "string" ? nic.network : undefined,
              subnetwork: typeof nic.subnetwork === "string" ? nic.subnetwork : undefined,
              tags: Array.isArray(nic.tags) ? nic.tags.filter((s): s is string => typeof s === "string") : [],
            };
          })
        : [],
      ...(typeof vpc.egress === "string" ? { vpcEgress: vpc.egress } : {}),
      ...(typeof body.etag === "string" ? { etag: body.etag } : {}),
      ...(typeof record(body.terminalCondition).state === "string"
        ? { terminalState: record(body.terminalCondition).state as string }
        : {}),
      policy: {
        ingress: body.ingress,
        defaultUriDisabled: body.defaultUriDisabled,
        invokerIamDisabled: body.invokerIamDisabled,
        restartPolicy: body.restartPolicy,
        serviceAccount: body.serviceAccount,
        containers: body.containers,
      },
    };
  }
  async getOperation(name: string): Promise<{ done: boolean; errorCode?: number; resourceName?: string }> {
    this.#assertOperationName(name);
    const r = await this.#request("GET", `${this.#apiBaseUrl}/v2/${name}`);
    if (!r.ok) throw this.#httpError(r, "operation-get");
    const body = record(await readBoundedJson(r));
    if (body.name !== name) throw new CloudRunAdminError("ownership_mismatch", "Cloud Run operation identity changed");
    const response = record(body.response),
      error = record(body.error);
    const resourceName = typeof response.name === "string" ? response.name : undefined;
    if (resourceName) this.#assertResourceName(resourceName);
    return {
      done: body.done === true,
      ...(typeof error.code === "number" ? { errorCode: error.code } : {}),
      ...(resourceName ? { resourceName } : {}),
    };
  }
  async deleteInstance(name: string, expectedUid: string): Promise<{ operationName?: string; alreadyGone: boolean }> {
    const current = await this.getInstance(name);
    if (!current) return { alreadyGone: true };
    if (current.uid !== expectedUid)
      throw new CloudRunAdminError("ownership_mismatch", "Tracked Cloud Run Instance UID changed; refusing deletion");
    if (!current.etag)
      throw new CloudRunAdminError("unknown", "Cloud Run Instance has no etag; conditional deletion is unsafe");
    const r = await this.#request("DELETE", `${this.#apiBaseUrl}/v2/${name}?etag=${encodeURIComponent(current.etag)}`);
    if (r.status === 404) return { alreadyGone: true };
    if (!r.ok) throw this.#httpError(r, "delete");
    const body = record(await readBoundedJson(r));
    if (typeof body.name !== "string")
      throw new CloudRunAdminError("unknown", "Cloud Run deletion returned no operation identity");
    this.#assertOperationName(body.name);
    return { alreadyGone: false, operationName: body.name };
  }
  verifyNetworkAttachment(view: CloudRunInstanceView): void {
    const expected = this.#config.vpc;
    const matches = (actual: string | undefined, wanted: string, kind: "networks" | "subnetworks") => {
      const scope = kind === "networks" ? "global" : `regions/${this.#config.region}`;
      const full = `projects/${this.#config.project}/${scope}/${kind}/${wanted}`;
      return actual === wanted || actual === full || actual === `https://www.googleapis.com/compute/v1/${full}`;
    };
    const nic = view.networkInterfaces[0];
    if (
      view.networkInterfaces.length !== 1 ||
      !nic ||
      view.vpcEgress !== "ALL_TRAFFIC" ||
      !matches(nic.network, expected.network, "networks") ||
      !matches(nic.subnetwork, expected.subnetwork, "subnetworks") ||
      nic.tags.length !== 1 ||
      nic.tags[0] !== expected.executionTag
    ) {
      throw new CloudRunAdminError(
        "invalid",
        "Cloud Run Instance does not match the required Direct VPC, execution tag and ALL_TRAFFIC policy",
      );
    }
  }
  /** Ownership gates conditional cleanup even when the owned Instance violates execution policy. */
  verifyOwnership(view: CloudRunInstanceView, identity: RunnerInstanceIdentityInput): void {
    if (
      view.name !== this.resourceNameFor(runnerInstanceId(identity)) ||
      !runnerInstanceLabelsMatch(view.labels, identity)
    )
      throw new CloudRunAdminError(
        "ownership_mismatch",
        "Cloud Run Instance ownership does not match this Sandbox allocation",
      );
  }
  verifyInstance(view: CloudRunInstanceView, identity: RunnerInstanceIdentityInput): void {
    this.verifyOwnership(view, identity);
    this.#verifyExecutionPolicy(view);
  }

  /**
   * E7 tracked-binding proof for an instance that survives ownership transfers. The physical
   * labels keep their immutable BIRTH identity, so a later holder row can never reproduce them
   * from its own scope: name + tracked UID + the managed/environment labels prove this exact
   * physical resource, while the full execution policy (image, VPC, service account, resources,
   * ingress) still proves the deployment configuration. Strict birth labels remain mandatory on
   * first create/adopt via `verifyInstance`; they are never weakened there.
   */
  verifyTrackedInstance(
    view: CloudRunInstanceView,
    input: { resourceName: string; resourceUid: string; environment: ChannelName },
  ): void {
    this.verifyTrackedOwnership(view, input);
    this.#verifyExecutionPolicy(view);
  }

  /**
   * Reconnect acceptance for an already tracked, previously verified READY allocation after the
   * deployment target moved. Cloud Run permits image updates without changing UID. OpenTag
   * never patches Instance configuration, so only provider generation 1 proves the image is
   * still the one admitted at creation. Every non-image execution policy applies unchanged;
   * first admission and borrow eligibility still require the current target image.
   */
  verifyTrackedOriginalImage(
    view: CloudRunInstanceView,
    input: { resourceName: string; resourceUid: string; environment: ChannelName },
  ): void {
    this.verifyTrackedOwnership(view, input);
    const containers = Array.isArray(view.policy?.containers) ? view.policy.containers : [];
    const image = record(containers[0]).image;
    if (
      view.generation !== "1" ||
      typeof image !== "string" ||
      !/^[a-z0-9][a-z0-9._/-]{0,254}@sha256:[0-9a-f]{64}$/.test(image)
    ) {
      throw new CloudRunAdminError("invalid", "Cloud Run Instance no longer proves its original pinned image");
    }
    this.#verifyExecutionPolicy(view, { originalImage: true });
  }

  /**
   * Ownership only (name + tracked UID + managed/environment labels), without deployment policy.
   * Save, renewal and cleanup of an already-owned Instance must survive an image or VPC config
   * change; only the borrow/eligibility path re-applies the full execution policy.
   */
  verifyTrackedOwnership(
    view: CloudRunInstanceView,
    input: { resourceName: string; resourceUid: string; environment: ChannelName },
  ): void {
    if (
      view.name !== input.resourceName ||
      view.uid !== input.resourceUid ||
      view.labels[RUNNER_INSTANCE_LABELS.managedBy] !== RUNNER_INSTANCE_MANAGED_BY ||
      view.labels[RUNNER_INSTANCE_LABELS.environment] !== input.environment
    ) {
      throw new CloudRunAdminError(
        "ownership_mismatch",
        "Cloud Run Instance does not match the tracked physical binding",
      );
    }
  }

  #verifyExecutionPolicy(view: CloudRunInstanceView, options: { originalImage?: boolean } = {}): void {
    this.verifyNetworkAttachment(view);
    const p = view.policy;
    const containers = Array.isArray(p?.containers) ? p.containers : [];
    const c = record(containers[0]),
      limits = record(record(c.resources).limits);
    const cpu = limits.cpu,
      memory = limits.memory;
    const ports = Array.isArray(c.ports) ? c.ports : [];
    const containerPort = record(ports[0]).containerPort;
    // Strict admission requires exactly the target image. A previously admitted ORIGINAL image
    // must provably differ from the current target: equality here is a wrong-version report on
    // the current target build and stays rejected.
    const imageRejected =
      options.originalImage === true ? c.image === this.#config.image : c.image !== this.#config.image;
    // False scalar values may be omitted by protobuf JSON. Security-sensitive true values must be explicit.
    if (
      p?.ingress !== "INGRESS_TRAFFIC_INTERNAL_ONLY" ||
      p.defaultUriDisabled !== true ||
      (p.invokerIamDisabled !== undefined && p.invokerIamDisabled !== false) ||
      p.restartPolicy !== "NEVER" ||
      p.serviceAccount !== this.#config.serviceAccount ||
      containers.length !== 1 ||
      c.name !== "runner" ||
      imageRejected ||
      c.sandboxLauncher !== true ||
      (c.command !== undefined && JSON.stringify(c.command) !== "[]") ||
      (c.volumeMounts !== undefined && JSON.stringify(c.volumeMounts) !== "[]") ||
      // Protobuf JSON omits false; an explicit true would enable request-only CPU.
      (record(c.resources).cpuIdle !== undefined && record(c.resources).cpuIdle !== false) ||
      JSON.stringify(c.args) !== JSON.stringify(["opentag-runner", "serve"]) ||
      ports.length !== 1 ||
      containerPort !== 8080 ||
      !(cpu === "1" || cpu === "1000m") ||
      !(memory === "1Gi" || memory === "1024Mi")
    )
      throw new CloudRunAdminError(
        "invalid",
        "Cloud Run Instance does not match the required Runner image, port, identity, resource or ingress policy",
      );
  }
  async #createV1(spec: RunnerInstanceSpec, id: string, name: string): Promise<CloudRunCreateResult> {
    const c = this.#container(spec);
    c.resources = { limits: { cpu: "1", memory: "1Gi" } };
    const r = await this.#request(
      "POST",
      `${this.#regionalApiBaseUrl(this.#config.region)}/apis/run.googleapis.com/v1/namespaces/${this.#config.project}/instances`,
      {
        apiVersion: "run.googleapis.com/v1",
        kind: "Instance",
        metadata: {
          name: id,
          namespace: this.#config.project,
          labels: runnerInstanceLabels(spec),
          annotations: {
            "run.googleapis.com/launch-stage": "BETA",
            "run.googleapis.com/ingress": "internal",
            "run.googleapis.com/default-url-disabled": "true",
            "run.googleapis.com/invoker-iam-disabled": "false",
            "run.googleapis.com/network-interfaces": JSON.stringify(this.#nics()),
            "run.googleapis.com/vpc-access-egress": "all-traffic",
            "run.googleapis.com/cpu-throttling": "false",
          },
        },
        spec: { serviceAccountName: this.#config.serviceAccount, restartPolicy: "Never", containers: [c] },
      },
    );
    if (!r.ok && r.status !== 409) throw this.#httpError(r, "create-v1");
    // The regional v1 create API returns an Instance, not a long-running Operation. Do not
    // fabricate an operation name: preserve the deterministic resource until a UID is read.
    await r.body?.cancel();
    return { outcome: r.status === 409 ? "adopted" : "created", instance: await this.#adopt(name, spec, true) };
  }
  #nics() {
    return [
      {
        network: this.#config.vpc.network,
        subnetwork: this.#config.vpc.subnetwork,
        tags: [this.#config.vpc.executionTag],
      },
    ];
  }
  #container(spec: RunnerInstanceSpec): Record<string, unknown> {
    return {
      name: "runner",
      image: this.#config.image,
      sandboxLauncher: true,
      args: ["opentag-runner", "serve"],
      env: [
        { name: "OPENTAG_RUNNER_BACKEND_URL", value: spec.backendUrl },
        { name: "OPENTAG_RUNNER_BOOTSTRAP_TOKEN", value: spec.bootstrapToken },
        ...(spec.controlToken ? [{ name: "OPENTAG_RUNNER_CONTROL_TOKEN", value: spec.controlToken }] : []),
        { name: "OPENTAG_RUNNER_SANDBOX_NAME", value: runnerInstanceId(spec) },
        ...(spec.workspacePersistence === true ? [{ name: "OPENTAG_RUNNER_WORKSPACE_PERSISTENCE", value: "1" }] : []),
      ],
      resources: { limits: { cpu: "1", memory: "1Gi" }, cpuIdle: false },
      // The Instance ingress policy and the default TCP startup probe both require exactly this
      // single declared container port; the Runner listens here for probe connections only.
      ports: [{ containerPort: 8080 }],
    };
  }
  #v2Body(spec: RunnerInstanceSpec) {
    return {
      labels: runnerInstanceLabels(spec),
      ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
      defaultUriDisabled: true,
      invokerIamDisabled: false,
      launchStage: "BETA",
      restartPolicy: "NEVER",
      serviceAccount: this.#config.serviceAccount,
      vpcAccess: { egress: "ALL_TRAFFIC", networkInterfaces: this.#nics() },
      containers: [this.#container(spec)],
    };
  }
  async #adopt(name: string, identity: RunnerInstanceIdentityInput, pending = false): Promise<CloudRunInstanceView> {
    const deadline = this.#now() + (pending ? 60_000 : this.#config.apiTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      const view = await this.getInstance(name);
      if (view) {
        this.verifyInstance(view, identity);
        return view;
      }
      if (!pending || this.#now() >= deadline || attempt >= 10)
        throw new CloudRunAdminError(
          "unknown",
          "Cloud Run accepted allocation is not yet readable; keep its resource reference",
        );
      await this.#sleep(Math.min(1_000 * 2 ** attempt, 8_000));
    }
  }
  #assertResourceName(name: string): void {
    const prefix = `projects/${this.#config.project}/locations/${this.#config.region}/instances/`;
    if (!name.startsWith(prefix) || !/^ot-[dsp]-[a-f0-9]{32}-[a-z0-9]{1,11}$/.test(name.slice(prefix.length)))
      throw new CloudRunAdminError("invalid", "Cloud Run resource name is outside this Runner namespace");
  }
  #assertOperationName(name: string): void {
    const prefix = `projects/${this.#config.project}/locations/${this.#config.region}/operations/`;
    if (!name.startsWith(prefix) || !/^[a-zA-Z0-9_-]{1,200}$/.test(name.slice(prefix.length)))
      throw new CloudRunAdminError("invalid", "Cloud Run operation name is outside the configured project/region");
  }
  async #request(
    method: string,
    url: string,
    body?: Record<string, unknown>,
    timeoutMs = this.#config.apiTimeoutMs,
  ): Promise<Response> {
    let token: string;
    try {
      token = await this.#tokenProvider();
    } catch {
      // A token failure before POST is definitive non-submission. The same failure during the
      // post-create GET is uncertain and must retain the allocation reference.
      throw new CloudRunAdminError("credential", "Cloud Run Admin credentials could not be acquired", {
        createRejected: method === "POST",
      });
    }
    try {
      return await this.#fetch(url, {
        method,
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof CloudRunAdminError) throw error;
      // Never attach transport causes or remote field errors: either may echo submitted secrets.
      throw new CloudRunAdminError("unknown", `Cloud Run Admin ${method} transport failed`);
    }
  }
  #httpError(r: Response, operation: string): CloudRunAdminError {
    void r.body?.cancel().catch(() => undefined);
    const s = r.status;
    const kinds = { 404: "not_found", 409: "conflict", 401: "credential", 403: "credential", 400: "invalid" } as const;
    const kind = kinds[s as keyof typeof kinds] ?? (s >= 500 ? "unavailable" : "unknown");
    return new CloudRunAdminError(kind, `Cloud Run Admin ${operation} failed with HTTP ${s}`, {
      status: s,
      createRejected: (operation === "create" || operation === "create-v1") && [400, 401, 403, 404].includes(s),
    });
  }
}
