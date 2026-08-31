import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskMessageBody } from "./task-message-body.js";

describe("TaskMessageBody", () => {
  it("keeps inbound plain text literal", () => {
    render(<TaskMessageBody format="plain_text" text={"# Heading\n- **literal item**"} />);

    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/# Heading/).textContent).toContain("- **literal item**");
  });

  it("renders a safe, readable Markdown subset for Agent output", () => {
    render(
      <TaskMessageBody
        format="markdown"
        text={`# Review summary

- **Five items** are ready
- Run \`pnpm check\`

| Area | State |
| --- | --- |
| Security | Blocked |

[Open docs](https://example.com/docs)

![Architecture](https://example.com/private.png)

<script>unsafe content</script>`}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Review summary" })).toBeTruthy();
    expect(screen.getByText("Five items").tagName).toBe("STRONG");
    expect(screen.getByText("pnpm check").tagName).toBe("CODE");
    expect(screen.getByRole("table")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[Image: Architecture]")).toBeTruthy();
    expect(screen.queryByText(/unsafe content/)).toBeNull();
  });

  it("does not create a link for unsafe protocols", () => {
    render(<TaskMessageBody format="markdown" text="[Run script](javascript:alert(1))" />);

    expect(screen.queryByRole("link", { name: "Run script" })).toBeNull();
    expect(screen.getByText("Run script")).toBeTruthy();
  });
});
