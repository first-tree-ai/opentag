import assert from "node:assert/strict";
import test from "node:test";
import { cleanupAllocations, finalizeRun } from "../e2e/cloud-runner/run.mjs";

test("finalizeRun persists the successful terminal outcome before returning", async () => {
  const summary = { assertions: [], outcome: "failed" };
  let persisted;
  await finalizeRun({
    allocations: [],
    assertions: summary.assertions,
    fixture: { cleanup: async () => [] },
    summary,
    receipt: async () => {
      persisted = structuredClone(summary);
    },
  });
  assert.equal(summary.outcome, "passed");
  assert.equal(persisted.outcome, "passed");
  assert.equal(persisted.finishedAt, summary.finishedAt);
});

const shared = {
  accountSandboxRunnerPath: (sandboxId) => `/runner/${sandboxId}`,
  accountSandboxRunnerStopPath: (sandboxId) => `/runner/${sandboxId}/stop`,
};

test("cleanupAllocations attempts every allocation when the first one fails and records both", async () => {
  const calls = [];
  let receipts = 0;
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (path === "/runner/A") throw new Error("allocation A is gone");
    if (method === "GET")
      return { currentResourceName: "resource-B", currentResourceUid: "uid-B", environmentGeneration: 3 };
    assert.deepEqual(body, { environmentGeneration: 3 }, "cleanup targets the allocation just observed");
    return { lifecycle: "unallocated", currentResourceName: null };
  };
  const allocations = [
    { sandboxId: "A", sessionId: "sessionA", cleanup: "pending" },
    { sandboxId: "B", sessionId: "sessionB", cleanup: "pending" },
  ];
  const assertions = [];
  await cleanupAllocations({
    api,
    allocations,
    shared,
    receipt: async () => {
      receipts += 1;
    },
    assertions,
    sleepFn: async () => {},
  });
  assert.deepEqual(calls, ["GET /runner/A", "GET /runner/A", "GET /runner/A", "GET /runner/B", "POST /runner/B/stop"]);
  assert.equal(allocations[0].cleanup, "unverified");
  assert.equal(allocations[0].cleanupError, "allocation A is gone");
  assert.equal(allocations[1].cleanup, "verified-removed");
  assert.equal(allocations[1].resourceUid, "uid-B");
  assert.equal(receipts, 1);
  assert.deepEqual(assertions, [
    { name: "sessionA-cloud-removed", ok: false, detail: "allocation A is gone" },
    { name: "sessionB-cloud-removed", ok: true, detail: "" },
  ]);
});

test("cleanupAllocations survives a throwing receipt and still removes the allocation", async () => {
  const api = async (method) => {
    if (method === "GET")
      return { currentResourceName: "resource-A", currentResourceUid: "uid-A", environmentGeneration: 1 };
    return { lifecycle: "unallocated", currentResourceName: null };
  };
  const allocations = [{ sandboxId: "A", sessionId: "sessionA", cleanup: "pending" }];
  await cleanupAllocations({
    api,
    allocations,
    shared,
    receipt: async () => {
      throw new Error("artifact write failed");
    },
    assertions: [],
  });
  assert.equal(allocations[0].cleanup, "verified-removed");
  assert.equal(allocations[0].receiptError, true);
});

test("finalizeRun attempts fixture teardown and the final receipt when config verification throws", async () => {
  const phases = [];
  const summary = { assertions: [], outcome: "failed" };
  const result = await finalizeRun({
    allocations: [],
    shared,
    receipt: async () => {
      phases.push("receipt");
    },
    assertions: summary.assertions,
    piInput: {
      verifyUnchanged: async () => {
        phases.push("verify");
        throw new Error("config read failed");
      },
    },
    fixture: {
      cleanup: async () => {
        phases.push("fixture");
        return [];
      },
    },
    summary,
  });
  assert.equal(result, summary);
  assert.deepEqual(phases, ["verify", "fixture", "receipt"]);
  assert.equal(summary.artifactError, undefined);
  assert.equal(summary.outcome, "failed");
  assert.deepEqual(
    summary.assertions.find((assertion) => assertion.name === "host-pi-config-unchanged"),
    { name: "host-pi-config-unchanged", ok: false, detail: "config read failed" },
  );
  assert.deepEqual(
    summary.assertions.find((assertion) => assertion.name === "fixture-cleanup"),
    { name: "fixture-cleanup", ok: true, detail: "" },
  );
});

