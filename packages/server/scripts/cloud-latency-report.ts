import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CloudLatencyRecord, CloudLatencyRecordSchema } from "@opentag/shared";
import { z } from "zod";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10000;
const piPhase = z.enum([
  "worker_startup",
  "worker_preparation",
  "pi_spawn",
  "get_state",
  "session_restore",
  "prompt_acceptance",
  "await_terminal",
  "cleanup",
]);
const piEnd = z.object({
  module: z.literal("cloud-pi"),
  operation: z.literal("pi.diagnostic"),
  sessionId: z.string().uuid(),
  sandboxId: z.string().uuid(),
  environmentGeneration: z.number().int().nonnegative(),
  turnId: z.string().uuid(),
  phase: piPhase,
  event: z.literal("end"),
  seq: z.number().int().positive().optional(),
  durationMs: z.number().finite().nonnegative(),
  piProcessSpawnMs: z.number().finite().nonnegative().optional(),
  mcpGatewayLoadMs: z.number().finite().nonnegative().optional(),
  mcpGatewaySessionStartMs: z.number().finite().nonnegative().optional(),
});
const piFirstTurn = piEnd.omit({ durationMs: true }).extend({
  event: z.literal("milestone"),
  milestone: z.literal("first_turn_start"),
  receivedElapsedMs: z.number().finite().nonnegative(),
  promptAckToFirstTurnMs: z.number().finite().nonnegative().optional(),
});
const optionsSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  expectedTurns: z.number().int().positive().max(10000),
  cohort: z.enum(["cold", "warm", "restored", "mcp", "scheduled", "concurrent", "mixed"]),
  sessions: z.array(z.string().uuid()).min(1).max(16),
});
export type LatencyReportOptions = z.infer<typeof optionsSchema>;
type Payload = Record<string, unknown>;
type Trace = {
  first: CloudLatencyRecord;
  seq: number;
  lastElapsedMs: number;
  incomplete: boolean;
  summary?: CloudLatencyRecord;
  open: Map<string, CloudLatencyRecord>;
  totals: Map<string, number>;
  failed: Set<string>;
};

function object(value: unknown): Payload | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : undefined;
}

function unwrap(value: unknown): { payload: Payload; timestamp: unknown } | undefined {
  const outer = object(value);
  if (!outer) return;
  const payload = object(outer.jsonPayload) ?? outer;
  if (typeof payload.log === "string") {
    try {
      return { payload: object(JSON.parse(payload.log)) ?? {}, timestamp: outer.timestamp ?? outer.time };
    } catch {
      return;
    }
  }
  return { payload, timestamp: outer.timestamp ?? outer.time ?? payload.utc ?? payload.timestamp };
}

function rows(input: string): unknown[] {
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error("Input exceeds the 16 MiB memory bound");
  let result: unknown[];
  if (input.trimStart().startsWith("[")) {
    const value: unknown = JSON.parse(input);
    if (!Array.isArray(value)) throw new Error("Expected an export array");
    result = value;
  } else {
    result = input
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      });
  }
  if (result.length > MAX_ROWS) throw new Error("Input exceeds the 10,000-record bound");
  return result;
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const rank = (q: number, minimum: number) =>
    values.length >= minimum ? values[Math.ceil(values.length * q) - 1] : null;
  return { n: values.length, p50: rank(0.5, 1), p90: rank(0.9, 100), p95: rank(0.95, 100), p99: rank(0.99, 1000) };
}

function consume(trace: Trace, record: CloudLatencyRecord): void {
  if (record.seq !== trace.seq + 1 || record.elapsedMs < trace.lastElapsedMs) trace.incomplete = true;
  trace.seq = record.seq;
  trace.lastElapsedMs = record.elapsedMs;
  if (record.diagnosticIncomplete) trace.incomplete = true;
  if (record.event === "summary") {
    if (trace.summary) trace.incomplete = true;
    trace.summary = record;
    return;
  }
  const phase = record.phase;
  if (!phase) {
    trace.incomplete = true;
    return;
  }
  if (record.event === "start") {
    if (trace.open.has(phase)) trace.incomplete = true;
    trace.open.set(phase, record);
    return;
  }
  const start = trace.open.get(phase);
  if (!start || record.elapsedMs < start.elapsedMs || record.durationMs > record.elapsedMs - start.elapsedMs + 1) {
    trace.incomplete = true;
    return;
  }
  trace.open.delete(phase);
  if (record.event === "failure") trace.failed.add(phase);
  else trace.totals.set(phase, (trace.totals.get(phase) ?? 0) + record.durationMs);
}

