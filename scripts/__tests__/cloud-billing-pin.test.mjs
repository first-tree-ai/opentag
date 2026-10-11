import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBillingRevision } from "../cloud-billing-pin.mjs";

test("billing pins require one exact commit SHA", (t) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "opentag-billing-pin-"));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const write = (value) => writeFileSync(join(repositoryRoot, "cloud-billing.json"), JSON.stringify(value));
  for (const value of [null, {}, { revision: "main" }, { revision: "a".repeat(40), extra: true }]) {
    write(value);
    assert.throws(() => readBillingRevision({ repositoryRoot }));
  }
  write({ revision: "a".repeat(40) });
  assert.equal(readBillingRevision({ repositoryRoot }), "a".repeat(40));
  assert.throws(() => readBillingRevision({ repositoryRoot, serverRevision: "main:other.json" }));
});

test("rollback selects the billing pin recorded in the target application commit", (t) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "opentag-billing-rollback-"));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const pinPath = join(repositoryRoot, "cloud-billing.json");
  writeFileSync(pinPath, JSON.stringify({ revision: "a".repeat(40) }));
  git("add", ".");
  git("commit", "-m", "first");
  const serverRevision = git("rev-parse", "HEAD").trim();
  writeFileSync(pinPath, JSON.stringify({ revision: "b".repeat(40) }));
  git("add", ".");
  git("commit", "-m", "second");
  assert.equal(readBillingRevision({ repositoryRoot }), "b".repeat(40));
  assert.equal(readBillingRevision({ repositoryRoot, serverRevision }), "a".repeat(40));
});
