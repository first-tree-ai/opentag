import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { McpPage } from "./mcp-page.js";
import { AGENT_ID, authorization, detail, entry, openDetails, SERVER_ID, stub, wrap } from "./mcp-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

async function openAdvanced() {
  wrap(<McpPage agentId={AGENT_ID} />);
  await openDetails();
  click("Advanced settings");
}

describe("MCP advanced settings by authentication method", () => {
  it.each(["bearer", "oauth", "none"] as const)(
    "shows applicable fields and saves extra headers for %s",
    async (kind) => {
      stub([entry({ authorization: { ...authorization(), kind } })]);
      const update = vi.spyOn(browserApi, "updateAgentMcpServer").mockResolvedValue(entry());
      await openAdvanced();
      expect(Boolean(screen.queryByLabelText("Auth header"))).toBe(kind === "bearer");
      expect(Boolean(screen.queryByLabelText("Token prefix"))).toBe(kind === "bearer");
      expect(Boolean(screen.queryByText("API key / token"))).toBe(kind === "bearer");
      fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "X-Tenant-ID" } });
      fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "tenant-example" } });
      click("Save changes");
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(AGENT_ID, SERVER_ID, { extraHeaders: { "x-tenant-id": "tenant-example" } }),
      );
    },
  );

  it.each(["bearer", "oauth", "none"] as const)("uses the server's %s default before authorization", async (kind) => {
    const defaults = detail(1);
    stub([entry({ authorization: null })], { ...defaults, server: { ...defaults.server, defaultAuthKind: kind } });
    await openAdvanced();
    await waitFor(() => expect(Boolean(screen.queryByLabelText("Auth header"))).toBe(kind === "bearer"));
    expect(Boolean(screen.queryByLabelText("Token prefix"))).toBe(kind === "bearer");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it.each([
    ["oauth", "x-api-key", true],
    ["oauth", "authorization", false],
    ["bearer", "x-api-key", true],
    ["none", "authorization", false],
  ] as const)("validates %s extra header %s against the configured auth header", async (kind, header, invalid) => {
    stub([
      entry({
        authorization: { ...authorization(), kind },
        effective: { ...entry().effective, authHeader: "x-api-key" },
      }),
    ]);
    await openAdvanced();
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: header } });
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(invalid);
    expect(Boolean(screen.queryByText(/Check the header names and values/))).toBe(invalid);
  });

  it("updates visible settings after the authentication method changes, preserving token configuration", async () => {
    const original = entry({ effective: { ...entry().effective, authHeader: "x-api-key", authScheme: "" } });
    stub([original]);
    vi.spyOn(browserApi, "setMcpAuthorization").mockImplementation(async (_agentId, _serverId, input) => {
      const saved = entry({
        ...original,
        authorization: { ...authorization(), kind: input.kind, hasCredential: input.kind === "bearer" },
      });
      vi.mocked(browserApi.agentMcpServers).mockResolvedValue({ servers: [saved] });
      return saved;
    });
    const update = vi.spyOn(browserApi, "updateAgentMcpServer");
    await openAdvanced();
    expect((screen.getByLabelText("Auth header") as HTMLInputElement).value).toBe("x-api-key");
    click("Authentication");
    fireEvent.click(screen.getByRole("radio", { name: "No authentication" }));
    click("Continue");
    await screen.findByLabelText("Connector address");
    expect(screen.queryByLabelText("Auth header")).toBeNull();
    expect(screen.queryByLabelText("Token prefix")).toBeNull();
    expect(update).not.toHaveBeenCalled();
    click("Authentication");
    fireEvent.click(screen.getByRole("radio", { name: "API key or token" }));
    fireEvent.change(screen.getByLabelText("API key or token", { selector: 'input[type="password"]' }), {
      target: { value: "example-key" },
    });
    click("Save credentials");
    await screen.findByLabelText("Connector address");
    expect((screen.getByLabelText("Auth header") as HTMLInputElement).value).toBe("x-api-key");
    expect((screen.getByLabelText("Token prefix") as HTMLInputElement).value).toBe("");
    expect(update).not.toHaveBeenCalled();
  });

  it("has no shared configuration actions", async () => {
    stub([entry()]);
    await openAdvanced();
    expect(screen.queryByRole("button", { name: "Edit account defaults" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use account default/ })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
