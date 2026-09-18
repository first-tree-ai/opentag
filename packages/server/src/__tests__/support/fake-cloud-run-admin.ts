import type { CloudRunCreateResult, CloudRunInstanceView, RunnerInstanceSpec } from "../../services/cloud-run/index.js";
import { CloudRunAdminError } from "../../services/cloud-run/index.js";
import {
  type RunnerInstanceIdentityInput,
  runnerInstanceId,
  runnerInstanceLabels,
  runnerInstanceLabelsMatch,
  runnerInstanceResourceName,
} from "../../services/cloud-run/instance-identity.js";

export const FAKE_PROJECT = "unit-project";
export const FAKE_REGION = "us-west1";

const PROJECT = FAKE_PROJECT;
const REGION = FAKE_REGION;

export interface FakeInstance {
  uid: string;
  spec: RunnerInstanceSpec;
  labels: Record<string, string>;
  gone: boolean;
  etag: string;
  operationName: string;
}

export interface FakeOperation {
  state: "pending" | "done" | "error";
  errorCode?: number;
  resourceName?: string;
}

/** Deterministic fake of the CloudRunAdmin surface with full call recording. */
export class FakeCloudRunAdmin {
  instances = new Map<string, FakeInstance>();
  operations = new Map<string, FakeOperation>();
  createCalls: RunnerInstanceSpec[] = [];
  deleteCalls: { name: string; uid: string }[] = [];
  failNextCreateWith?: CloudRunAdminError;
  /** When set, the create "fails" but the resource was actually allocated (unknown result). */
  createUnknownOnce = false;
  /** When set, the create "fails" with an unknown result and NO resource is allocated. */
  createUnknownWithoutResourceOnce = false;
  deleteFailures = 0;
  /** When set, the next create blocks on this gate before landing (race simulation). */
  createGate?: { promise: Promise<void>; open: () => void };
  /** When set, `verifyInstance` throws this for the next calls (policy/ownership simulation). */
  failVerifyWith?: CloudRunAdminError;
  failVerifyCount = 0;
  /** When set, `getInstance` throws this once (transport simulation). */
  getInstanceFailures = 0;
  getOperationFailures = 0;
  /** When set, a successful delete immediately materializes a same-name replacement with this UID. */
  deleteSpawnsReplacementUid?: string;
  private uidCounter = 0;

  instanceIdFor(identity: RunnerInstanceIdentityInput) {
    return runnerInstanceId(identity);
  }
  resourceNameFor(instanceId: string) {
    return runnerInstanceResourceName(PROJECT, REGION, instanceId);
  }
  verifyNetworkAttachment(): void {}
  verifyOwnership(view: CloudRunInstanceView, identity: RunnerInstanceIdentityInput): void {
    if (
      view.name !== this.resourceNameFor(this.instanceIdFor(identity)) ||
      !runnerInstanceLabelsMatch(view.labels, identity)
    ) {
      throw new CloudRunAdminError(
        "ownership_mismatch",
        "Cloud Run Instance ownership does not match this Sandbox allocation",
      );
    }
  }
  verifyInstance(view: CloudRunInstanceView, identity: RunnerInstanceIdentityInput): void {
    if (this.failVerifyWith && this.failVerifyCount !== 0) {
      if (this.failVerifyCount > 0) this.failVerifyCount -= 1;
      throw this.failVerifyWith;
    }
    if (
      view.name !== this.resourceNameFor(this.instanceIdFor(identity)) ||
      !runnerInstanceLabelsMatch(view.labels, identity)
    ) {
      throw new CloudRunAdminError(
        "ownership_mismatch",
        "Cloud Run Instance ownership does not match this Sandbox allocation",
      );
    }
    if (view.networkInterfaces.length !== 1) {
      throw new CloudRunAdminError("invalid", "Cloud Run Instance does not match the required network policy");
    }
  }

  /** Simulate a name collision whose labels prove the resource is NOT ours. */
  tamperLabels(name: string, labels: Record<string, string>): void {
    const instance = this.instances.get(name);
    if (instance) instance.labels = labels;
  }

  /** Simulate a replaced Instance sharing the deterministic name (different UID). */
  replaceUid(name: string, uid: string): void {
    const instance = this.instances.get(name);
    if (instance) instance.uid = uid;
  }

