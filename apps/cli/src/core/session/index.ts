import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  OpenTagApi,
  OpenTagApiError,
  readComputerIdentity,
  readSessionCliProofFile,
  resolveOpenTagHome,
} from "@opentag/client";
import {
  SESSION_CLI_DEFAULT_LIMIT,
  type SessionCliCommandResponse,
  SessionCliCreateRequestSchema,
  SessionCliListQuerySchema,
  type SessionCliListResponse,
  SessionCliSendRequestSchema,
} from "@opentag/shared";

export interface SessionMessageOptions {
  message?: string;
  messageFile?: string;
  messageId?: string;
}

export class SessionCommandRequestError extends Error {
  readonly code: string;
  readonly messageId: string;
  readonly status: "rejected" | "unknown";

  constructor(messageId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : "Session request failed";
    super(message, { cause });
    this.name = "SessionCommandRequestError";
    this.messageId = messageId;
    this.status = cause instanceof OpenTagApiError && cause.category !== "transient" ? "rejected" : "unknown";
    this.code = cause instanceof OpenTagApiError ? cause.code : "transport_error";
  }
}

async function context(environment: NodeJS.ProcessEnv = process.env): Promise<{ api: OpenTagApi; proof: string }> {
  const proofPath = environment.OPENTAG_SESSION_PROOF_FILE;
  if (!proofPath) {
    throw new Error(
      "Session commands are available only inside an OpenTag-managed Agent Session (runtime context missing)",
    );
  }
  const home = resolveOpenTagHome(environment);
  const identity = await readComputerIdentity(home);
  if (!identity) {
    throw new Error(
      "Session commands are available only inside an OpenTag-managed Agent Session (Computer binding missing)",
    );
  }
  const proof = await readSessionCliProofFile(proofPath);
  return { api: new OpenTagApi(identity.serverUrl), proof: proof.token };
}

export async function runSessionCreate(
  options: SessionMessageOptions & { model?: string; reasoningEffort?: string; maxDurationMs?: number },
): Promise<SessionCliCommandResponse> {
  const message = await resolveMessage(options);
  const input = SessionCliCreateRequestSchema.parse({
    messageId: options.messageId ?? randomUUID(),
    message,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    maxDurationMs: options.maxDurationMs,
  });
  const runtime = await context();
  return requestWithRetryKey(input.messageId, () => runtime.api.createInternalSession(runtime.proof, input));
}

export async function runSessionSend(
  targetSessionId: string,
  options: SessionMessageOptions,
): Promise<SessionCliCommandResponse> {
  const message = await resolveMessage(options);
  const input = SessionCliSendRequestSchema.parse({
    messageId: options.messageId ?? randomUUID(),
    targetSessionId,
    message,
  });
  const runtime = await context();
  return requestWithRetryKey(input.messageId, () => runtime.api.sendSessionMessage(runtime.proof, input));
}

export async function requestWithRetryKey<T>(messageId: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw new SessionCommandRequestError(messageId, error);
  }
}

export async function runSessionList(options: {
  recursive?: boolean;
  limit?: number;
  cursor?: string;
  since?: string;
}): Promise<SessionCliListResponse> {
  const input = SessionCliListQuerySchema.parse({
    recursive: options.recursive ?? false,
    limit: options.limit ?? SESSION_CLI_DEFAULT_LIMIT,
    cursor: options.cursor,
    since: options.since,
  });
  const runtime = await context();
  return runtime.api.listInternalSessions(runtime.proof, input);
}

export function formatSessionCommandResult(result: SessionCliCommandResponse): string {
  return [
    `status=${result.status}`,
    `messageId=${result.messageId}`,
    ...(result.sessionId ? [`sessionId=${result.sessionId}`] : []),
    ...(result.code ? [`code=${result.code}`] : []),
  ].join(" ");
}

export function formatSessionCommandError(error: SessionCommandRequestError, json: boolean): string {
  const result = {
    status: error.status,
    messageId: error.messageId,
    code: error.code,
    message: error.message,
  };
  return json
    ? JSON.stringify(result)
    : `status=${result.status} messageId=${result.messageId} code=${result.code} message=${JSON.stringify(result.message)}`;
}

export function formatSessionList(result: SessionCliListResponse): string {
  const header = "SESSION ID\tPARENT SESSION\tCREATED\tLAST MESSAGE\tOUTCOME\tTASK";
  const rows = result.items.map((item) =>
    [
      item.sessionId,
      item.parentSessionId,
      item.createdAt,
      item.lastMessageAt,
      item.lastDeliveryOutcome,
      item.taskPreview.replaceAll("\t", " ").replaceAll("\n", " "),
    ].join("\t"),
  );
  if (result.nextCursor) rows.push(`Next cursor: ${result.nextCursor}`);
  return [header, ...rows].join("\n");
}

async function resolveMessage(options: SessionMessageOptions): Promise<string> {
  if ((options.message === undefined) === (options.messageFile === undefined)) {
    throw new Error("Exactly one of --message and --message-file is required");
  }
  const message =
    options.message ??
    (options.messageFile === "-" ? await readStandardInput() : await readFile(options.messageFile as string, "utf8"));
  if (!message) throw new Error("Session messages cannot be empty");
  return message;
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}
