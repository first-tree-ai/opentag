import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComputerIdentity } from "./computer-status.js";

const computer = { displayName: "Workstation", platform: "linux", kind: "local" } as const;

describe("ComputerIdentity last-online line", () => {
  it("says when an offline or disconnected computer was last online, or that there is no record of it", () => {
    const { rerender } = render(<ComputerIdentity computer={computer} connection="offline" lastSeenAt={null} />);
    expect(screen.getByText("No last-online record")).toBeTruthy();

    rerender(<ComputerIdentity computer={computer} connection="disconnected" lastSeenAt={null} />);
    expect(screen.getByText("No last-online record")).toBeTruthy();

    rerender(
      <ComputerIdentity
        computer={computer}
        connection="offline"
        lastSeenAt={new Date(Date.now() - 60_000).toISOString()}
      />,
    );
    expect(screen.getByText(/^Last online/)).toBeTruthy();
  });

  it("shows nothing for an online computer or a caller without a reading", () => {
    const { rerender } = render(<ComputerIdentity computer={computer} connection="online" lastSeenAt={null} />);
    expect(screen.queryByText("No last-online record")).toBeNull();
    rerender(<ComputerIdentity computer={computer} connection="offline" />);
    expect(screen.queryByText("No last-online record")).toBeNull();
    expect(screen.queryByText(/^Last online/)).toBeNull();
  });
});
