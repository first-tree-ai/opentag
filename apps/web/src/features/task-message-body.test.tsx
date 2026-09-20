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

  it("says there is no text rather than rendering an empty paragraph", () => {
    render(<TaskMessageBody format="plain_text" text="" />);

    expect(screen.getByText("No text content")).toBeTruthy();
    expect(document.querySelector('[data-content-format="plain_text"]')?.textContent).toBe("No text content");
  });

  it("renders every heading level, quoting the Agent's own structure", () => {
    render(
      <TaskMessageBody
        format="markdown"
        text={`# One

## Two

### Three

#### Four

##### Five

###### Six`}
      />,
    );

    // H1 and H2 become the page's third level so a reply never outranks the surrounding document.
    expect(screen.getByRole("heading", { level: 3, name: "One" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Two" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Three" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Four" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Five" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Six" })).toBeTruthy();
  });

  it("renders a quote, both list kinds, a rule, and a fenced block", () => {
    const { container } = render(
      <TaskMessageBody
        format="markdown"
        text={`> Quoted claim

- bullet one
- bullet two

1. first
2. second

---

\`\`\`sh\npnpm check\n\`\`\``}
      />,
    );

    expect(container.querySelector("blockquote")?.textContent?.trim()).toBe("Quoted claim");
    expect(container.querySelector("ul")?.textContent).toContain("bullet one");
    expect(container.querySelector("ol")?.textContent).toContain("first");
    expect(container.querySelector("hr")).toBeTruthy();
    // The fenced block keeps its own pre, and its code child loses the inline-chip styling there.
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("pnpm check");
    expect(pre?.querySelector("code")).toBeTruthy();
  });

  it("renders an image with no alt text as nothing, since there is nothing to describe", () => {
    render(<TaskMessageBody format="markdown" text="![](https://example.com/decoration.png)" />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/\[Image:/)).toBeNull();
  });

  it("keeps a nested list's structure instead of flattening it into one paragraph", () => {
    render(<TaskMessageBody format="markdown" text={`- outer\n\n  - inner\n- second outer`} />);

    expect(screen.getByText("outer")).toBeTruthy();
    expect(screen.getByText("inner")).toBeTruthy();
    expect(screen.getByText("second outer")).toBeTruthy();
  });

  it("marks the body with the format it was given, so a reader can style each differently", () => {
    const { container, unmount } = render(<TaskMessageBody format="markdown" text="# Heading" />);
    expect(container.querySelector('[data-content-format="markdown"]')).toBeTruthy();
    unmount();

    render(<TaskMessageBody format="plain_text" text="# Heading" />);
    expect(document.querySelector('[data-content-format="plain_text"]')).toBeTruthy();
  });
});
