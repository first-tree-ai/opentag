import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { listPiProcesses, processExists } from "./common.mjs";

export function deriveRuntimeKey(kind, id) {
  const digest = createHash("sha256").update(`${kind}\0${id}`, "utf8").digest("hex");
  return `${kind[0]}-${digest.slice(0, 40)}`;
}

export function agentWorkspaceRoot(home, agentId) {
  return resolve(home, "data", "workspaces", deriveRuntimeKey("agent", agentId));
}

export function sessionBindingFile(home, agentId, sessionId) {
  return resolve(
    home,
    "data",
    "runtime",
    "session-bindings",
    deriveRuntimeKey("agent", agentId),
    `${deriveRuntimeKey("session", sessionId)}.json`,
  );
}

export async function readSessionBinding(home, agentId, sessionId) {
  const path = sessionBindingFile(home, agentId, sessionId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const payload = parsed?.runtimeBinding?.payload;
    return {
      path,
      sessionId: parsed.sessionId,
      agentId: parsed.agentId,
      provider: parsed.provider,
      placementGeneration: parsed.placementGeneration,
      piSessionId: payload && typeof payload === "object" ? payload.sessionId : undefined,
      sessionFileHash: payload && typeof payload === "object" ? payload.sessionFileHash : undefined,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function fileSnapshot(path) {
  try {
    const info = await stat(path);
    const bytes = Number(info.size);
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    return { path, exists: true, bytes, sha256: digest, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error && error.code === "ENOENT") return { path, exists: false };
    throw error;
  }
}

export async function readExactLines(path) {
  const text = await readFile(path, "utf8");
  return text.replace(/\n$/u, "").split("\n");
}

export async function piPidsForDaemon(daemonPid) {
  const rows = await listPiProcesses(daemonPid);
  return rows.map((row) => row.pid);
}

export async function anyPidAlive(pids) {
  for (const pid of pids) {
    if (await processExists(pid)) return true;
  }
  return false;
}

export function parseConnectCode(bootstrapCommand) {
  const match = /(?:computer )?connect --server\s+'?([^\s']+)'?\s+--\s+'?([A-Za-z0-9_.-]+)'?/.exec(bootstrapCommand);
  if (!match) throw new Error(`Could not parse connect code from bootstrap command`);
  return { serverUrl: match[1], code: match[2] };
}

export function basenameSafe(path) {
  return basename(path);
}
