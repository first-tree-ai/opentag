import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { createApp, sanitizeRequestUrl } from "../app.js";
import { computers, imBindings } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  isPhoneReachableUrl,
  mintFeishuQrLinkToken,
  readFeishuQrLinkToken,
} from "../services/im-bindings/feishu/setup-qr-link.js";
import { FeishuSetupService } from "../services/im-bindings/feishu/setup-service.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const ATTEMPT_ID = "3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b";
const LAUNCHER_URL = `https://open.feishu.cn/page/launcher?user_code=ABCD&addons=${"x".repeat(1200)}`;
const PUBLIC_URL = "https://app.opentag.example";

describe("Feishu QR link token", () => {
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));

  it("reads back the attempt it was minted for, in a short fixed length", () => {
    const token = mintFeishuQrLinkToken(cipher, ATTEMPT_ID);
    expect(token).toHaveLength(43);
    expect(readFeishuQrLinkToken(cipher, token)).toBe(ATTEMPT_ID);
  });

  it("is not the attempt ID, so an ID seen in an API path cannot be turned into a link", () => {
    const token = mintFeishuQrLinkToken(cipher, ATTEMPT_ID);
    const attemptOnly = Buffer.from(ATTEMPT_ID.replaceAll("-", ""), "hex").toString("base64url");
    expect(readFeishuQrLinkToken(cipher, attemptOnly)).toBeUndefined();
    expect(readFeishuQrLinkToken(cipher, `${attemptOnly}${"A".repeat(21)}`)).toBeUndefined();
    expect(token).not.toContain(ATTEMPT_ID);
  });

  it("refuses a token minted under another key", () => {
    const other = new ApplicationCipher(Buffer.alloc(32, 8));
    expect(readFeishuQrLinkToken(other, mintFeishuQrLinkToken(cipher, ATTEMPT_ID))).toBeUndefined();
  });

  it("refuses every changed byte and every malformed spelling", () => {
    const token = mintFeishuQrLinkToken(cipher, ATTEMPT_ID);
    const bytes = Buffer.from(token, "base64url");
    for (let index = 0; index < bytes.length; index += 1) {
      const changed = Buffer.from(bytes);
      changed[index] = (changed[index] ?? 0) ^ 1;
      expect(readFeishuQrLinkToken(cipher, changed.toString("base64url"))).toBeUndefined();
    }
    expect(readFeishuQrLinkToken(cipher, "")).toBeUndefined();
    expect(readFeishuQrLinkToken(cipher, token.slice(1))).toBeUndefined();
    expect(readFeishuQrLinkToken(cipher, `${token}A`)).toBeUndefined();
    expect(readFeishuQrLinkToken(cipher, token.replace(/^./, "!"))).toBeUndefined();
    // The final character carries spare bits: a different spelling of the same bytes was never minted.
    const last = token.at(-1) ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelled = token.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
    expect(readFeishuQrLinkToken(cipher, respelled)).toBeUndefined();
  });

  it("does not collide with another purpose of the same key", () => {
    const message = Buffer.from("value");
    expect(cipher.authenticate("a", message).equals(cipher.authenticate("b", message))).toBe(false);
  });
});

describe("isPhoneReachableUrl", () => {
  it.each(["https://app.opentag.ai", "https://staging.example.com:8443", "https://8.8.8.8", "https://example.com./"])(
    "accepts %s",
    (url) => {
      expect(isPhoneReachableUrl(url)).toBe(true);
    },
  );

  it.each([
    "http://app.opentag.ai",
    "https://localhost:3000",
    "https://foo.localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.1.2.3",
    "https://172.16.0.9",
    "https://192.168.1.20:8080",
    "https://169.254.1.1",
    "https://100.64.0.1",
    "https://[fd00::1]",
    "https://server",
    "https://mac.local",
    "https://opentag.internal",
    "https://box.lan",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isPhoneReachableUrl(url)).toBe(false);
  });
});

