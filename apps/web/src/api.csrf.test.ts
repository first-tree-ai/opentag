/**
 * Every mutation the browser sends carries the double-submit token.
 *
 * The browser authenticates by cookie, and the Server requires `x-opentag-csrf` on every non-safe
 * method for that transport. A method that forgets the header does not fail loudly: it gets a 403
 * that a caller's `catch` can quietly turn into "nothing happened". So the invariant is asserted
 * over the whole class rather than per feature — one method at a time is how it was missed.
 *
 * The table is compared against the class itself, so a new method cannot be added without either
 * being exercised here or being named as an exemption.
 */

import { describe, expect, it, vi } from "vitest";
import { BrowserApi } from "./api.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Request plumbing, not part of the surface a page calls. */
const INTERNAL = new Set([
  "constructor",
  "request",
  "requestOptional",
  "requestNoContent",
  "fetchWithRefresh",
  "apiError",
  "parseResponse",
  "csrfHeaders",
  "csrfToken",
]);

/*
 * Signing up and signing in are the requests that mint the token, so a browser making them has
 * none to send. The Server fences those two on the request origin instead.
 */
const NO_TOKEN_BY_DESIGN = new Set(["signUpWithPassword", "signInWithPassword"]);

const ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

/*
 * Called by name with argument arrays rather than as typed calls: what is under test is the shape
 * of the request each method puts on the wire, and driving them uniformly is what lets the table be
 * checked against the class for completeness.
 */
const INVOCATIONS: Record<string, readonly unknown[]> = {
  me: [],
  updateProfile: [{ displayName: "Ada" }],
  authProviders: [],
  completeSetup: [ID],
  agents: [],
  tasks: [{}],
  task: [ID],
  agent: [ID],
  agentUsage: [ID, 7],
  agentConfig: [ID],
  createAgent: [{ name: "a", displayName: "A", runtimeProvider: "codex" }],
  updateAgent: [ID, { displayName: "A" }],
  suspendAgent: [ID],
  reactivateAgent: [ID],
  deleteAgent: [ID],
  imBinding: [ID],
  imBindingHandoff: [ID],
  imBindingConfig: [ID],
  createFeishuSetupAttempt: [ID, "create", "lark"],
  feishuSetupAttempt: [ID],
  cancelFeishuSetupAttempt: [ID],
  startSlackOAuth: [ID, { intent: "create" }],
  imBindingDiagnostics: [ID],
  disableImBinding: [ID],
  computers: [],
  internalNavigationVisibility: [],
  updateInternalNavigationVisibility: [{ tasks: true }],
  updateTaskTitle: [ID, { title: "A task" }],
  computerConnectCodeStatus: [ID],
  rebindAgentComputer: [ID, ID],
  testAgentRuntime: [ID, { provider: "codex" }],
  internalToolsOffered: [],
  resetAccountSetup: ["reboard"],
  issueComputerConnectCode: [],
  health: ["/healthz"],
  signUpWithPassword: [{ email: "a@example.com", password: "pw", displayName: "Ada" }],
  signInWithPassword: [{ email: "a@example.com", password: "pw" }],
  logout: [],
};

function headerValue(init: RequestInit | undefined): string | undefined {
  return new Headers(init?.headers).get("x-opentag-csrf") ?? undefined;
}

describe("BrowserApi mutations", () => {
  it("exercises every method the class exposes", () => {
    const exposed = Object.getOwnPropertyNames(BrowserApi.prototype).filter((name) => !INTERNAL.has(name));
    expect(new Set(exposed)).toEqual(new Set(Object.keys(INVOCATIONS)));
  });

  it("sends the double-submit token on every non-safe request", async () => {
    document.cookie = "opentag_csrf=probe-token";
    const missing: string[] = [];

    for (const [name, args] of Object.entries(INVOCATIONS)) {
      const calls: [string, RequestInit | undefined][] = [];
      const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push([String(input), init]);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const api = new BrowserApi(fetchImpl);

      // The response is deliberately not a valid body for any of these, so the call rejects after
      // the request has been made. What it returns is not what is under test.
      await (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
        [name]?.(...args)
        .catch(() => undefined);

      for (const [, init] of calls) {
        const method = (init?.method ?? "GET").toUpperCase();
        if (SAFE_METHODS.has(method)) continue;
        if (NO_TOKEN_BY_DESIGN.has(name)) {
          expect(headerValue(init)).toBeUndefined();
          continue;
        }
        if (headerValue(init) !== "probe-token") missing.push(name);
      }

      /*
       * A method that never reaches `fetch` would assert nothing above and pass vacuously, which
       * reads identically to a real pass. Every method here makes a request today; requiring it
       * keeps a future short-circuit from silently dropping out of the invariant.
       */
      if (calls.length === 0) missing.push(`${name} (made no request)`);
    }

    expect(missing).toEqual([]);
  });
});
