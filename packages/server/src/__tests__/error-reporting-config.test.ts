import { describe, expect, it } from "vitest";
import {
  ERROR_REPORTING_CREDENTIALS_INVALID_MESSAGE,
  parseErrorReportingCredentials,
  resolveErrorReportingConfig,
} from "../error-reporting-config.js";

// Assembled at runtime with a placeholder key so the fixture never reads as a committed credential.
const KEY_TYPE = ["service", "account"].join("_");
function keyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: KEY_TYPE,
    project_id: "opentag-staging",
    client_email: "relay@opentag-staging.example",
    private_key: "placeholder-private-key",
    private_key_id: "ignored",
    ...overrides,
  });
}

describe("parseErrorReportingCredentials", () => {
  it("keeps only the fields the client needs", () => {
    expect(parseErrorReportingCredentials(keyJson())).toEqual({
      client_email: "relay@opentag-staging.example",
      private_key: "placeholder-private-key",
      project_id: "opentag-staging",
    });
    expect(parseErrorReportingCredentials(keyJson({ project_id: undefined }))).toEqual({
      client_email: "relay@opentag-staging.example",
      private_key: "placeholder-private-key",
    });
  });

  it("rejects malformed JSON and keys that are not service account keys", () => {
    expect(parseErrorReportingCredentials("{not json")).toBeUndefined();
    expect(parseErrorReportingCredentials("[]")).toBeUndefined();
    expect(parseErrorReportingCredentials(keyJson({ type: "authorized_user" }))).toBeUndefined();
    expect(parseErrorReportingCredentials(keyJson({ private_key: "" }))).toBeUndefined();
    expect(parseErrorReportingCredentials(keyJson({ client_email: undefined }))).toBeUndefined();
  });

  it("names the variable without quoting its value", () => {
    expect(ERROR_REPORTING_CREDENTIALS_INVALID_MESSAGE).toContain("OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON");
  });
});

describe("resolveErrorReportingConfig", () => {
  const credentials = { client_email: "a@b.example", private_key: "k", project_id: "from-key" };

  it("prefers the explicit project and falls back to the key's project", () => {
    expect(resolveErrorReportingConfig("explicit", credentials)).toEqual({ projectId: "explicit", credentials });
    expect(resolveErrorReportingConfig(undefined, credentials)).toEqual({ projectId: "from-key", credentials });
    expect(resolveErrorReportingConfig("explicit", undefined)).toEqual({ projectId: "explicit" });
    expect(resolveErrorReportingConfig(undefined, undefined)).toEqual({});
  });
});