  async createInstance(
    spec: RunnerInstanceSpec,
    options: { onOperation?: (name: string) => Promise<void> } = {},
  ): Promise<CloudRunCreateResult> {
    this.createCalls.push(spec);
    const id = this.instanceIdFor(spec);
    const name = this.resourceNameFor(id);
    if (this.createGate) {
      const gate = this.createGate;
      this.createGate = undefined;
      await gate.promise;
    }
    if (this.failNextCreateWith) {
      const error = this.failNextCreateWith;
      this.failNextCreateWith = undefined;
      throw error;
    }
    const existing = this.instances.get(name);
    if (existing && !existing.gone) {
      if (existing.operationName) await options.onOperation?.(existing.operationName);
      return { outcome: "adopted", instance: this.view(name, existing) };
    }
    if (this.createUnknownOnce) {
      this.createUnknownOnce = false;
      this.land(name, spec);
      throw new CloudRunAdminError("unknown", "transport died after the resource was created");
    }
    if (this.createUnknownWithoutResourceOnce) {
      this.createUnknownWithoutResourceOnce = false;
      throw new CloudRunAdminError("unknown", "transport died before the result was known");
    }
    const instance = this.land(name, spec);
    const operationName = instance.operationName;
    await options.onOperation?.(operationName);
    return {
      outcome: "created",
      operationName,
      instance: this.view(name, instance),
    };
  }

  async getInstance(name: string): Promise<CloudRunInstanceView | undefined> {
    if (this.getInstanceFailures > 0) {
      this.getInstanceFailures -= 1;
      throw new CloudRunAdminError("unavailable", "backend read failed", { status: 500 });
    }
    const instance = this.instances.get(name);
    if (!instance || instance.gone) return undefined;
    return this.view(name, instance);
  }

  async getOperation(name: string): Promise<{ done: boolean; errorCode?: number; resourceName?: string }> {
    if (this.getOperationFailures > 0) {
      this.getOperationFailures -= 1;
      throw new CloudRunAdminError("unavailable", "backend operation read failed", { status: 500 });
    }
    const operation = this.operations.get(name);
    if (!operation) return { done: true, errorCode: 404 };
    if (operation.state === "pending") return { done: false };
    if (operation.state === "error") {
      return {
        done: true,
        ...(operation.errorCode !== undefined ? { errorCode: operation.errorCode } : { errorCode: 13 }),
      };
    }
    return { done: true, ...(operation.resourceName !== undefined ? { resourceName: operation.resourceName } : {}) };
  }

  async deleteInstance(name: string, expectedUid: string): Promise<{ operationName?: string; alreadyGone: boolean }> {
    this.deleteCalls.push({ name, uid: expectedUid });
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new CloudRunAdminError("unavailable", "backend delete failed", { status: 500 });
    }
    const instance = this.instances.get(name);
    if (!instance || instance.gone) return { alreadyGone: true };
    if (instance.uid !== expectedUid) {
      throw new CloudRunAdminError("ownership_mismatch", "uid mismatch");
    }
    instance.gone = true;
    if (this.deleteSpawnsReplacementUid) {
      const replacement: FakeInstance = {
        ...instance,
        uid: this.deleteSpawnsReplacementUid,
        gone: false,
        etag: `${instance.etag}-replacement`,
      };
      this.deleteSpawnsReplacementUid = undefined;
      this.instances.set(name, replacement);
    }
    return { alreadyGone: false, operationName: `projects/${PROJECT}/locations/${REGION}/operations/del-1` };
  }

  completeOperation(name: string, resourceName: string): void {
    this.operations.set(name, { state: "done", resourceName });
  }

  /** Materialize a resource for a spec without going through the create endpoint. */
  materialize(spec: RunnerInstanceSpec): void {
    const name = this.resourceNameFor(this.instanceIdFor(spec));
    this.land(name, spec);
  }

  private land(name: string, spec: RunnerInstanceSpec): FakeInstance {
    const ordinal = ++this.uidCounter;
    const operationName = `projects/${PROJECT}/locations/${REGION}/operations/op-${ordinal}`;
    const instance: FakeInstance = {
      uid: `uid-${ordinal}`,
      spec,
      labels: runnerInstanceLabels(spec),
      gone: false,
      etag: `etag-${ordinal}`,
      operationName,
    };
    this.instances.set(name, instance);
    this.operations.set(operationName, { state: "pending", resourceName: name });
    return instance;
  }

  private view(name: string, instance: FakeInstance): CloudRunInstanceView {
    return {
      name,
      uid: instance.uid,
      etag: instance.etag,
      labels: { ...instance.labels },
      networkInterfaces: [{ network: "n", subnetwork: "s", tags: ["t"] }],
      vpcEgress: "ALL_TRAFFIC",
      reconciling: false,
      workspacePersistence: instance.spec.workspacePersistence === true,
      policy: {
        ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
        defaultUriDisabled: true,
        invokerIamDisabled: false,
        restartPolicy: "NEVER",
        serviceAccount: "runner@unit-project.iam.gserviceaccount.com",
        containers: [
          {
            name: "runner",
            image: "unit/image@sha256:0000000000000000000000000000000000000000000000000000000000000000",
            sandboxLauncher: true,
            args: ["opentag-runner", "serve"],
            resources: { limits: { cpu: "1", memory: "1Gi" } },
            ports: [{ containerPort: 8080 }],
          },
        ],
      },
    };
  }

  liveInstanceCount(): number {
    return [...this.instances.values()].filter((instance) => !instance.gone).length;
  }
}
