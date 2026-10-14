import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  status: 200 as number | undefined,
  error: false,
  options: {} as Record<string, unknown>,
  destroyed: vi.fn(),
  responseDestroyed: vi.fn(),
  request: vi.fn(),
}));
vi.mock("node:https", () => ({
  Agent: class {
    constructor(options: unknown) {
      http.options = options as Record<string, unknown>;
    }
    destroy() {
      http.destroyed();
    }
  },
  request: (...args: unknown[]) => {
    http.request(...args);
    const connection = new EventEmitter() as EventEmitter & { end(): void };
    connection.end = () =>
      queueMicrotask(() => {
        if (http.error) connection.emit("error", new Error("synthetic network failure"));
        else (args[2] as (response: unknown) => void)({ statusCode: http.status, destroy: http.responseDestroyed });
      });
    return connection;
  },
}));

import { probeClaudeEnvironmentCredential } from "../providers/claude-code/credential-probe.js";

afterEach(() => {
  vi.clearAllMocks();
  http.status = 200;
  http.error = false;
});

describe("Claude explicit credential validation", () => {
  it.each([
    {},
    { CLAUDE_CODE_OAUTH_TOKEN: "token", ANTHROPIC_BASE_URL: "https://gateway.example.com" },
    ...["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].map((key) => ({
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      [key]: "1",
    })),
  ])("leaves native storage, cloud providers and gateways to the native CLI", async (environment) => {
    await expect(probeClaudeEnvironmentCredential(environment)).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each([" token", "token ", "token\nnext", "token\rnext"])(
    "rejects malformed credentials before any request",
    async (token) => {
      await expect(probeClaudeEnvironmentCredential({ CLAUDE_CODE_OAUTH_TOKEN: token })).resolves.toMatchObject({
        code: "credential_missing",
      });
      expect(http.request).not.toHaveBeenCalled();
    },
  );

  it("checks OAuth against the fixed Anthropic models endpoint without a generation body", async () => {
    const environment = {
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com/",
      HTTPS_PROXY: "http://localhost:8080",
    };
    const signal = new AbortController().signal;
    await expect(probeClaudeEnvironmentCredential(environment, signal)).resolves.toBeUndefined();
    expect(http.request).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer synthetic-oauth",
          "anthropic-beta": "oauth-2025-04-20",
        }),
        signal: expect.any(AbortSignal),
      }),
      expect.any(Function),
    );
    expect(http.options.proxyEnv).toBe(environment);
    expect(http.responseDestroyed).toHaveBeenCalledOnce();
    expect(http.destroyed).toHaveBeenCalledOnce();
  });

  it.each([
    {
      ANTHROPIC_API_KEY: "synthetic-api",
      CLAUDE_CODE_OAUTH_TOKEN: "ignored",
      header: "x-api-key",
      expected: "synthetic-api",
    },
    {
      ANTHROPIC_AUTH_TOKEN: "synthetic-bearer",
      ANTHROPIC_API_KEY: "ignored",
      CLAUDE_CODE_OAUTH_TOKEN: "ignored",
      header: "Authorization",
      expected: "Bearer synthetic-bearer",
    },
  ])("uses the selected credential's precedence and header", async ({ header, expected, ...environment }) => {
    await expect(probeClaudeEnvironmentCredential(environment)).resolves.toBeUndefined();
    expect(http.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ [header]: expected }) }),
      expect.any(Function),
    );
    const headers = (http.request.mock.calls[0]?.[1] as { headers: Record<string, string> } | undefined)?.headers;
    expect(headers).not.toHaveProperty("anthropic-beta");
  });

  it("reports rejected credentials without leaking their value", async () => {
    http.status = 401;
    const result = await probeClaudeEnvironmentCredential({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic-secret" });
    expect(result).toMatchObject({ code: "credential_missing" });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it.each(["https://api.anthropic.com:443/", "https://API.ANTHROPIC.COM/"])(
    "verifies credentials for the equivalent default URL %s",
    async (url) => {
      http.status = 401;
      await expect(
        probeClaudeEnvironmentCredential({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "synthetic-invalid" }),
      ).resolves.toMatchObject({ code: "credential_missing" });
      expect(http.request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "invalid URL",
    "https://api.anthropic.com/custom",
    "https://api.anthropic.com/?gateway=1",
    "https://api.anthropic.com/#custom",
    "https://user@api.anthropic.com",
    "https://:password@api.anthropic.com",
    "http://api.anthropic.com",
  ])("leaves non-default URLs to the CLI: %s", async (url) => {
    await expect(
      probeClaudeEnvironmentCredential({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "synthetic" }),
    ).resolves.toBeUndefined();
    expect(http.request).not.toHaveBeenCalled();
  });

  it("sends both first-party headers when both explicit credentials are set", async () => {
    await probeClaudeEnvironmentCredential({
      ANTHROPIC_AUTH_TOKEN: "synthetic-bearer",
      ANTHROPIC_API_KEY: "synthetic-api",
      CLAUDE_CODE_OAUTH_TOKEN: "unused-oauth",
    });
    expect(http.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer synthetic-bearer", "x-api-key": "synthetic-api" }),
      }),
      expect.any(Function),
    );
  });

  it.each([" invalid", "invalid ", "invalid\rnext", "invalid\nnext"])(
    "rejects a malformed secondary API key before making a request",
    async (key) => {
      await expect(
        probeClaudeEnvironmentCredential({ ANTHROPIC_AUTH_TOKEN: "synthetic-bearer", ANTHROPIC_API_KEY: key }),
      ).resolves.toMatchObject({ code: "credential_missing" });
      expect(http.request).not.toHaveBeenCalled();
    },
  );

  it.each([302, 403, 429, 500, undefined])(
    "keeps non-authentication responses retryable and never follows redirects",
    async (status) => {
      http.status = status;
      await expect(probeClaudeEnvironmentCredential({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic" })).resolves.toMatchObject({
        code: "temporarily_unavailable",
      });
      expect(http.request).toHaveBeenCalledOnce();
    },
  );

  it("keeps transport failures retryable and releases the request agent", async () => {
    http.error = true;
    await expect(probeClaudeEnvironmentCredential({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic" })).resolves.toMatchObject({
      code: "temporarily_unavailable",
    });
    expect(http.destroyed).toHaveBeenCalledOnce();
  });

  it("propagates cancellation instead of reporting a missing credential", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      probeClaudeEnvironmentCredential({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }, controller.signal, async () => {
        throw new Error("request aborted");
      }),
    ).rejects.toThrow("cancelled");
  });

  it("uses configured certificate files without changing the process trust store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-probe-ca-"));
    try {
      const certificate = join(directory, "ca.pem");
      await writeFile(certificate, "synthetic certificate");
      await expect(
        probeClaudeEnvironmentCredential({
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic",
          SSL_CERT_FILE: certificate,
          NODE_EXTRA_CA_CERTS: certificate,
        }),
      ).resolves.toBeUndefined();
      expect(http.options.ca).toEqual(expect.arrayContaining(["synthetic certificate"]));
      expect((http.options.ca as string[]).filter((value) => value === "synthetic certificate")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
