import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { SlackAgentProvisionCode } from "./slack-agent-provision-code.js";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
describe("Slack Agent operation code", () => {
  it("only issues on user action and copies the code with one request", async () => {
    const issue = vi
      .spyOn(browserApi, "issueSlackAgentProvisionCode")
      .mockResolvedValue({ code: "slack-provision.example-code", expiresIn: 900, issuedAt: new Date().toISOString() });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<SlackAgentProvisionCode />);
    expect(issue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate and copy code" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("slack-provision.example-code"));
    expect(issue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("15 minutes");
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
  });

  it("keeps a manual copy path when clipboard access fails without issuing another code", async () => {
    const issue = vi
      .spyOn(browserApi, "issueSlackAgentProvisionCode")
      .mockResolvedValue({ code: "slack-provision.manual-code", expiresIn: 900, issuedAt: new Date().toISOString() });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });
    render(<SlackAgentProvisionCode />);
    fireEvent.click(screen.getByRole("button", { name: "Generate and copy code" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Copy the code below"));
    expect(screen.getByDisplayValue("slack-provision.manual-code")).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
