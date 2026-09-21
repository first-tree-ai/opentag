import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerScriptArgv, requireOption } from "../runner/args.mjs";
import { downloadVerified, sha256Buffer } from "../runner/install-tools.mjs";

test("build CLI arguments fail closed on missing values", () => {
  assert.equal(parseRunnerScriptArgv([]).ok, false);
  assert.equal(parseRunnerScriptArgv(["build", "--channel"]).ok, false);
  const parsed = parseRunnerScriptArgv(["build", "--channel", "staging", "--version", "0.0.6-staging.1.1"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options.channel, "staging");
  assert.equal(requireOption(parsed.options, "version"), "0.0.6-staging.1.1");
  assert.throws(() => requireOption({}, "version"), /--version is required/);
});

test("verified downloads reject size and digest mismatches without network", async () => {
  const payload = Buffer.from("hello");
  const sha256 = sha256Buffer(payload);
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => payload });
  await assert.rejects(
    () => downloadVerified({ url: "https://example.invalid/x", sha256, bytes: 4, fetchImpl }),
    /size mismatch|exceeds the reviewed size bound/,
  );
  await assert.rejects(
    () =>
      downloadVerified({
        url: "https://example.invalid/x",
        sha256: "0".repeat(64),
        bytes: payload.length,
        fetchImpl,
      }),
    /sha256 mismatch/,
  );
  const ok = await downloadVerified({ url: "https://example.invalid/x", sha256, bytes: payload.length, fetchImpl });
  assert.equal(Buffer.compare(ok, payload), 0);
});
