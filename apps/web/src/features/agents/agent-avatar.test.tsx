import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar.js";

describe("AgentAvatar", () => {
  it("falls back to initials and retries when the stored URL changes", () => {
    const { container, rerender } = render(
      <AgentAvatar displayName="Developer Cat" avatarUrl="https://example.com/old.png" />,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://example.com/old.png");
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("DC");
    rerender(<AgentAvatar displayName="Developer Cat" avatarUrl="https://example.com/new.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/new.png");
    rerender(<AgentAvatar displayName="Developer Cat" avatarUrl={null} />);
    expect(container.textContent).toBe("DC");
  });
});
