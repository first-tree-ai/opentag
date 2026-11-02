import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assembleClientRuntimeClosure } from "../../runner/runtime-closure.mjs";

const [before, after, destination] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(
  before && after && destination,
  "usage: node prepare.mjs <built-before-checkout> <built-after-checkout> <new-fixture-directory>",
);
mkdirSync(destination);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (checkout, args) => execFileSync("git", ["-C", checkout, ...args]);
const provenance = {};
for (const [version, checkout] of [
  ["before", before],
  ["after", after],
]) {
  const target = join(destination, version);
  mkdirSync(target);
  cpSync(join(checkout, "packages/client/dist"), join(target, "dist"), { recursive: true });
  assembleClientRuntimeClosure({
    clientManifestPath: join(checkout, "packages/client/package.json"),
    clientDistDir: join(target, "dist"),
    nodeModulesDir: join(target, "node_modules"),
  });
  writeFileSync(join(target, "package.json"), '{"type":"module","private":true}\n');
  const files = readdirSync(join(target, "dist"), { recursive: true })
    .filter((path) => path.endsWith(".mjs"))
    .sort();
  provenance[version] = {
    sourceSha: git(checkout, ["rev-parse", "HEAD"]).toString().trim(),
    sourceDirty: git(checkout, ["status", "--porcelain"]).byteLength > 0,
    trackedDiffSha256: hash(git(checkout, ["diff", "HEAD", "--", "packages/client", "packages/shared"])),
    modules: Object.fromEntries(files.map((path) => [path, hash(readFileSync(join(target, "dist", path)))])),
  };
}
const lock = readFileSync(join(after, "scripts/runner/pi/package-lock.json"));
assert.equal(
  hash(lock),
  hash(readFileSync(join(before, "scripts/runner/pi/package-lock.json"))),
  "Pi locks must match",
);
mkdirSync(join(destination, "pi"));
for (const file of ["package.json", "package-lock.json"]) {
  cpSync(join(after, "scripts/runner/pi", file), join(destination, "pi", file));
}
mkdirSync(join(destination, "tls"), { mode: 0o700 });
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    join(destination, "tls/key.pem"),
    "-out",
    join(destination, "tls/ca.pem"),
  ],
  { stdio: "ignore" },
);
const agentId = randomUUID();
const request = {
  kind: "turn",
  executionDir: "/run/opentag-execution/fixture",
  model: {
    baseUrl: "http://127.0.0.1:19999/v1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: "fixture-model",
    token: "fixture-only-no-real-credentials-0123456789",
    contextWindow: 64_000,
    maxTokens: 8192,
  },
  delivery: {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "Replaced per sample",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: "fixture",
        botOpenId: "fixture",
        chatId: "fixture",
        messageId: "fixture",
      },
    },
    runtime: {
      agentId,
      contextTrees: [],
      instructions: { agent: "Synthetic performance fixture.", platform: "Use no external tools." },
      provider: "pi",
      model: "fixture-model",
      revision: { agent: { id: randomUUID(), sequence: 1 }, session: { id: randomUUID(), sequence: 1 } },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
    },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  },
};
writeFileSync(join(destination, "request.json"), `${JSON.stringify(request)}\n`);
writeFileSync(join(destination, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(`${destination}\n`);
