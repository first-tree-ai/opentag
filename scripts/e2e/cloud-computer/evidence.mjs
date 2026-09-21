import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { processExists, waitFor } from "./common.mjs";

export async function waitRecordedTurn(postgres, deliveryId, expectedSessionId, expectedOutcome = "completed") {
  if (!/^[a-f0-9-]{36}$/i.test(deliveryId ?? "")) throw new Error("Ingress did not return a delivery UUID");
  const report = await waitFor(
    "Server-recorded Turn result",
    async () => {
      const text = await postgres.psql(`select json_build_object(
      'deliveryId', id, 'sessionId', session_id, 'state', state, 'turnId', turn_id,
      'reportedAt', reported_at, 'outcome', turn_report->>'outcome',
      'errorReason', turn_report->>'errorReason', 'resultHash', result_hash,
      'usage', turn_report->'usage')::text from im_message_deliveries where id = '${deliveryId}'`);
      const row = text ? JSON.parse(text) : undefined;
      return row?.reportedAt ? row : false;
    },
    { timeoutMs: 180_000, intervalMs: 500 },
  );
  if (expectedSessionId && report.sessionId !== expectedSessionId)
    throw new Error("Delivery created a different Session");
  if (expectedOutcome && report.outcome !== expectedOutcome)
    throw new Error(`Turn outcome ${report.outcome}: ${report.errorReason ?? "no reason"}`);
  if (!report.resultHash || !report.turnId) throw new Error("Recorded Turn has no result hash or Turn id");
  return report;
}

/** Inspect only this fixture's generated Pi history; never include message or tool argument content. */
export async function readPiEvidence(piHome, sessionId) {
  const root = join(piHome, "sessions");
  const paths = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl"));
  for (const path of paths) {
    const records = (await readFile(join(root, path), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!records.some((record) => record.type === "session" && record.id === sessionId)) continue;
    return summarizePiRecords(records, sessionId);
  }
  throw new Error("Could not find the generated Pi session history");
}

export async function waitProcessesGone(pids) {
  if (!pids.length) throw new Error("No running process was observed before stop");
  await waitFor(
    "observed Pi and task processes to exit",
    async () => {
      const running = await Promise.all(pids.map(processExists));
      return running.every((value) => !value);
    },
    { timeoutMs: 30_000, intervalMs: 200 },
  );
}

function summarizePiRecords(records, sessionId) {
  const messages = records.filter((record) => record.type === "message").map((record) => record.message);
  const assistants = messages.filter((message) => message?.role === "assistant");
  const models = assistants
    .filter((message) => message.provider && message.model)
    .map((message) => `${message.provider}/${message.model}`);
  const tools = assistants.flatMap((message) =>
    (message.content ?? []).filter((content) => content.type === "toolCall").map((content) => content.name),
  );
  return { sessionId, models: [...new Set(models)], tools, messageCount: messages.length };
}
