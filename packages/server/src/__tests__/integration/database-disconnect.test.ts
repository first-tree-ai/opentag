import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresTestContainer } from "./postgres-test-container.js";

const child = fileURLToPath(new URL("./support/database-disconnect-child.ts", import.meta.url));

async function runChild(url: string, mode: string, continuation: string, path = child) {
  return await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ["--import", "tsx", path, mode, continuation], {
        env: { ...globalThis.process.env, OPENTAG_DISCONNECT_TEST_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      let stdout = "";
      let stderr = "";
      process.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      process.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      process.on("error", reject);
      process.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    },
  );
}

describe("database disconnect process survival", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("releases a long transaction's locks without taking readiness or the application pool down", async () => {
    const path = fileURLToPath(new URL("./support/database-lock-release-child.ts", import.meta.url));
    const result = await runChild(container.getConnectionUri(), "lock-release", "", path);
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ event: "lock-released-pool-and-readiness-recovered" });
  }, 20_000);

  for (const mode of ["active-kill", "idle-kill", "idle-timeout"]) {
    for (const continuation of ["query", "query-before-reuse", "commit", "rollback", "savepoint"]) {
      it(`${mode}: safely settles ${continuation} after the connection is reused`, async () => {
        const result = await runChild(container.getConnectionUri(), mode, continuation);
        expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
        expect(result.stderr).toBe("");
        const events = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events.map(({ event }) => event)).toEqual([
          "transaction-rejected",
          "callback-and-new-transaction-settled",
          "pool-and-readiness-recovered",
          "passed",
        ]);
      }, 25_000);
    }
  }
});
