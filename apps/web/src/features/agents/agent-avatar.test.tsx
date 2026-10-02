import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar.js";

describe("AgentAvatar", () => {
  it("falls back to initials and retries when the same-origin path changes", () => {
    const { container, rerender } = render(
      <AgentAvatar
        displayName="Developer Cat"
        avatarPath="/api/v1/agents/11111111-1111-4111-8111-111111111111/avatar"
      />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/api/v1/agents/11111111-1111-4111-8111-111111111111/avatar");
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("DC");
    rerender(
      <AgentAvatar
        displayName="Developer Cat"
        avatarPath="/api/v1/agents/22222222-2222-4222-8222-222222222222/avatar"
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/agents/22222222-2222-4222-8222-222222222222/avatar",
    );
    rerender(<AgentAvatar displayName="Developer Cat" avatarPath={null} />);
    expect(container.textContent).toBe("DC");
  });
});