const allocationKey = (value: { sessionId: string; sandboxId?: string; environmentGeneration?: number }) =>
  `${value.sessionId}/${value.sandboxId ?? "unobserved"}/${value.environmentGeneration ?? "unobserved"}`;

type State = {
  traces: Map<string, Trace>;
  turnAllocations: Map<string, Set<string>>;
  piRecords: { turnId: string; metric: string; value: number }[];
  piSeen: Set<string>;
  malformed: number;
  ignored: number;
  invalid: number;
  duplicatePi: number;
};

function noteTurn(state: State, turnId: string, scope: string): void {
  const allocations = state.turnAllocations.get(turnId) ?? new Set<string>();
  allocations.add(scope);
  state.turnAllocations.set(turnId, allocations);
}

function consumePi(state: State, payload: Payload, timestamp: number): void {
  const parsed = (payload.event === "milestone" ? piFirstTurn : piEnd).safeParse(payload);
  if (!parsed.success) {
    if (payload.event === "end" || payload.event === "milestone") state.invalid++;
    return;
  }
  const record = parsed.data;
  const scope = allocationKey(record);
  const identity = record.event === "milestone" ? record.milestone : `${record.phase}/${record.seq ?? "parent"}`;
  const key = `${scope}/${record.turnId}/${identity}`;
  if (state.piSeen.has(key)) {
    state.duplicatePi++;
    return;
  }
  state.piSeen.add(key);
  noteTurn(state, record.turnId, scope);
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const metrics =
    record.event === "milestone"
      ? {
          native_exec_to_first_turn_observed: record.receivedElapsedMs,
          prompt_ack_to_first_turn: record.promptAckToFirstTurnMs,
        }
      : {
          [record.phase]: record.durationMs,
          ...(record.phase === "get_state"
            ? {
                pi_process_spawn: record.piProcessSpawnMs,
                mcp_gateway_load: record.mcpGatewayLoadMs,
                mcp_gateway_session_start: record.mcpGatewaySessionStartMs,
              }
            : {}),
        };
  for (const [metric, value] of Object.entries(metrics)) {
    if (value !== undefined) state.piRecords.push({ turnId: record.turnId, metric: `pi/${day}/${metric}`, value });
  }
}

function consumeLatency(state: State, payload: Payload): void {
  const fields = Object.fromEntries(Object.keys(CloudLatencyRecordSchema.shape).map((key) => [key, payload[key]]));
  const parsed = CloudLatencyRecordSchema.safeParse({ ...fields, module: "cloud-latency" });
  if (!parsed.success) {
    state.invalid++;
    return;
  }
  const record = parsed.data;
  if (record.turnId) noteTurn(state, record.turnId, allocationKey(record));
  const key = `${record.clockId}/${allocationKey(record)}/${record.turnId ?? record.deliveryId ?? "allocation"}/${record.attempt ?? "turn"}`;
  const trace: Trace = state.traces.get(key) ?? {
    first: record,
    lastElapsedMs: 0,
    seq: 0,
    incomplete: false,
    open: new Map(),
    totals: new Map(),
    failed: new Set(),
  };
  consume(trace, record);
  state.traces.set(key, trace);
}

function consumeRow(state: State, row: unknown, options: LatencyReportOptions): void {
  const entry = unwrap(row);
  if (!entry) {
    state.malformed++;
    return;
  }
  const payload = entry.payload;
  if (payload.operation !== "cloud.latency" && payload.module !== "cloud-pi") {
    state.ignored++;
    return;
  }
  if (payload.environment !== undefined && payload.environment !== "staging") {
    state.invalid++;
    return;
  }
  if (typeof payload.sessionId !== "string" || !options.sessions.includes(payload.sessionId)) {
    state.ignored++;
    return;
  }
  const timestamp = Date.parse(String(payload.utc ?? entry.timestamp));
  if (!Number.isFinite(timestamp)) {
    state.invalid++;
    return;
  }
  if (timestamp < Date.parse(options.from) || timestamp >= Date.parse(options.to)) {
    state.ignored++;
    return;
  }
  if (payload.module === "cloud-pi") consumePi(state, payload, timestamp);
  else consumeLatency(state, payload);
}

type Groups = { metrics: Map<string, number[]>; outcomes: Map<string, Set<string>>; incomplete: number };
function addMetric(groups: Groups, name: string, value: number): void {
  const values = groups.metrics.get(name) ?? [];
  values.push(value);
  groups.metrics.set(name, values);
}

