import { describe, expect, it } from "vitest";
import { buildConnectBootstrapCommand } from "../services/auth/index.js";

describe("buildConnectBootstrapCommand", () => {
  it.each([
    [
      "dev",
      `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" login --server http://127.0.0.1:8000 -- code_123`,
    ],
    ["staging", "npm i -g open-tag-staging && opentag-staging login --server https://dev.example.com -- code_123"],
    ["prod", "npm i -g open-tag && opentag login --server https://opentag.example.com -- code_123"],
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
      "npm i -g open-tag-staging && opentag-staging login --server https://dev.example.com -- 'code'\\''; echo injected'",
    );
    expect(command.slice(0, command.indexOf("&&"))).not.toContain("code");
  });

  it("keeps a dev code only in the forwarded login arguments", () => {
    const command = buildConnectBootstrapCommand({
      code: "code'; echo injected",
      environment: "dev",
      publicUrl: "http://127.0.0.1:8000",
    });
    expect(command).toBe(
      `./scripts/dev-install.sh && PATH="$HOME/.local/bin\${PATH:+:$PATH}" "$HOME/.local/bin/opentag-dev" login --server http://127.0.0.1:8000 -- 'code'\\''; echo injected'`,
    );
    expect(command.slice(0, command.indexOf("login"))).not.toContain("code");
  });
});
