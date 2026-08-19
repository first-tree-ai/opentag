import { describe, expect, it, vi } from "vitest";
import { BrowserApi } from "../api.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";

function setDocumentCookie(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")?.set;
  if (!setter) throw new Error("The test DOM does not expose a cookie setter");
  setter.call(document, value);
}

describe("BrowserApi", () => {
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
});
