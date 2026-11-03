import { afterEach, expect, it, vi } from "vitest";
import { ApiError, BrowserApi, CLOUD_WORKSPACE_RELEASE_TIMEOUT_MS } from "../api.js";

const SANDBOX = "44444444-4444-4444-8444-444444444444";
const response = {
  sandboxId: SANDBOX,
  sessionId: "33333333-3333-4333-8333-333333333333",
  lifecycle: "ready",
  environmentGeneration: 7,
  currentResourceName: "projects/p/locations/r/instances/fixture",
  currentResourceUid: "uid",
  currentOperationName: null,
  runnerConnected: true,
  runnerReady: false,
  runnerReadiness: null,
  lastErrorCode: null,
  lastErrorAt: null,
  updatedAt: "2026-11-02T00:00:00.000Z",
};
function cookie(value: string) {
  Object.getOwnPropertyDescriptor(Document.prototype, "cookie")?.set?.call(document, value);
}
afterEach(() => {
  vi.useRealTimers();
  cookie("opentag_csrf=; Max-Age=0; Path=/");
});

it("reads the Account-owned allocation status without a caller-selected owner", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (path, init) => {
    expect(path).toBe(`/api/v1/sandboxes/${SANDBOX}/runner`);
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json(response);
  });
  await expect(new BrowserApi(fetchImpl).cloudWorkspaceStatus(SANDBOX)).resolves.toMatchObject({
    environmentGeneration: 7,
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([false, true])("uses the generation-bound Account stop contract with CSRF (discard=%s)", async (discard) => {
  cookie("opentag_csrf=workspace-csrf; Path=/");
  const input = { environmentGeneration: 7, ...(discard ? { discardUnsavedChanges: true as const } : {}) };
  const fetchImpl = vi.fn<typeof fetch>(async (path, init) => {
    expect(path).toBe(`/api/v1/sandboxes/${SANDBOX}/runner/stop`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(new Headers(init?.headers).get("X-OpenTag-CSRF")).toBe("workspace-csrf");
    return Response.json(response);
  });
  await new BrowserApi(fetchImpl).releaseCloudWorkspace(SANDBOX, input);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("does not retry a denied release", async () => {
  cookie("opentag_csrf=workspace-csrf; Path=/");
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code: "FORBIDDEN", message: "denied" } }, { status: 403 }),
  );
  await expect(
    new BrowserApi(fetchImpl).releaseCloudWorkspace(SANDBOX, { environmentGeneration: 7 }),
  ).rejects.toBeInstanceOf(ApiError);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("bounds an uncertain release response without retrying the mutation", async () => {
  cookie("opentag_csrf=workspace-csrf; Path=/");
  vi.useFakeTimers();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream(), { status: 200 }));
  const result = new BrowserApi(fetchImpl).releaseCloudWorkspace(SANDBOX, {
    environmentGeneration: 7,
    discardUnsavedChanges: true,
  });
  const checked = expect(result).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
  await vi.advanceTimersByTimeAsync(CLOUD_WORKSPACE_RELEASE_TIMEOUT_MS);
  await checked;
  expect(fetchImpl).toHaveBeenCalledOnce();
});
