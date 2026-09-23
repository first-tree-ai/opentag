import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialsAtomically } from "@opentag/client";
import { ErrorReportRequestSchema, type TurnFailureReason } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ERROR_REPORT_COOLDOWN_MS,
  createAgentErrorReporter,
  shouldReportTurnFailure,
} from "../core/diagnostics/agent-error-reporting.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function connectedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-agent-report-"));
  homes.push(home);
  await writeCredentialsAtomically(
    {
      accessToken: "access-token",
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshToken: "refresh-token",
      serverUrl: "https://opentag.example",
      userId: "account-1",
    },
    home,
  );
  return home;
}

const failure = {
  error: new Error("boom"),
  agentId: "agent-1",
  sessionId: "session-1",
  turnId: "turn-1",
  outcome: "failed" as const,
};

describe("shouldReportTurnFailure", () => {
  it("reports OpenTag's own defects and leaves the machine, the provider, and the caller alone", () => {
    for (const errorReason of [
      "provider_protocol_error",
      "provider_teardown_failed",
      "session_resume_failed",
      "turn_state_unknown",
    ] as const) {
      expect(shouldReportTurnFailure({ errorReason })).toBe(true);
    }
    for (const errorReason of [
      "workspace_failed",
      "configuration_conflict",
      "credential_unavailable",
      "sandbox_unavailable",
      "provider_start_failed",
      "provider_failed",
      "provider_empty_result",
      "output_too_large",
      "turn_timeout",
      "client_shutdown",
    ] as const satisfies readonly TurnFailureReason[]) {
      expect(shouldReportTurnFailure({ errorReason })).toBe(false);
    }
    expect(shouldReportTurnFailure({ errorReason: undefined })).toBe(false);
  });
});

describe("createAgentErrorReporter", () => {
  it("relays a defect naming the Agent, the Session, the turn, and the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const relays: Promise<{ ok: boolean }>[] = [];
    const report = createAgentErrorReporter({
      home: await connectedHome(),
      fetchImpl,
      resolveProvider: () => "claude-code",
      onReported: (relay) => relays.push(relay),
    });

    report({ ...failure, errorReason: "turn_state_unknown" });
    await Promise.all(relays);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(ErrorReportRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      source: "cli",
      message: "boom",
      command: "daemon service-run",
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "claude-code",
      userId: "account-1",
    });
  });

  it("stays silent for a failure that no release could fix, and never throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const relays: Promise<{ ok: boolean }>[] = [];
    const report = createAgentErrorReporter({
      home: await connectedHome(),
      fetchImpl,
      onReported: (relay) => relays.push(relay),
    });

    report({ ...failure, errorReason: "provider_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(relays).toHaveLength(0);

    // A relay that cannot be delivered is lost, not surfaced on the path that is already failing.
    expect(() => report({ ...failure, errorReason: "turn_state_unknown" })).not.toThrow();
    await expect(Promise.all(relays)).resolves.toEqual([{ ok: false }]);
  });

  it("relays one failure per Session and reason per cooldown, and every distinct one", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const relays: Promise<{ ok: boolean }>[] = [];
    const report = createAgentErrorReporter({
      home: await connectedHome(),
      fetchImpl,
      now: () => now,
      onReported: (relay) => relays.push(relay),
    });

    report({ ...failure, errorReason: "turn_state_unknown" });
    report({ ...failure, turnId: "turn-2", errorReason: "turn_state_unknown" });
    // A different reason, and a different Session, are each their own failure.
    report({ ...failure, turnId: "turn-3", errorReason: "provider_protocol_error" });
    report({ ...failure, sessionId: "session-2", errorReason: "turn_state_unknown" });
    now += AGENT_ERROR_REPORT_COOLDOWN_MS;
    report({ ...failure, turnId: "turn-4", errorReason: "turn_state_unknown" });
    await Promise.all(relays);

    const turns = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).turnId);
    expect(turns).toEqual(["turn-1", "turn-3", "turn-1", "turn-4"]);
    expect(AGENT_ERROR_REPORT_COOLDOWN_MS).toBe(30_000);
  });
});
