import { describe, expect, it, vi } from "vitest";
import { BrowserApi } from "../api.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";

function setDocumentCookie(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")?.set;
  if (!setter) throw new Error("The test DOM does not expose a cookie setter");
  setter.call(document, value);
}

describe("BrowserApi", () => {
  it("loads strict browser provider availability without retrying as an authenticated request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            providers: [
              { id: "google", enabled: false, startUrl: null },
              { id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(new BrowserApi(fetchImpl).authProviders()).resolves.toMatchObject({
      providers: [{ id: "google" }, { id: "dev", enabled: true }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("binds the default fetch implementation to the browser global", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              id: "498ee47d-16dc-4798-8e20-3608a2973dcf",
              email: "admin@example.com",
              displayName: "Admin",
            },
            memberships: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(new BrowserApi().me()).resolves.toMatchObject({ user: { email: "admin@example.com" } });
    expect(fetchImpl.mock.contexts).toEqual([globalThis]);
  });

  it("rebuilds mutation CSRF headers after refreshing an expired access token", async () => {
    setDocumentCookie("opentag_csrf=old-token; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (fetchImpl.mock.calls.length === 1) {
        expect(url).toContain("/redeem");
        expect(headers.get("X-OpenTag-CSRF")).toBe("old-token");
        return new Response(null, { status: 401 });
      }
      if (fetchImpl.mock.calls.length === 2) {
        expect(url).toBe("/api/v1/auth/browser/refresh");
        setDocumentCookie("opentag_csrf=new-token; Path=/");
        return new Response(null, { status: 204 });
      }
      expect(url).toContain("/redeem");
      expect(headers.get("X-OpenTag-CSRF")).toBe("new-token");
      return new Response(
        JSON.stringify({
          membership: { teamId, teamName: "example", teamDisplayName: "Example", role: "member" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(new BrowserApi(fetchImpl).redeemInvitation("A".repeat(32))).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });

  it("mints a connect command with CSRF and lists only the current user's Computers", async () => {
    setDocumentCookie("opentag_csrf=connect-csrf; Path=/");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === "/api/v1/me/computers") {
        return new Response(JSON.stringify({ computers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(String(input)).toBe("/api/v1/me/connect-codes");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("connect-csrf");
      return new Response(
        JSON.stringify({
          bootstrapCommand: "opentag-dev login code --server http://127.0.0.1:8000",
          expiresIn: 900,
          issuedAt: "2030-01-01T00:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const api = new BrowserApi(fetchImpl);
    await expect(api.ownComputers()).resolves.toEqual({ computers: [] });
    await expect(api.issueConnectCode()).resolves.toMatchObject({ expiresIn: 900 });
    setDocumentCookie("opentag_csrf=; Path=/; Max-Age=0");
  });
});