function collectTrace(groups: Groups, trace: Trace, conflicts: ReadonlySet<string>): void {
  const first = trace.first;
  const complete =
    !trace.incomplete && trace.open.size === 0 && trace.summary !== undefined && !conflicts.has(first.turnId ?? "");
  if (!complete) {
    groups.incomplete++;
    return;
  }
  const prefix = `${first.service}/${first.revision}/${first.utc.slice(0, 10)}`;
  for (const [phase, duration] of trace.totals) addMetric(groups, `${prefix}/${phase}`, duration);
  if (!first.turnId || first.service !== "opentag-runner" || !trace.totals.has("report_ack")) return;
  const outcomes = groups.outcomes.get(first.turnId) ?? new Set<string>();
  outcomes.add(trace.summary?.outcome ?? "incomplete");
  groups.outcomes.set(first.turnId, outcomes);
  if (trace.summary?.outcome === "completed" && trace.totals.has("worker_execution")) {
    addMetric(groups, `${prefix}/worker_observation_to_ack`, trace.summary.durationMs);
  }
}

function reportGroups(state: State, conflicts: ReadonlySet<string>): Groups {
  const groups: Groups = { metrics: new Map(), outcomes: new Map(), incomplete: 0 };
  for (const trace of state.traces.values()) collectTrace(groups, trace, conflicts);
  for (const record of state.piRecords) {
    if (!conflicts.has(record.turnId)) addMetric(groups, record.metric, record.value);
  }
  return groups;
}

export function aggregateLatency(input: string, rawOptions: LatencyReportOptions) {
  const options = optionsSchema.parse(rawOptions);
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  if (to <= from || to - from > 24 * 60 * 60 * 1000) throw new Error("Window must be positive and at most 24 hours");
  const state: State = {
    traces: new Map(),
    turnAllocations: new Map(),
    piRecords: [],
    piSeen: new Set(),
    malformed: 0,
    ignored: 0,
    invalid: 0,
    duplicatePi: 0,
  };
  for (const row of rows(input)) consumeRow(state, row, options);
  if (state.turnAllocations.size > options.expectedTurns)
    throw new Error("Observed Turns exceed the declared population");
  const conflicts = new Set([...state.turnAllocations].filter(([, scopes]) => scopes.size > 1).map(([id]) => id));
  const groups = reportGroups(state, conflicts);
  const outcomes = [...groups.outcomes.values()].filter((values) => values.size === 1).map((values) => [...values][0]);
  const count = (outcome: string) => outcomes.filter((value) => value === outcome).length;
  const settled = ["completed", "failed", "cancelled", "unknown"].reduce((sum, value) => sum + count(value), 0);
  return {
    schemaVersion: 1,
    environment: "staging",
    cohort: options.cohort,
    from: options.from,
    to: options.to,
    inputScope: "caller-selected Staging export; resource controls are not independently verified",
    population: {
      declared: options.expectedTurns,
      observed: state.turnAllocations.size,
      completed: count("completed"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      unknown: count("unknown"),
      missing: options.expectedTurns - state.turnAllocations.size,
      unsettledOrIncomplete: state.turnAllocations.size - settled,
      timeout: null,
      timeoutRate: null,
    },
    evidence: {
      malformed: state.malformed,
      invalid: state.invalid,
      ignored: state.ignored,
      incompleteTraces: groups.incomplete,
      failedPhaseObservations: [...state.traces.values()].reduce((sum, trace) => sum + trace.failed.size, 0),
      duplicatePi: state.duplicatePi,
      allocationConflicts: conflicts.size,
      outcomeConflicts: [...groups.outcomes.values()].filter((values) => values.size > 1).length,
      unknownRevisionTraces: [...state.traces.values()].filter((trace) => trace.first.revision === "unknown").length,
    },
    endToEnd: {
      available: false,
      reason: "No joined ingress, outbound/client receipt or cross-process clock-error evidence",
    },
    timeoutEvidence: "No validated timeout classification; unavailable rather than inferred from missing records",
    metrics: Object.fromEntries([...groups.metrics].map(([key, values]) => [key, distribution(values)])),
  };
}

async function main(args: string[]) {
  const [from, to, count, cohort, ...sessions] = args;
  let bytes = 0;
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new Error("Input exceeds the 16 MiB memory bound");
    chunks.push(text);
  }
  const input = chunks.join("");
  const result = aggregateLatency(input, {
    from: from ?? "",
    to: to ?? "",
    expectedTurns: Number(count),
    cohort: optionsSchema.shape.cohort.parse(cohort),
    sessions,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Invalid or oversized Staging export. Expected: from-UTC to-UTC expected-turns cohort session-UUID [...]. No raw data was saved.",
    );
    process.exitCode = 1;
  });
}
