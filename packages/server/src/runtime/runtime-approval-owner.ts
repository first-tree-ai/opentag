import { createHash } from "node:crypto";
import {
  type RuntimeApprovalDecision,
  type RuntimeApprovalRequest,
  RuntimeApprovalRequestSchema,
  RuntimeApprovalResultSchema,
} from "@opentag/shared";
import { z } from "zod";
import type { loadApprovalAuthority } from "./approval-authority.js";
import type { ApprovalStore, PendingApproval } from "./approval-store.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "./runtime-session.js";

const ApprovalFrameSchema = z.union([RuntimeApprovalRequestSchema, RuntimeApprovalResultSchema]);
export interface ApprovalAction {
  approvalId: string;
  decision: "accept" | "decline";
  userId: string;
  provider: "slack" | "feishu";
  generation: number;
  installationId?: string;
  imBindingId?: string;
  messageId: string;
  channelId: string;
}
interface Options {
  store: ApprovalStore;
  registry: Pick<ConnectionRegistry, "isCurrentConnection" | "send">;
  serverInstanceId: string;
  authority: (
    request: RuntimeApprovalRequest,
    context: Pick<RuntimeBusinessContext, "computerId" | "instanceId">,
  ) => ReturnType<typeof loadApprovalAuthority>;
  messenger: {
    post(approval: PendingApproval): Promise<{ messageId: string; channelId: string }>;
    finish(approval: PendingApproval): Promise<void>;
  };
  onError(): void;
  now?: () => number;
}

