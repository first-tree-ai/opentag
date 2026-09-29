import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SKILL_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { skillSourceTooLarge, skillSourceUnreachable } from "../services/skills/index.js";
import { SkillSourceFetcher } from "../services/skills/source/source-fetcher.js";
import type { SkillSourceTransport } from "../services/skills/source/source-transport.js";
import { staticTransport } from "./support/skill-source-fixtures.js";

/**
 * The remote-install outbound call, in isolation: the address rules, the redirect refusal, the byte
 * cap, and the deadline are all asserted without a network, through an injected transport and
 * resolver. The transport is also where the address pin is asserted: the policy's verdict has to be
 * the address that is dialed, or a name that resolves twice defeats the whole rule.
 */

const PNG = new Uint8Array([1, 2, 3, 4]);

function fetcher(options: Partial<ConstructorParameters<typeof SkillSourceFetcher>[0]> = {}) {
  return new SkillSourceFetcher({ allowLoopback: false, ...options });
}

/** A transport that records the address it was asked to dial and answers with fixed bytes. */
function recordingTransport(answer: { status: number; body?: Uint8Array } = { status: 200, body: PNG }) {
  const dials: { url: string; pin: { address: string; family: number } | undefined; maxBytes: number }[] = [];
  const transport: SkillSourceTransport = (request) => {
    dials.push({ url: request.url.toString(), pin: request.pin, maxBytes: request.maxBytes });
    const body = answer.body ?? new Uint8Array();
    if (body.byteLength > request.maxBytes) return Promise.reject(skillSourceTooLarge());
    return Promise.resolve({ status: answer.status, bytes: body });
  };
  return { dials, transport };
}

