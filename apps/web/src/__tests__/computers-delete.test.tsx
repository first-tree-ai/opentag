import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { agentId, computerId, installApi, json, resetWebAppState, secondComputerId } from "./support/app-fixtures.js";

const computerPath = (id: string) => `/api/v1/computers/${id}`;

/**
 * Serves a mutable Computer list and answers `DELETE /api/v1/computers/:id` with `deleteResponse`,
 * removing the row only when the delete succeeds, as the Server does.
 */
function installComputers(deleteResponse: () => Response = () => new Response(null, { status: 204 })) {
  let computers: Record<string, unknown>[] = [
    { id: computerId, displayName: "Ada's Mac", platform: "darwin", connectionStatus: "online", agentIds: [] },
    {
      id: secondComputerId,
      displayName: "Build Box",
      platform: "linux",
      connectionStatus: "offline",
      agentIds: [agentId],
    },
  ];
  installApi({ computers: () => computers });
  const base = vi.mocked(fetch).getMockImplementation();
  if (!base) throw new Error("installApi did not install a fetch implementation");
  const deletes: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (init?.method === "DELETE" && path.startsWith("/api/v1/computers/")) {
      deletes.push(path);
      const response = deleteResponse();
      if (response.status === 204)
        computers = computers.filter((computer) => computerPath(String(computer.id)) !== path);
      return response;
    }
    return base(input, init);
  });
  return { deletes };
}

async function openComputer(id: string) {
  window.history.replaceState({}, "", `/agents/computers?computerId=${id}`);
  render(<App />);
  expect(await screen.findByRole("heading", { level: 1, name: "Computer" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Delete computer" }));
}

describe("deleting a Computer", () => {
  beforeEach(resetWebAppState);

  it("deletes an unused Computer after the name is typed and returns to the Account's computers", async () => {
    const { deletes } = installComputers();
    await openComputer(computerId);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete Ada's Mac?" });
    expect(within(dialog).getByText(/This computer is online/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Delete computer" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Type Ada's Mac to confirm"), { target: { value: "Ada's" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type Ada's Mac to confirm"), { target: { value: "Ada's Mac" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(window.location.search).not.toContain("computerId"));
    expect(deletes).toEqual([computerPath(computerId)]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("Build Box")).toBeTruthy();
    expect(screen.queryByText("Ada's Mac")).toBeNull();
  });

  it("refuses a Computer that still hosts Agents without calling the Server", async () => {
    const { deletes } = installComputers();
    await openComputer(secondComputerId);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete Build Box?" });
    expect(within(dialog).getByText(/Agents still use this computer/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Type Build Box to confirm")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Delete computer" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes).toEqual([]);
  });

  it("keeps the dialog open and explains a refused deletion", async () => {
    installComputers(() =>
      json(
        {
          error: {
            code: "COMPUTER_IN_USE",
            category: "deterministic",
            message: "This Computer still hosts 1 Agent(s)",
          },
        },
        409,
      ),
    );
    await openComputer(computerId);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete Ada's Mac?" });
    fireEvent.change(within(dialog).getByLabelText("Type Ada's Mac to confirm"), { target: { value: "Ada's Mac" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete computer" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Agents still use this computer");
    expect(screen.getAllByText("Ada's Mac").length).toBeGreaterThan(0);
  });

  it("reports a failed deletion generically", async () => {
    installComputers(() => json({ error: { message: "unavailable" } }, 503));
    await openComputer(computerId);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete Ada's Mac?" });
    fireEvent.change(within(dialog).getByLabelText("Type Ada's Mac to confirm"), { target: { value: "Ada's Mac" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete computer" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Unable to delete this computer. Try again.");
  });
});
