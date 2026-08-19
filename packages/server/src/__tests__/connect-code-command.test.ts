import { describe, expect, it } from "vitest";
import { buildConnectBootstrapCommand } from "../services/auth/index.js";

describe("buildConnectBootstrapCommand", () => {
  it.each([
    ["dev", "opentag-dev login code_123 --server http://127.0.0.1:8000"],
    ["staging", "npm i -g open-tag-staging && opentag-staging login code_123 --server https://dev.example.com"],
    ["prod", "npm i -g open-tag && opentag login code_123 --server https://opentag.example.com"],
  ] as const)("builds the %s command from the shared channel config", (environment, expected) => {
    expect(
      buildConnectBootstrapCommand({
        code: "code_123",
        environment,
        publicUrl:
          environment === "dev"
            ? "http://127.0.0.1:8000"
            : environment === "staging"
              ? "https://dev.example.com"
              : "https://opentag.example.com",
      }),
    ).toBe(expected);
  });

  it("shell-quotes an unsafe code and keeps it out of the install command", () => {
    const code = "code'; echo injected";
    const command = buildConnectBootstrapCommand({
      code,
      environment: "staging",
      publicUrl: "https://dev.example.com",
    });
    expect(command).toBe(
      "npm i -g open-tag-staging && opentag-staging login 'code'\\''; echo injected' --server https://dev.example.com",
    );
    expect(command.slice(0, command.indexOf("&&"))).not.toContain("code");
  });
});