/** The error code a rejected fetch produced, so a case asserts the classification, not the text. */
async function failureCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("SkillSourceFetcher", () => {
  it("refuses a non-public literal and plain HTTP to a public host", async () => {
    const source = fetcher();
    expect(await failureCode(source.fetchBytes("https://10.0.0.1/skills.json"))).toBe(SKILL_ERROR_CODES.SOURCE_BLOCKED);
    expect(await failureCode(source.fetchBytes("https://169.254.169.254/latest/meta-data"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    expect(await failureCode(source.fetchBytes("http://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    expect(await failureCode(source.fetchBytes("ftp://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    expect(await failureCode(source.fetchBytes("https://user:secret@example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
  });

  it("refuses loopback unless the deployment opted in", async () => {
    expect(await failureCode(fetcher().fetchBytes("http://127.0.0.1:9123/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    const local = fetcher({
      allowLoopback: true,
      transport: async () => ({ status: 200, bytes: PNG }),
    });
    await expect(local.fetchBytes("http://127.0.0.1:9123/skills.json")).resolves.toMatchObject({ status: 200 });
  });

  it("pins the approved address into the connection", async () => {
    const { dials, transport } = recordingTransport();
    const source = new SkillSourceFetcher({
      allowLoopback: false,
      resolveAddresses: async () => ["93.184.216.34"],
      transport,
    });
    await source.fetchBytes("https://example.com/skills.json");
    // The name is kept for the Host header and TLS (`url`), and the address is what is dialed.
    expect(dials).toEqual([
      {
        url: "https://example.com/skills.json",
        pin: { address: "93.184.216.34", family: 4 },
        maxBytes: expect.any(Number),
      },
    ]);
  });

  it("dials a literal without a pin, because the URL already names the address", async () => {
    const { dials, transport } = recordingTransport();
    const source = new SkillSourceFetcher({ allowLoopback: false, transport });
    await source.fetchBytes("https://8.8.8.8/skills.json");
    expect(dials[0]?.pin).toBeUndefined();
  });

  it("does not dial at all when the name resolves to a private address", async () => {
    const { dials, transport } = recordingTransport();
    const source = new SkillSourceFetcher({
      allowLoopback: false,
      resolveAddresses: async () => ["127.0.0.1"],
      transport,
    });
    expect(await failureCode(source.fetchBytes("https://localtest.me/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    expect(dials).toHaveLength(0);
  });

  it("refuses a name that resolves to a private address, and judges every record", async () => {
    const privateName = fetcher({ resolveAddresses: async () => ["127.0.0.1"] });
    expect(await failureCode(privateName.fetchBytes("https://localtest.me/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    const mixed = fetcher({ resolveAddresses: async () => ["93.184.216.34", "10.0.0.5"] });
    expect(await failureCode(mixed.fetchBytes("https://mixed.example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
    const metadata = fetcher({ resolveAddresses: async () => ["fe80::1"] });
    expect(await failureCode(metadata.fetchBytes("https://metadata.example.com/"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
  });

  it("reports a name that does not resolve as unreachable rather than blocked", async () => {
    const failing = fetcher({
      resolveAddresses: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await failureCode(failing.fetchBytes("https://missing.example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
    );
    const empty = fetcher({ resolveAddresses: async () => [] });
    expect(await failureCode(empty.fetchBytes("https://empty.example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
    );
  });

  it("never follows a redirect", async () => {
    const source = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      transport: async () => ({ status: 302, bytes: new Uint8Array() }),
    });
    expect(await failureCode(source.fetchBytes("https://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
  });

  it("reports a non-2xx answer as unreachable, with the status", async () => {
    const source = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      transport: async () => ({ status: 404, bytes: new Uint8Array() }),
    });
    try {
      await source.fetchBytes("https://example.com/skills.json");
      expect.unreachable("the fetch should have failed");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
      expect((error as Error).message).toContain("404");
    }
  });

  it("bounds the delivered length, per request as well as by default", async () => {
    const delivered = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      maxBytes: 4,
      transport: staticTransport({
        "https://example.com/skills.json": () => ({ status: 200, body: new Uint8Array(64) }),
      }),
    });
    expect(await failureCode(delivered.fetchBytes("https://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_TOO_LARGE,
    );
    // A caller with a smaller budget narrows the cap for its own request.
    const narrowed = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      maxBytes: 1024,
      transport: staticTransport({
        "https://example.com/skills.json": () => ({ status: 200, body: new Uint8Array(64) }),
      }),
    });
    expect(await failureCode(narrowed.fetchBytes("https://example.com/skills.json", 8))).toBe(
      SKILL_ERROR_CODES.SOURCE_TOO_LARGE,
    );
  });

  it("reports a refused connection and a deadline as unreachable", async () => {
    // The production transport maps a socket error and an expired deadline to these; the stub stands
    // in for it so the fetcher's own mapping is what is asserted.
    const refused = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      transport: async () => {
        throw skillSourceUnreachable();
      },
    });
    expect(await failureCode(refused.fetchBytes("https://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
    );
    const expired = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      timeoutMs: 5,
      transport: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw skillSourceUnreachable();
      },
    });
    expect(await failureCode(expired.fetchBytes("https://example.com/skills.json"))).toBe(
      SKILL_ERROR_CODES.SOURCE_UNREACHABLE,
    );
  });

  it("returns the bytes of a successful read", async () => {
    const source = fetcher({
      resolveAddresses: async () => ["93.184.216.34"],
      transport: async () => ({ status: 200, bytes: PNG }),
    });
    const result = await source.fetchBytes("https://example.com/skills.json");
    expect(result.status).toBe(200);
    expect(result.url).toBe("https://example.com/skills.json");
    expect([...result.bytes]).toEqual([...PNG]);
  });

  it("keeps raw dialing inside the transport and the tunnel, behind the address policy", () => {
    const directory = fileURLToPath(new URL("../services/skills/source/", import.meta.url));
    const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    // A module that dials a socket is one of exactly two, and both are named for what they do.
    const dialers = files.filter((name) =>
      /netConnect|httpRequest|httpsRequest|tlsConnect|createConnection/.test(
        readFileSync(`${directory}${name}`, "utf8"),
      ),
    );
    expect(dialers.sort()).toEqual(["source-transport.ts", "source-tunnel.ts"]);
    // The two modules that decide what may be reached both ask the shared policy.
    for (const name of ["source-fetcher.ts", "source-tunnel.ts"]) {
      expect(readFileSync(`${directory}${name}`, "utf8"), name).toContain("classifyOutboundDestination");
    }
  });
});
