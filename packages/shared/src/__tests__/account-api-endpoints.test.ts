import { describe, expect, it } from "vitest";
import { COMPUTER_ACCESS_CAPABILITY_HEADER } from "../account.js";
import { accountApiEndpoints, toAccountApiRequestInit } from "../account-api-endpoints.js";
import {
  AGENT_ACTIVITY_QUEUED_COUNT_HEADER,
  AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
  AGENT_ACTIVITY_TASK_COUNT_HEADER,
  AGENT_ACTIVITY_TASK_COUNT_VERSION,
} from "../agent.js";
import { AGENT_STATUS_HEADER, AGENT_STATUS_VERSION } from "../agent-status.js";
import {
  CLOUD_IDENTITY_CAPABILITY_HEADER,
  PROVIDER_CLI_REASON_V2_HEADER,
  PROVIDER_READINESS_V1_HEADER,
  PROVIDER_READINESS_V2_HEADER,
} from "../computer.js";

describe("accountApiEndpoints", () => {
  it("constructs GET request init without method or body", () => {
    const endpoint = accountApiEndpoints.me();
    expect(endpoint.method).toBe("GET");
    expect(endpoint.path).toBe("/api/v1/me");
    expect(toAccountApiRequestInit(endpoint)).toEqual({});
    expect(toAccountApiRequestInit(endpoint, { authorization: "Bearer tok" })).toEqual({
      headers: { authorization: "Bearer tok" },
    });
  });

  it("merges capability headers with caller extra headers", () => {
    const cliComputers = accountApiEndpoints.listAccountComputers();
    expect(toAccountApiRequestInit(cliComputers, { authorization: "Bearer tok" })).toEqual({
      headers: {
        [PROVIDER_READINESS_V1_HEADER]: "1",
        [PROVIDER_READINESS_V2_HEADER]: "2",
        [PROVIDER_CLI_REASON_V2_HEADER]: "2",
        authorization: "Bearer tok",
      },
    });

    const browserComputers = accountApiEndpoints.listAccountComputers({ includeBrowserCapabilities: true });
    expect(toAccountApiRequestInit(browserComputers)).toEqual({
      headers: {
        [PROVIDER_READINESS_V1_HEADER]: "1",
        [PROVIDER_READINESS_V2_HEADER]: "2",
        [PROVIDER_CLI_REASON_V2_HEADER]: "2",
        [CLOUD_IDENTITY_CAPABILITY_HEADER]: "1",
        [COMPUTER_ACCESS_CAPABILITY_HEADER]: "1",
      },
    });
  });

  it("supports optional activity and status headers on agent read endpoints", () => {
    expect(toAccountApiRequestInit(accountApiEndpoints.listAgents())).toEqual({});
    expect(toAccountApiRequestInit(accountApiEndpoints.listAgents({ includeActivityAndStatus: true }))).toEqual({
      headers: {
        [AGENT_ACTIVITY_TASK_COUNT_HEADER]: AGENT_ACTIVITY_TASK_COUNT_VERSION,
        [AGENT_ACTIVITY_QUEUED_COUNT_HEADER]: AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
        [AGENT_STATUS_HEADER]: AGENT_STATUS_VERSION,
      },
    });

    expect(toAccountApiRequestInit(accountApiEndpoints.getAgent("agent-1"))).toEqual({});
    expect(toAccountApiRequestInit(accountApiEndpoints.getAgent("agent-1", { includeActivity: true }))).toEqual({
      headers: {
        [AGENT_ACTIVITY_TASK_COUNT_HEADER]: AGENT_ACTIVITY_TASK_COUNT_VERSION,
        [AGENT_ACTIVITY_QUEUED_COUNT_HEADER]: AGENT_ACTIVITY_QUEUED_COUNT_VERSION,
      },
    });
  });

  it("serializes JSON bodies and attaches application/json content-type only when jsonBody is present", () => {
    const emptyConnectCode = accountApiEndpoints.issueComputerConnectCode();
    expect(toAccountApiRequestInit(emptyConnectCode, { "X-OpenTag-CSRF": "csrf-1" })).toEqual({
      method: "POST",
      headers: { "X-OpenTag-CSRF": "csrf-1" },
    });

    const targetedConnectCode = accountApiEndpoints.issueComputerConnectCode({
      mode: "repair",
      targetComputerId: "comp-1",
    });
    expect(toAccountApiRequestInit(targetedConnectCode, { "X-OpenTag-CSRF": "csrf-1" })).toEqual({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-OpenTag-CSRF": "csrf-1",
      },
      body: JSON.stringify({ mode: "repair", targetComputerId: "comp-1" }),
    });

    const revokeWithoutState = accountApiEndpoints.revokeMcpAuthorization("agent-1", "mcp-1");
    expect(toAccountApiRequestInit(revokeWithoutState, { authorization: "Bearer tok" })).toEqual({
      method: "DELETE",
      headers: { authorization: "Bearer tok" },
    });

    const revokeWithState = accountApiEndpoints.revokeMcpAuthorization("agent-1", "mcp-1", "state-1");
    expect(toAccountApiRequestInit(revokeWithState, { authorization: "Bearer tok" })).toEqual({
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
      },
      body: JSON.stringify({ expectedOAuthState: "state-1" }),
    });
  });
});
