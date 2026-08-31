import type { ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { readConnectCodeVerdict } from "./connect-code-verdict.js";

const CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";

function terminal(state: "pending" | "expired" | "revoked"): ComputerConnectCodeStatus {
  return { connectCodeId: CODE_ID, state, computerId: null, redeemedAt: null };
}

describe("readConnectCodeVerdict", () => {
  it("waits on a pending code and adopts the exact redeemed Computer", () => {
    expect(readConnectCodeVerdict(terminal("pending"))).toEqual({ kind: "wait" });
    expect(
      readConnectCodeVerdict({
        connectCodeId: CODE_ID,
        state: "redeemed",
        computerId: COMPUTER_ID,
        redeemedAt: REDEEMED_AT,
      }),
    ).toEqual({ kind: "adopt", computerId: COMPUTER_ID, redeemedAt: REDEEMED_AT });
  });

  it("fails closed on expired and revoked codes, which never name a Computer", () => {
    expect(readConnectCodeVerdict(terminal("expired"))).toEqual({ kind: "expire" });
    expect(readConnectCodeVerdict(terminal("revoked"))).toEqual({ kind: "expire" });
  });
});
