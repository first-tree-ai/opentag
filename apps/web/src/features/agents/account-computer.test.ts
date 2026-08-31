import { describe, expect, it } from "vitest";
import { type AccountComputerFacts, resolveAccountComputer } from "./account-computer.js";

function computer(displayName: string, facts: Partial<AccountComputerFacts> = {}): AccountComputerFacts {
  return { connectionStatus: "offline", runtimeReady: false, agentCount: 0, displayName, ...facts };
}

const factsOf = (value: AccountComputerFacts) => value;

describe("resolveAccountComputer", () => {
  it("has no answer for an Account with no Computer", () => {
    expect(resolveAccountComputer([], factsOf)).toBeUndefined();
  });

  it("prefers a Computer that can run an Agent over one that is merely reachable", () => {
    const ready = computer("Zed Tower", { connectionStatus: "online", runtimeReady: true });
    expect(resolveAccountComputer([computer("AAA Spare", { connectionStatus: "online" }), ready], factsOf)).toBe(ready);
  });

  it("prefers a reachable Computer over an unreachable one carrying Agents", () => {
    const online = computer("Zed Tower", { connectionStatus: "online" });
    expect(resolveAccountComputer([computer("Ada's Mac", { agentCount: 2 }), online], factsOf)).toBe(online);
  });

  it("names the Computer carrying the Account's Agents when nothing is reachable", () => {
    // This is the state an operator is in when their machine stops answering, and the surface acts
    // on this answer: naming an idle spare would repair the wrong machine and leave the Agent down.
    const carriesAgents = computer("Ada's Mac", { agentCount: 1 });
    expect(resolveAccountComputer([computer("AAA Spare Box"), carriesAgents, computer("Zed Tower")], factsOf)).toBe(
      carriesAgents,
    );
  });

  it("breaks a tie by display name rather than by the order rows arrived in", () => {
    const first = computer("Ada's Mac", { connectionStatus: "online", runtimeReady: true });
    const second = computer("Zed Tower", { connectionStatus: "online", runtimeReady: true });
    expect(resolveAccountComputer([second, first], factsOf)).toBe(first);
    expect(resolveAccountComputer([first, second], factsOf)).toBe(first);
  });
});
