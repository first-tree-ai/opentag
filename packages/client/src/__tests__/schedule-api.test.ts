import { SESSION_CLI_PROOF_HEADER } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { OpenTagApi, OpenTagApiError } from "../api.js";

const scheduleId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const baseUrl = "https://opentag.example";

describe("OpenTagApi runtime schedule methods", () => {
  it("uses the Session proof and canonical paths for list and preview", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      const body = String(input).endsWith("/preview")
        ? {
            calculatedAt: "2026-09-28T00:00:00.000Z",
            schedule: { kind: "every", intervalSeconds: 120, anchorAt: "2026-09-28T00:00:00.000Z" },
            timezone: "UTC",
            items: [],
          }
        : { items: [], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = new OpenTagApi(baseUrl, fetchImpl);
    await api.listRuntimeAgentSchedules("proof", { limit: 10, cursor: "next page" });
    await api.previewRuntimeAgentSchedule("proof", { scheduleId });
    expect(requests.map((request) => request.url)).toEqual([
      `${baseUrl}/api/v1/runtime/agent/schedules?limit=10&cursor=next+page`,
      `${baseUrl}/api/v1/runtime/agent/schedules/preview`,
    ]);
    expect(requests.map((request) => new Headers(request.init.headers).get(SESSION_CLI_PROOF_HEADER))).toEqual([
      "proof",
      "proof",
    ]);
    expect(requests[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ scheduleId });
  });

  it("does not retry an indeterminate create transport error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection closed after send"));
    const api = new OpenTagApi(baseUrl, fetchImpl);
    await expect(
      api.createRuntimeAgentSchedule("proof", {
        name: "Review",
        prompt: "Review the changes",
        schedule: { kind: "at", at: "2026-09-29T00:00:00Z" },
        timezone: "UTC",
      }),
    ).rejects.toBeInstanceOf(OpenTagApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
