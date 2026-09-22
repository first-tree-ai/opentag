import type { AccountComputerSummary, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
    "does not reuse an old success when the computer becomes %s",
    async (connectionStatus) => {
      let finish!: (value: ComputerConnectCodeStatus) => void;
      const redemption = new Promise<ComputerConnectCodeStatus>((resolve) => {
        finish = resolve;
      });
      const issued = {
        connectCodeId: "code",
        bootstrapCommand: "connect-command",
        expiresIn: 900,
        issuedAt: new Date().toISOString(),
      };
      const adapter = {
        issue: vi.fn().mockResolvedValue(issued),
        status: vi
          .fn()
          .mockReturnValueOnce(redemption)
          .mockResolvedValue({ connectCodeId: "code", state: "pending", computerId: null, redeemedAt: null }),
        computers: vi.fn().mockResolvedValue({ computers: [{ ...computer, connectionStatus: "online" }] }),
      };
      const onConnected = vi.fn();
      const props = { confirmed: true, adapter, onConnected, onDeleted: vi.fn() };
      const view = await renderInRouter(<ComputerManagement {...props} computer={computer} />);
      fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
      fireEvent.click(screen.getByRole("button", { name: "Assistant requested a repair?" }));
      fireEvent.click(await screen.findByRole("button", { name: "Repair connection" }));
      expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close Reconnect" }));
      await act(async () => {
        finish({ connectCodeId: "code", state: "redeemed", computerId, redeemedAt: connectedAt });
      });
      await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
      view.rerender(<ComputerManagement {...props} computer={{ ...computer, connectionStatus }} />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: connectionStatus === "disconnected" ? "Reconnect" : "Get connection help",
        }),
      );
      expect(screen.queryByText("Workstation is connected")).toBeNull();
      if (connectionStatus === "disconnected") {
        expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
        expect(adapter.issue).toHaveBeenCalledTimes(2);
      } else {
        expect(await screen.findByRole("button", { name: "Copy instructions" })).toBeTruthy();
        expect(adapter.issue).toHaveBeenCalledOnce();
      }
    },
  );
});
