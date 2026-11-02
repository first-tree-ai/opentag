import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyInputLedger } from "../../testing/im-input-ledger/verify.mjs";

const input = (order, overrides = {}) => ({
  inputId: `source-revision-${order}`,
  agentId: "agent",
  sessionId: "session",
  streamId: "provider-conversation",
  contentHash: `content-${order}`,
  order,
  ...overrides,
});
const receipt = (entry) => ({ ...entry, boundary: "provider_input" });
const ledger = (accepted, received, overrides = {}) => ({
  environment: "synthetic",
  orderingBasis: "test sender's monotonic sequence before fault injection",
  accepted,
  received,
  ...overrides,
});

test("compares the complete ordered input set and tolerates duplicate acceptance observations", () => {
  const entries = [input(1), input(2)];
  assert.equal(verifyInputLedger(ledger([...entries, input(1)], entries.map(receipt))).ok, true);
});

test("rejects overtaking even if the older input is eventually delivered", () => {
  const result = verifyInputLedger(ledger([input(1), input(2)], [receipt(input(2)), receipt(input(1))]));
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["OUT_OF_ORDER"],
  );
});

test("does not let later receipt hide an undelivered predecessor", () => {
  const result = verifyInputLedger(ledger([input(1), input(2)], [receipt(input(2))]));
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["OUT_OF_ORDER", "MISSING_INPUT"],
  );
});

test("distinguishes transport observations from non-duplicate Provider input", () => {
  assert.throws(() => verifyInputLedger(ledger([input(1)], [{ ...input(1), boundary: "server_ack" }])));
  assert.deepEqual(
    verifyInputLedger(ledger([input(1)], [receipt(input(1)), receipt(input(1))])).findings.map((entry) => entry.code),
    ["DUPLICATE_PROVIDER_INPUT"],
  );
});

test("checks both Agent and Session targets and reports unknown input", () => {
  const result = verifyInputLedger(ledger([input(1)], [receipt(input(1, { sessionId: "other" })), receipt(input(2))]));
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["WRONG_TARGET", "UNKNOWN_INPUT", "MISSING_INPUT"],
  );
});

test("checks content identity and refuses an ambiguous order or identity", () => {
  assert.equal(
    verifyInputLedger(ledger([input(1)], [receipt(input(1, { contentHash: "changed" }))])).findings[0]?.code,
    "CONTENT_MISMATCH",
  );
  assert.equal(
    verifyInputLedger(ledger([input(1), input(1, { contentHash: "changed" })], [])).findings[0]?.code,
    "IDENTITY_CONFLICT",
  );
  assert.throws(() => verifyInputLedger(ledger([input(1), input(1, { inputId: "distinct" })], [])));
});

test("keeps explicitly independent streams independent and uncertainty visible", () => {
  const first = input(1);
  const other = input(1, { sessionId: "other", streamId: "independent-conversation" });
  assert.equal(verifyInputLedger(ledger([first, other], [receipt(other), receipt(first)])).ok, true);
  assert.equal(
    verifyInputLedger(ledger([first], [receipt(first)], { unresolved: [{ ...first, reason: "started_process_died" }] }))
      .ok,
    false,
  );
});

test("does not silently split one ordered stream when its Session changes", () => {
  const first = input(1);
  const second = input(2, { sessionId: "replacement-session" });
  const result = verifyInputLedger(ledger([first, second], [receipt(second), receipt(first)]));
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["OUT_OF_ORDER"],
  );
});

test("requires an explicit evidence environment and ordering authority", () => {
  assert.throws(() => verifyInputLedger(ledger([], [], { orderingBasis: undefined })));
  assert.throws(() => verifyInputLedger(ledger([input(1, { inputId: "" })], [])));
  assert.throws(() => verifyInputLedger(ledger([], [])));
});
