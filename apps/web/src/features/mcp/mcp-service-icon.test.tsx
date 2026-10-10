import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpServerCard } from "./mcp-server-card.js";
import { McpServiceIcon } from "./mcp-service-icon.js";
import { entry } from "./mcp-test-fixtures.js";

vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_ENTRIES: [
    { url: "https://mcp.provider.test/mcp", iconUrl: "/provider.svg", iconIsOfficial: true },
    { url: "https://mcp.unverified.test/mcp", iconUrl: "/placeholder.svg" },
  ],
}));

describe("MCP service icons", () => {
  it("keeps the footprint and switches a failed asset to a decorative connection icon", () => {
    const { container } = render(<McpServiceIcon src="/provider.svg" />);
    const image = container.querySelector("img");
    expect(image?.getAttribute("alt")).toBe("");
    const footprint = image?.parentElement;
    expect(footprint?.style.width).toBe("32px");
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.firstElementChild).toBe(footprint);
  });

  it("can display a new asset after the previous one fails", () => {
    const { container, rerender } = render(<McpServiceIcon src="/old.svg" size={24} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    rerender(<McpServiceIcon src="/new.svg" size={24} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/new.svg");
    expect(container.firstElementChild?.getAttribute("style")).toContain("width: 24px");
  });

  it("uses the generic icon when no logo is available", () => {
    const { container } = render(<McpServiceIcon />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("identifies the effective endpoint rather than the user-defined name", () => {
    const server = entry({
      name: "my-workspace",
      effective: { ...entry().effective, url: "https://mcp.provider.test/mcp" },
    });
    const props = {
      entry: server,
      agentName: "Agent",
      onAction: vi.fn(),
      onProbe: vi.fn(),
      onToggle: vi.fn(),
      probing: false,
      toggling: false,
    };
    const { container, rerender } = render(<McpServerCard {...props} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/provider.svg");
    rerender(
      <McpServerCard
        {...props}
        entry={{ ...server, name: "provider", effective: { ...server.effective, url: "https://custom.test/mcp" } }}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".mcp-server-identity svg")).toBeTruthy();
  });
  it("uses the neutral connection icon for an unverified catalog asset", () => {
    const server = entry({ effective: { ...entry().effective, url: "https://mcp.unverified.test/mcp" } });
    const { container } = render(
      <McpServerCard
        entry={server}
        agentName="Agent"
        onAction={vi.fn()}
        onProbe={vi.fn()}
        onToggle={vi.fn()}
        probing={false}
        toggling={false}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".mcp-server-identity svg")).toBeTruthy();
  });
});