describe("request log sanitizing", () => {
  it("removes the token from the path", () => {
    expect(sanitizeRequestUrl("/q/secret-token?x=1")).toBe("/q/[redacted]");
    expect(sanitizeRequestUrl("/qr/not-a-link")).toBe("/qr/not-a-link");
  });
});

describe("GET /q/:token", () => {
  function qrApp(resolveQrLink: (token: string) => Promise<string | undefined>) {
    const logs: string[] = [];
    const app = createApp({
      feishuSetupService: { resolveQrLink } as unknown as FeishuSetupService,
      loggerStream: { write: (line: string) => void logs.push(line) },
    });
    return { app, logs };
  }

  it("redirects without authentication and sends nothing else", async () => {
    const { app } = qrApp(async () => LAUNCHER_URL);
    try {
      const response = await app.inject({ method: "GET", url: "/q/token" });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(LAUNCHER_URL);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.body).toBe("");
    } finally {
      await app.close();
    }
  });

  it("answers a dead link with a fixed page in the phone's language", async () => {
    const { app } = qrApp(async () => undefined);
    try {
      const english = await app.inject({ method: "GET", url: "/q/token" });
      expect(english.statusCode).toBe(410);
      expect(english.headers["content-type"]).toContain("text/html");
      expect(english.body).toContain("This QR code no longer works");
      expect(english.body).not.toContain("token");

      const chinese = await app.inject({
        method: "GET",
        url: "/q/token",
        headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
      });
      expect(chinese.statusCode).toBe(410);
      expect(chinese.body).toContain("这个二维码已失效");
    } finally {
      await app.close();
    }
  });

  it("says try again, rather than expired, when the read fails", async () => {
    const { app, logs } = qrApp(async () => {
      throw new Error("database unavailable");
    });
    try {
      const response = await app.inject({ method: "GET", url: "/q/secret-token-value" });
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain("Wait a moment");
      expect(response.body).not.toContain("database");
      expect(logs.join("")).toContain("FEISHU_QR_LINK_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });

  it("keeps the token out of every log line", async () => {
    const { app, logs } = qrApp(async () => LAUNCHER_URL);
    try {
      await app.inject({ method: "GET", url: "/q/secret-token-value" });
      expect(logs.length).toBeGreaterThan(0);
      const logged = logs.join("");
      expect(logged).not.toContain("secret-token-value");
      expect(logged).not.toContain("user_code");
    } finally {
      await app.close();
    }
  });
});

describe("FeishuSetupService QR link", () => {
  let unitDatabase: UnitDatabase;
  const now = new Date("2026-08-19T00:00:00.000Z");
  const expiresAt = new Date(now.getTime() + 60_000);

  beforeAll(async () => {
    unitDatabase = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => unitDatabase?.close());
  beforeEach(async () => unitDatabase?.reset());

  async function fixture(publicUrl: string | undefined) {
    const bootstrap = await bootstrapInitialAdmin(unitDatabase.database, {
      displayName: "Admin",
      email: `qr-${crypto.randomUUID()}@example.com`,
    });
    const [computer] = await unitDatabase.database
      .insert(computers)
      .values({
        ownerAccountId: bootstrap.userId,
        currentInstallationId: crypto.randomUUID(),
        displayName: "qr-computer",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
      })
      .returning();
    if (!computer) throw new Error("Computer fixture was not created");
    const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
      name: "qr-agent",
      displayName: "QR Agent",
      runtimeProvider: "codex",
      computerId: computer.id,
    });
    const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
    const clock = { now };
    const setup = new FeishuSetupService({
      database: unitDatabase.database,
      cipher,
      instanceId: crypto.randomUUID(),
      imBindings: new ImBindingService(unitDatabase.database, cipher, { now: () => clock.now }),
      registrations: {
        start: () => {
          let abort = (): void => undefined;
          const result = new Promise<never>((_, reject) => {
            abort = () => reject(Object.assign(new Error("Registration canceled"), { code: "abort" }));
          });
          return { qrReady: Promise.resolve({ url: LAUNCHER_URL, expiresAt }), result, abort: () => abort() };
        },
      },
      activation: { activateAtomicAttempt: vi.fn() },
      now: () => clock.now,
      ...(publicUrl ? { publicUrl } : {}),
    });
    return { bootstrap, agent, cipher, clock, setup };
  }

  function tokenOf(qrUrl: string | null): string {
    const url = new URL(qrUrl ?? "");
    return url.pathname.replace("/q/", "");
  }

  it("hands out a short link that resolves to the launcher, repeatedly", async () => {
    const { bootstrap, agent, setup } = await fixture(PUBLIC_URL);
    try {
      const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
      expect(attempt.qrUrl).toMatch(/^https:\/\/app\.opentag\.example\/q\/[A-Za-z0-9_-]{43}$/);
      expect(attempt.qrUrl?.length).toBeLessThan(80);
      const token = tokenOf(attempt.qrUrl);
      await expect(setup.resolveQrLink(token)).resolves.toBe(LAUNCHER_URL);
      await expect(setup.resolveQrLink(token)).resolves.toBe(LAUNCHER_URL);
    } finally {
      await setup.stop();
    }
  });

  it("gives the same link on every read, so a polling page does not redraw the code", async () => {
    const { bootstrap, agent, setup } = await fixture(PUBLIC_URL);
    try {
      const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
      await expect(setup.get(bootstrap.userId, attempt.id)).resolves.toMatchObject({ qrUrl: attempt.qrUrl });
    } finally {
      await setup.stop();
    }
  });

  it.each([undefined, "http://localhost:3000", "https://192.168.1.20"])(
    "keeps the full launcher URL when the public URL is %s",
    async (publicUrl) => {
      const { bootstrap, agent, setup } = await fixture(publicUrl);
      try {
        const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
        expect(attempt.qrUrl).toBe(LAUNCHER_URL);
      } finally {
        await setup.stop();
      }
    },
  );

  it("ends the link when the attempt expires", async () => {
    const { bootstrap, agent, clock, setup } = await fixture(PUBLIC_URL);
    try {
      const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
      const token = tokenOf(attempt.qrUrl);
      clock.now = expiresAt;
      await expect(setup.resolveQrLink(token)).resolves.toBeUndefined();
    } finally {
      await setup.stop();
    }
  });

  it("ends the link when the attempt is cancelled", async () => {
    const { bootstrap, agent, setup } = await fixture(PUBLIC_URL);
    try {
      const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
      const token = tokenOf(attempt.qrUrl);
      await setup.cancel(bootstrap.userId, attempt.id);
      await expect(setup.resolveQrLink(token)).resolves.toBeUndefined();
    } finally {
      await setup.stop();
    }
  });

  it("ends the link when the registration owner is gone", async () => {
    const { bootstrap, agent, setup } = await fixture(PUBLIC_URL);
    try {
      const attempt = await setup.createOrReuse(bootstrap.userId, agent.id, "create");
      const token = tokenOf(attempt.qrUrl);
      await unitDatabase.database
        .update(imBindings)
        .set({ setupOwnerHeartbeatAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) })
        .where(eq(imBindings.setupAttemptId, attempt.id));
      await expect(setup.resolveQrLink(token)).resolves.toBeUndefined();
    } finally {
      await setup.stop();
    }
  });

  it("refuses a valid token for an attempt that does not exist, and a forged one without a read", async () => {
    const { cipher, setup } = await fixture(PUBLIC_URL);
    try {
      await expect(setup.resolveQrLink(mintFeishuQrLinkToken(cipher, ATTEMPT_ID))).resolves.toBeUndefined();
      const select = vi.spyOn(unitDatabase.database, "select");
      await expect(setup.resolveQrLink("forged")).resolves.toBeUndefined();
      expect(select).not.toHaveBeenCalled();
    } finally {
      await setup.stop();
    }
  });
});
