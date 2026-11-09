import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LAB_AGENT_ID, labSeed } from "../onboarding-v2/agent-setup-lab-model.js";
import { createMemorySetupAdapter } from "../onboarding-v2/setup-memory-adapter.js";
import { createBotPreviewAdapter } from "./adapter.js";
import { BotConnectionPlayground } from "./playground.js";

async function expectState(state: string) {
  await waitFor(() =>
    expect(document.querySelector('[data-ui="agent-setup-messaging"]')?.getAttribute("data-state")).toBe(state),
  );
}

describe("isolated bot connection playground", () => {
  it("drives the real Feishu surface through failure, retry, approval, handoff and ready without HTTP", async () => {
    render(<BotConnectionPlayground initialControlsOpen />);
    await expectState("not-configured");
    expect(document.querySelector('[data-ui="onboarding-v2-step-agent"]')).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Feishu|Lark/ }));
    await expectState("authorizing");
    fireEvent.click(screen.getByRole("button", { name: "Simulate authorization failure" }));
    await expectState("blocked");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(await screen.findByRole("button", { name: /Feishu|Lark/ }));
    await expectState("authorizing");
    fireEvent.click(screen.getByRole("button", { name: "Simulate approval pending" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Simulate approval pending" }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Simulate next event" }));
    await expectState("waiting-handoff");
    fireEvent.click(screen.getByRole("button", { name: "Simulate next event" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("connects Slack using demo input and resets its query state without making an API request", async () => {
    render(<BotConnectionPlayground initialControlsOpen />);
    const slackButton = await screen.findByRole("button", { name: /Slack/ });
    await waitFor(() => expect(slackButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(slackButton);
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "demo-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(
      "Authorization saved. Open the Bot’s chat and send “Hello”. Confirm its reply to verify actual message delivery.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Connect Slack" }));
    await expectState("waiting-handoff");
    fireEvent.click(screen.getByRole("button", { name: "Simulate next event" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await expectState("not-configured");
    const resetSlackButton = await screen.findByRole("button", { name: /Slack/ });
    await waitFor(() => expect(resetSlackButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(resetSlackButton);
    expect(await screen.findByLabelText("Code")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses an inert QR destination and keeps the shared memory adapter unchanged", async () => {
    const memory = createMemorySetupAdapter(labSeed("messaging-setup", "one-online", "codex", "feishu"));
    const adapter = createBotPreviewAdapter(memory);
    await adapter.startFeishuAttempt(LAB_AGENT_ID, "create", { kind: "unbound" });
    const snapshot = await adapter.readSnapshot(LAB_AGENT_ID);
    expect(snapshot.messaging).toMatchObject({
      kind: "authorizing",
      qrUrl: "https://preview.invalid/bot-connection/demo-only",
    });
    expect(memory.inspect().snapshot.messaging).toMatchObject({
      qrUrl: "https://accounts.feishu.cn/device?code=memory",
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
