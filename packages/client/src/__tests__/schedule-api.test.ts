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

it("includes execution provenance headers on create, update and resume", async () => {
  const executionId = "22222222-2222-4222-8222-222222222222";
  const requests: RequestInit[] = [];
  const api = new OpenTagApi(baseUrl, async (_url, init) => {
    requests.push(init ?? {});
    throw new Error("stop after capturing request");
  });
  const options = { executionId };
  await api
    .createRuntimeAgentSchedule(
      "proof",
      { name: "task", prompt: "check", schedule: { kind: "every", intervalSeconds: 120 }, timezone: "UTC" },
      options,
    )
    .catch(() => undefined);
  await api
    .updateRuntimeAgentSchedule("proof", scheduleId, { expectedRevision: 1, prompt: "edit" }, options)
    .catch(() => undefined);
  await api.resumeRuntimeAgentSchedule("proof", scheduleId, 1, options).catch(() => undefined);
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(new Headers(request.headers).get("x-opentag-execution-id")).toBe(executionId);
    expect(new Headers(request.headers).get(SESSION_CLI_PROOF_HEADER)).toBe("proof");
  }
});
