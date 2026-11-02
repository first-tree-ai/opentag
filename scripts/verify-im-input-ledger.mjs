import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const key = (entry) => JSON.stringify([entry.inputId, entry.agentId, entry.sessionId]);

export function verifyInputLedger(ledger) {
  if (!ledger.orderingBasis || !["synthetic", "live"].includes(ledger.environment)) {
    throw new Error("Declare the ordering authority and the synthetic/live environment");
  }
  if (!Array.isArray(ledger.accepted) || ledger.accepted.length === 0 || !Array.isArray(ledger.received)) {
    throw new Error("An empty or malformed ledger cannot establish input-delivery acceptance");
  }
  const findings = [];
  const { accepted, streams } = indexAccepted(ledger.accepted, findings);
  const seen = checkReceived(ledger.received, accepted, streams, findings);
  for (const identity of accepted.keys()) {
    if (!seen.has(identity)) findings.push({ code: "MISSING_INPUT", identity });
  }
  for (const entry of ledger.unresolved ?? []) {
    findings.push({ code: "UNRESOLVED_OUTCOME", identity: key(entry), reason: entry.reason });
  }
  return {
    ok: findings.length === 0,
    environment: ledger.environment,
    orderingBasis: ledger.orderingBasis,
    accepted: accepted.size,
    received: seen.size,
    findings,
  };
}

function indexAccepted(entries, findings) {
  const accepted = new Map();
  const streams = new Map();
  for (const entry of entries) {
    if (
      ![entry.inputId, entry.agentId, entry.sessionId, entry.streamId, entry.contentHash].every(
        (value) => typeof value === "string" && value.length > 0,
      ) ||
      !Number.isSafeInteger(entry.order)
    ) {
      throw new Error("An accepted input requires stable identity, target, stream, content hash and order");
    }
    const identity = key(entry);
    const previous = accepted.get(identity);
    if (previous) {
      if (
        previous.contentHash !== entry.contentHash ||
        previous.order !== entry.order ||
        previous.streamId !== entry.streamId
      ) {
        findings.push({ code: "IDENTITY_CONFLICT", identity });
      }
      continue;
    }
    accepted.set(identity, entry);
    const streamKey = JSON.stringify([entry.agentId, entry.streamId]);
    const stream = streams.get(streamKey) ?? [];
    if (stream.some((input) => input.order === entry.order)) throw new Error("Stream order must be unambiguous");
    stream.push(entry);
    streams.set(streamKey, stream);
  }
  for (const stream of streams.values()) stream.sort((a, b) => a.order - b.order);
  return { accepted, streams };
}

function checkReceived(entries, accepted, streams, findings) {
  const seen = new Set();
  for (const entry of entries) {
    if (entry.boundary !== "provider_input") {
      throw new Error(
        "Only observed Provider input counts as receipt; Server ACK, claim and journal are earlier stages",
      );
    }
    const identity = key(entry);
    const input = accepted.get(identity);
    if (!input) {
      findings.push({
        code: [...accepted.values()].some((value) => value.inputId === entry.inputId)
          ? "WRONG_TARGET"
          : "UNKNOWN_INPUT",
        identity,
      });
      continue;
    }
    if (entry.contentHash !== input.contentHash) findings.push({ code: "CONTENT_MISMATCH", identity });
    if (seen.has(identity)) {
      findings.push({ code: "DUPLICATE_PROVIDER_INPUT", identity });
      continue;
    }
    const stream = streams.get(JSON.stringify([input.agentId, input.streamId]));
    const predecessor = stream.find((value) => value.order < input.order && !seen.has(key(value)));
    if (predecessor) findings.push({ code: "OUT_OF_ORDER", identity, blockedBy: key(predecessor) });
    seen.add(identity);
  }
  return seen;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyInputLedger(JSON.parse(readFileSync(process.argv[2], "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
