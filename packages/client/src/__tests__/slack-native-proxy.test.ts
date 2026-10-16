import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";

const binary = process.env.OPENTAG_TEST_SLACK_BINARY;
const run = promisify(execFile);
const handle = "otrh_native_slack_fixture";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ot-slack-native-"));
  const requests: { path: string; body: string }[] = [];
  const adapter = await RuntimeProxyLoopbackAdapter.start({
    executionId: randomUUID(),
    materialDir: root,
    verifyHandle: (provider, token) => provider === "slack" && token === handle,
    openStream: async (request) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.body) chunks.push(chunk);
      requests.push({ path: request.path, body: Buffer.concat(chunks).toString("utf8") });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" }));
        })(),
      };
    },
    logger: { debug() {}, warn() {} },
  });
  return { root, adapter, requests };
}

describe("execution-local Slack API authority", () => {
  it("authenticates the local handle and stops dispatching after close", async () => {
    const { root, adapter, requests } = await fixture();
    const url = `${adapter.slackApiHost}/api/auth.test`;
    const ca = await readFile(adapter.caCertPath);
    const request = (token?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpsRequest(
          url,
          { ca, method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      expect((await request()).status).toBe(401);
      expect((await request("wrong")).status).toBe(403);
      expect(requests).toHaveLength(0);
      const response = await request(handle);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, team_id: "T123" });
      expect(requests.map((request) => request.path)).toEqual(["/api/auth.test"]);
      await adapter.close();
      await expect(request(handle)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!binary)("native Slack CLI (offline, no provider credentials)", () => {
  it("runs identity validation and sends a message through the authenticated local entry", async () => {
    const { root, adapter, requests } = await fixture();
    const config = join(root, "config");
    await mkdir(config);
    try {
      const invoke = (args: string[], token = handle, trustPrivateCa = true) =>
        run(
          binary as string,
          ["--skip-update", "--no-color", "--config-dir", config, "--apihost", adapter.slackApiHost, "api", ...args],
          {
            cwd: root,
            env: {
              HOME: root,
              PATH: "/usr/bin:/bin",
              SLACK_BOT_TOKEN: token,
              ...(trustPrivateCa ? { SSL_CERT_FILE: adapter.caCertPath } : {}),
            },
            timeout: 15_000,
          },
        );
      await expect(invoke(["auth.test"], handle, false)).rejects.toBeDefined();
      expect(requests).toHaveLength(0);
      expect(JSON.parse((await invoke(["auth.test"])).stdout)).toMatchObject({ ok: true, user_id: "U123" });
      expect(JSON.parse((await invoke(["chat.postMessage", "channel=D123", "text=fixture"])).stdout)).toMatchObject({
        ok: true,
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.path).toBe("/api/chat.postMessage");
      expect(new URLSearchParams(requests[1]?.body).get("text")).toBe("fixture");
      expect(new URLSearchParams(requests[1]?.body).has("token")).toBe(false);
      await expect(invoke(["auth.test"], "otrh_wrong")).rejects.toBeDefined();
      expect(requests).toHaveLength(2);
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