export class RuntimeApprovalOwner {
  readonly #now: () => number;
  readonly #sent = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  #polling = false;
  #lastPurge = 0;
  constructor(private readonly options: Options) {
    this.#now = options.now ?? Date.now;
  }
  start() {
    this.#timer = setInterval(() => void this.poll().catch(() => this.options.onError()), 1000);
    this.#timer.unref();
  }
  close() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#sent.clear();
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = ApprovalFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => `approval:${frame.sessionId}`,
      handle: async (frame, context) => {
        const parsed = ApprovalFrameSchema.parse(frame);
        if (parsed.type === "approval:request") return this.request(parsed, context);
        await this.complete(RuntimeApprovalResultSchema.parse(parsed), context);
      },
      failureResult: (frame) =>
        frame.type === "approval:request" ? decline(RuntimeApprovalRequestSchema.parse(frame)) : undefined,
      overloadResult: (frame) =>
        frame.type === "approval:request" ? decline(RuntimeApprovalRequestSchema.parse(frame)) : undefined,
    };
  }

  private async complete(
    parsed: import("@opentag/shared").RuntimeApprovalResult,
    context: RuntimeBusinessContext,
  ): Promise<void> {
    const id = approvalId(parsed, context);
    const row = await this.options.store.find(id);
    if (!row || !this.current(row) || (row.status !== "accept" && row.status !== "decline")) return;
    const status = parsed.status === "applied" ? (row.status === "accept" ? "approved" : "denied") : "stale";
    if (await this.options.store.update(id, row.status, { status })) {
      this.#sent.delete(id);
    }
  }

  async request(request: RuntimeApprovalRequest, context: RuntimeBusinessContext) {
    if (
      !context.connectionId ||
      !this.options.registry.isCurrentConnection(context.computerId, context.instanceId, context.connectionId)
    )
      return decline(request);
    const scope = await this.options.authority(request, context);
    if (!scope) return decline(request);
    const expiresAt = new Date(Math.min(Date.parse(request.expiresAt), scope.deadlineAt.getTime()));
    if (expiresAt.getTime() <= this.#now()) return decline(request);
    const row: PendingApproval = {
      id: approvalId(request, context),
      serverInstanceId: this.options.serverInstanceId,
      computerId: context.computerId,
      instanceId: context.instanceId,
      connectionId: context.connectionId,
      imBindingId: scope.imBindingId,
      authority: scope.authority,
      request: { ...request, expiresAt: expiresAt.toISOString() },
      status: "pending",
      expiresAt,
      messageId: null,
      messageChannelId: null,
      cardUpdatedAt: null,
    };
    if (!(await this.options.store.insert(row))) return;
    try {
      const message = await this.options.messenger.post(row);
      await this.options.store.update(row.id, "pending", {
        messageId: message.messageId,
        messageChannelId: message.channelId,
      });
    } catch {
      await this.options.store.update(row.id, "pending", { status: "stale" });
      this.options.onError();
      return decline(request);
    }
    return;
  }

  async decide(action: ApprovalAction): Promise<"recorded" | "unavailable"> {
    if (!z.string().uuid().safeParse(action.approvalId).success) return "unavailable";
    const row = await this.options.store.find(action.approvalId);
    if (!row || row.status !== "pending" || row.expiresAt.getTime() <= this.#now() || !matchesActor(row, action))
      return "unavailable";
    // The callback can arrive at a different server replica. Durable decision delivery stays
    // with the replica holding the runtime socket; authority is checked on both sides.
    const scope = await this.options.authority(row.request, row);
    if (!scope || !sameAuthority(row, scope)) return "unavailable";
    return (await this.options.store.update(row.id, "pending", { status: action.decision }))
      ? "recorded"
      : "unavailable";
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      for (const row of await this.options.store.list(this.options.serverInstanceId)) await this.pollApproval(row);
      if (this.#now() - this.#lastPurge > 3600_000) {
        await this.options.store.purge(new Date(this.#now() - 7 * 86400_000));
        this.#lastPurge = this.#now();
      }
    } finally {
      this.#polling = false;
    }
  }

  private async pollApproval(row: PendingApproval): Promise<void> {
    if (isResolved(row.status)) {
      await this.finish(row);
      return;
    }
    const current = this.current(row);
    const expired = row.expiresAt.getTime() <= this.#now();
    // A pending card cannot approve a changed binding: decide() rechecks authority on click.
    if (row.status === "pending" && current && !expired) return;
    const scope = current && !expired ? await this.options.authority(row.request, row) : undefined;
    if (!scope || !sameAuthority(row, scope)) {
      await this.invalidate(row, current);
      return;
    }
    if (this.#sent.has(row.id)) return;
    if (row.status !== "accept" && row.status !== "decline") return;
    // Fence before sending; an uncertain write never replays an approval.
    this.#sent.add(row.id);
    try {
      await this.options.registry.send(row.computerId, row.instanceId, {
        ...decline(row.request),
        decision: row.status,
      });
    } catch {
      await this.options.store.update(row.id, row.status, { status: "stale" });
      this.#sent.delete(row.id);
      this.options.onError();
    }
  }

  private async invalidate(row: PendingApproval, current: boolean): Promise<void> {
    if (!(await this.options.store.update(row.id, row.status, { status: "stale" }))) return;
    this.#sent.delete(row.id);
    if (current) await this.options.registry.send(row.computerId, row.instanceId, decline(row.request));
  }

  private current(row: PendingApproval) {
    return this.options.registry.isCurrentConnection(row.computerId, row.instanceId, row.connectionId);
  }
  private async finish(row: PendingApproval) {
    try {
      await this.options.messenger.finish(row);
      await this.options.store.update(row.id, row.status, { cardUpdatedAt: new Date(this.#now()) });
    } catch {
      this.options.onError();
    }
  }
}
function isResolved(status: PendingApproval["status"]): boolean {
  return status === "approved" || status === "denied" || status === "stale";
}
function sameAuthority(
  row: PendingApproval,
  scope: NonNullable<Awaited<ReturnType<typeof loadApprovalAuthority>>>,
): boolean {
  const a = row.authority;
  const b = scope.authority;
  return (
    row.imBindingId === scope.imBindingId &&
    a.senderExternalId === b.senderExternalId &&
    a.provider === b.provider &&
    a.generation === b.generation &&
    a.installationId === b.installationId &&
    a.channelId === b.channelId &&
    a.threadKey === b.threadKey &&
    a.externalMessageId === b.externalMessageId &&
    a.configRevision === b.configRevision
  );
}

export function matchesActor(row: PendingApproval, action: ApprovalAction): boolean {
  const authority = row.authority;
  return (
    action.provider === authority.provider &&
    action.userId === authority.senderExternalId &&
    action.generation === authority.generation &&
    action.messageId === row.messageId &&
    action.channelId === row.messageChannelId &&
    (action.provider === "slack"
      ? action.installationId === authority.installationId
      : action.imBindingId === row.imBindingId)
  );
}
function decline(request: RuntimeApprovalRequest): RuntimeApprovalDecision {
  const { title: _title, description: _description, expiresAt: _expiresAt, ...identity } = request;
  return { ...identity, type: "approval:decision", decision: "decline" };
}
function approvalId(
  request: Pick<RuntimeApprovalRequest, "requestId" | "turnId" | "sessionId" | "deliveryId" | "placementGeneration">,
  context: Pick<RuntimeBusinessContext, "computerId" | "instanceId">,
) {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        context.computerId,
        context.instanceId,
        request.sessionId,
        request.deliveryId,
        request.turnId,
        request.placementGeneration,
        request.requestId,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
