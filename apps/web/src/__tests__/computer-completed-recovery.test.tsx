import type { AccountComputerSummary, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComputerManagement } from "../features/agents/computer-management.js";
import { computerId } from "./support/app-fixtures.js";
import { renderInRouter } from "./support/router.js";

const connectedAt = "2026-09-22T00:00:00.000Z";
const computer: AccountComputerSummary = {
  computerId,
  displayName: "Workstation",
  platform: "linux",
  connectionStatus: "offline",
  connectedAt,
  lastSeenAt: connectedAt,
  observedAt: connectedAt,
  createdAt: connectedAt,
  agentIds: [],
};

describe("completed Computer recovery", () => {
  it.each(["offline", "disconnected"] as const)(
    "prepares a fresh task when an online Computer becomes %s again",
    async (connectionStatus) => {
      let finish!: (value: ComputerConnectCodeStatus) => void;
      const redemption = new Promise<ComputerConnectCodeStatus>((resolve) => {
        finish = resolve;
      });
      const adapter = {
        issue: vi.fn().mockResolvedValue({
          connectCodeId: "code",
          bootstrapCommand: "connect-command",
          expiresIn: 900,
          issuedAt: new Date().toISOString(),
        }),
        status: vi
          .fn()
          .mockReturnValueOnce(redemption)
          .mockResolvedValue({ connectCodeId: "code", state: "pending", computerId: null, redeemedAt: null }),
        computers: vi.fn().mockResolvedValue({ computers: [{ ...computer, connectionStatus: "online" }] }),
      };
      const onConnected = vi.fn(),
        props = { confirmed: true, adapter, onConnected, onDeleted: vi.fn() };
      const view = await renderInRouter(<ComputerManagement {...props} computer={computer} />);
      expect(await screen.findByRole("button", { name: "Copy instructions" })).toBeTruthy();
      screen.getByRole("button", { name: "Show full instructions" }).focus();
      const card = document.querySelector('[data-ui="computer-management"]');
      await act(async () => {
        finish({ connectCodeId: "code", state: "redeemed", computerId, redeemedAt: connectedAt });
      });
      await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
      expect(document.activeElement).toBe(card);
      view.rerender(<ComputerManagement {...props} computer={{ ...computer, connectionStatus: "online" }} />);
      expect(screen.queryByRole("button", { name: "Copy instructions" })).toBeNull();
      adapter.computers.mockResolvedValue({ computers: [{ ...computer, connectionStatus }] });
      view.rerender(<ComputerManagement {...props} computer={{ ...computer, connectionStatus }} />);
      expect(await screen.findByRole("button", { name: "Copy instructions" })).toBeTruthy();
      expect(screen.queryByText("Connected")).toBeNull();
      expect(adapter.issue).toHaveBeenCalledTimes(2);
      expect(onConnected).toHaveBeenCalledOnce();
    },
  );
});
