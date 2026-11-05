import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { downloadVerified, sha256Buffer } from "../runner/install-tools.mjs";

const payload = Buffer.from("reviewed artifact");
const options = {
  url: "https://releases.example.test/gh.tar.gz",
  bytes: payload.length,
  sha256: sha256Buffer(payload),
};
const flush = () => setImmediate();

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`verified GET recovers HTTP ${status} after backoff and discards its body`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let calls = 0;
    let cancelled = false;
    const fetchImpl = async () =>
      ++calls === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          )
        : new Response(payload);
    const outcome = downloadVerified({ ...options, fetchImpl }).catch((error) => error);
    await flush();
    t.mock.timers.tick(4_999);
    await flush();
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    t.mock.timers.tick(1);
    assert.deepEqual(await outcome, payload);
    assert.equal(calls, 2);
  });
}

test("verified GET exhausts four attempts with bounded exponential backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const times = [];
  const outcome = downloadVerified({
    ...options,
    fetchImpl: async () => {
      times.push(Date.now());
      return new Response(null, { status: 504 });
    },
  }).catch((error) => error);
  for (const delay of [5_000, 10_000, 20_000]) {
    await flush();
    t.mock.timers.tick(delay);
  }
  assert.match((await outcome).message, /504/);
  assert.deepEqual(times, [0, 5_000, 15_000, 35_000]);
});

for (const status of [400, 401, 403, 404, 501]) {
  test(`verified GET does not retry permanent HTTP ${status}`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadVerified({
        ...options,
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status });
        },
      }),
      new RegExp(String(status)),
    );
    assert.equal(calls, 1);
  });
}

for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EAI_AGAIN"]) {
  test(`verified GET recovers ${code}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let calls = 0;
    const outcome = downloadVerified({
      ...options,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
        return new Response(payload);
      },
    }).catch((error) => error);
    await flush();
    t.mock.timers.tick(5_000);
    assert.deepEqual(await outcome, payload);
    assert.equal(calls, 2);
  });
}

for (const code of ["CERT_HAS_EXPIRED", "ENOTFOUND", "UNKNOWN"]) {
  test(`verified GET fails immediately for ${code}`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadVerified({
        ...options,
        fetchImpl: async () => {
          calls += 1;
          throw Object.assign(new Error(code), { code });
        },
      }),
      new RegExp(code),
    );
    assert.equal(calls, 1);
  });
}

test("verified GET cancellation interrupts retry waits and preserves the reason", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error("cancel build");
  const outcome = downloadVerified({
    ...options,
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 504 });
    },
  }).catch((error) => error);
  await flush();
  controller.abort(reason);
  assert.equal(await outcome, reason);
  t.mock.timers.tick(120_000);
  assert.equal(calls, 1);
});

test("verified GET has one deadline including retry waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const outcome = downloadVerified({
    ...options,
    timeoutMs: 6_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 504 });
    },
  }).catch((error) => error);
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal((await outcome).name, "TimeoutError");
  assert.equal(calls, 2);
});

test("verified GET aborts a stalled body at the overall deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let cancelled = false;
  const outcome = downloadVerified({
    ...options,
    timeoutMs: 1_000,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  }).catch((error) => error);
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal((await outcome).name, "TimeoutError");
  assert.equal(cancelled, true);
});

for (const [name, body, expected] of [
  ["corrupt", Buffer.from("x".repeat(payload.length)), /sha256 mismatch/],
  ["oversized", Buffer.alloc(payload.length + 1), /size bound/],
  ["truncated", payload.subarray(1), /size mismatch/],
]) {
  test(`verified GET does not retry ${name} artifacts`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadVerified({
        ...options,
        fetchImpl: async () => {
          calls += 1;
          return new Response(body);
        },
      }),
      expected,
    );
    assert.equal(calls, 1);
  });
}

test("an injected bounded fetcher owns retries without an outer retry loop", async () => {
  let calls = 0;
  await assert.rejects(
    downloadVerified({
      ...options,
      fetcher: async () => {
        calls += 1;
        throw new Error("HTTP 504");
      },
    }),
    /504/,
  );
  assert.equal(calls, 1);
});

test("verified GET deadline aborts a request waiting for headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let aborted = false;
  const outcome = downloadVerified({
    ...options,
    timeoutMs: 1_000,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  }).catch((error) => error);
  t.mock.timers.tick(1_000);
  assert.equal((await outcome).name, "TimeoutError");
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test("verified GET keeps digest verification after a recovered 504", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const outcome = downloadVerified({
    ...options,
    fetchImpl: async () =>
      ++calls === 1 ? new Response(null, { status: 504 }) : new Response(Buffer.alloc(payload.length)),
  }).catch((error) => error);
  await flush();
  t.mock.timers.tick(5_000);
  assert.match((await outcome).message, /sha256 mismatch/);
  assert.equal(calls, 2);
});