test("finalizeRun keeps a false config verification fail-closed while still cleaning the fixture", async () => {
  const summary = { assertions: [], outcome: "failed" };
  let fixtureCleaned = false;
  let receipts = 0;
  await finalizeRun({
    allocations: [],
    shared,
    receipt: async () => {
      receipts += 1;
    },
    assertions: summary.assertions,
    piInput: { verifyUnchanged: async () => false },
    fixture: {
      cleanup: async () => {
        fixtureCleaned = true;
        return [];
      },
    },
    summary,
  });
  assert.equal(fixtureCleaned, true);
  assert.equal(receipts, 1);
  assert.equal(summary.outcome, "failed");
  assert.deepEqual(
    summary.assertions.find((assertion) => assertion.name === "host-pi-config-unchanged"),
    { name: "host-pi-config-unchanged", ok: false, detail: "" },
  );
});

test("finalizeRun records a failing receipt and a throwing fixture cleanup without aborting either", async () => {
  const summary = { assertions: [], outcome: "failed" };
  let receipts = 0;
  const result = await finalizeRun({
    allocations: [],
    shared,
    receipt: async () => {
      receipts += 1;
      throw new Error("artifact write failed");
    },
    assertions: summary.assertions,
    fixture: {
      cleanup: async () => {
        throw new Error("fixture cleanup exploded");
      },
    },
    summary,
  });
  assert.equal(receipts, 1);
  assert.equal(result.artifactError, true);
  assert.equal(summary.outcome, "failed");
  assert.deepEqual(
    summary.assertions.find((assertion) => assertion.name === "fixture-cleanup"),
    { name: "fixture-cleanup", ok: false, detail: "fixture cleanup exploded" },
  );
});

test("finalizeRun attempts every allocation, the fixture and the final receipt when cleanup and receipt fail", async () => {
  const summary = { assertions: [], outcome: "failed" };
  const calls = [];
  let receipts = 0;
  let fixtureCleaned = false;
  const api = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path === "/runner/A") throw new Error("allocation A is gone");
    if (method === "GET")
      return { currentResourceName: "resource-B", currentResourceUid: "uid-B", environmentGeneration: 2 };
    return { lifecycle: "unallocated", currentResourceName: null };
  };
  const allocations = [
    { sandboxId: "A", sessionId: "sessionA", cleanup: "pending" },
    { sandboxId: "B", sessionId: "sessionB", cleanup: "pending" },
  ];
  const result = await finalizeRun({
    api,
    allocations,
    shared,
    receipt: async () => {
      receipts += 1;
      throw new Error("artifact write failed");
    },
    assertions: summary.assertions,
    fixture: {
      cleanup: async () => {
        fixtureCleaned = true;
        return [];
      },
    },
    summary,
    sleepFn: async () => {},
  });
  assert.equal(result.artifactError, true);
  assert.equal(summary.outcome, "failed");
  assert.equal(fixtureCleaned, true);
  assert.equal(allocations[0].cleanup, "unverified");
  assert.equal(allocations[1].cleanup, "verified-removed");
  // A is retried three times; B gets one GET, one receipt attempt, and the stop POST.
  assert.deepEqual(calls, ["GET /runner/A", "GET /runner/A", "GET /runner/A", "GET /runner/B", "POST /runner/B/stop"]);
  assert.equal(receipts, 2);
  assert.deepEqual(
    summary.assertions.map((assertion) => [assertion.name, assertion.ok]),
    [
      ["sessionA-cloud-removed", false],
      ["sessionB-cloud-removed", true],
      ["fixture-cleanup", true],
    ],
  );
});

test("finalizeRun reports fixture cleanup failures and still writes the receipt", async () => {
  const summary = { assertions: [], outcome: "failed" };
  let receipts = 0;
  await finalizeRun({
    allocations: [],
    shared,
    receipt: async () => {
      receipts += 1;
    },
    assertions: summary.assertions,
    fixture: { cleanup: async () => ["postgres stop failed"] },
    summary,
  });
  assert.equal(receipts, 1);
  assert.equal(summary.outcome, "failed");
  assert.deepEqual(
    summary.assertions.find((assertion) => assertion.name === "fixture-cleanup"),
    { name: "fixture-cleanup", ok: false, detail: "postgres stop failed" },
  );
});
