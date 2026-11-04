import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../apps/cli/dist/cli/index.mjs", import.meta.url));
test("built CLI submits proof-backed continuations through the current entry", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-cli-acceptance-"));
  const home = join(root, "custom home's directory");
  const staleBin = join(root, "old global bin");
  const proofFile = join(root, "proof.json");
  const markerFile = join(root, "execution.env");
  const sessionId = randomUUID();
  const proof = "p".repeat(40);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: request.url, headers: request.headers, input });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "accepted", messageId: input.messageId, sessionId }));
  });

  try {
    await readFile(cli);
    await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
    await mkdir(staleBin);
    await writeFile(join(staleBin, "opentag-dev"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    await writeFile(proofFile, JSON.stringify({ proofId: randomUUID(), token: proof }), { mode: 0o600 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const serverUrl = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      join(home, "config/computer.json"),
      JSON.stringify({ version: 2, computerId: randomUUID(), serverUrl }),
      { mode: 0o600 },
    );
    const environment = {
      HOME: home,
      PATH: staleBin,
      OPENTAG_HOME: home,
      OPENTAG_SERVER_URL: serverUrl,
      OPENTAG_SESSION_PROOF_FILE: proofFile,
      OPENTAG_PROVIDER_ENV_FILE: markerFile,
      OPENTAG_EXECUTION_ID: randomUUID(),
    };
    const currentMarkers = [randomUUID(), randomUUID()];
    const entry = join(root, "installation's CLI entry.mjs");
    await symlink(cli, entry);
    for (const executionId of currentMarkers) {
      await writeFile(markerFile, `# opentag-execution: ${executionId}\nexport OPENTAG_EXECUTION_ID=${executionId}\n`, {
        mode: 0o600,
      });
      const result = await execute(
        process.execPath,
        [entry, "session", "send", sessionId, "--message", "local continuation", "--json"],
        { env: environment, timeout: 15_000 },
      );
      assert.equal(JSON.parse(result.stdout).status, "accepted");
      assert.equal(requests.at(-1).headers["x-opentag-execution-id"], executionId);
    }
    await rm(markerFile);
    await execute(process.execPath, [entry, "session", "send", sessionId, "--message", "legacy", "--json"], {
      env: environment,
      timeout: 15_000,
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].headers["x-opentag-execution-id"], undefined);
    for (const request of requests) {
      assert.equal(request.headers["x-opentag-session-proof"], proof);
      assert.equal(request.input.targetSessionId, sessionId);
    }
    console.log(
      JSON.stringify({
        result: "PASS",
        nativeCliSubmissions: requests.length,
        executionMarkerRotations: currentMarkers.length,
        missingMarkerDoesNotReuseInheritedId: true,
        stalePathCliUsed: false,
        customHomeAndQuotedEntry: true,
        scope: "Built CLI and loopback transport only; no provider, real account, daemon service, or GitHub operation.",
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
