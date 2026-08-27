import { OpenTagApi } from "@opentag/client";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { formatSessionCommandError, requestWithRetryKey, SessionCommandRequestError } from "../core/session/index.js";

describe("session CLI", () => {
  it("exposes only create, send, and bounded list commands with implicit source identity", () => {
    const session = createProgram().commands.find((command) => command.name() === "session");
    expect(session?.commands.map((command) => command.name())).toEqual(["create", "send", "list"]);
    expect(session?.commands.some((command) => command.name() === "end")).toBe(false);
    const help = session?.helpInformation() ?? "";
    expect(help).not.toContain("source-session");
    expect(help).not.toContain("agent-id");
    const listHelp = session?.commands.find((command) => command.name() === "list")?.helpInformation() ?? "";
    expect(listHelp).not.toContain("--all");
    expect(listHelp).toContain("--cursor");
  });

  it("keeps the retry key visible when a sent request loses its response", async () => {
    const messageId = "11111111-1111-4111-8111-111111111111";
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("connection reset after request write"));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    const request = vi.fn(() => api.createInternalSession("runtime-proof", { messageId, message: "task" }));
    const error = await requestWithRetryKey(messageId, request).catch((failure: unknown) => failure);

    expect(request).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SessionCommandRequestError);
    if (!(error instanceof SessionCommandRequestError)) throw error;
    expect(formatSessionCommandError(error, false)).toContain(`status=unknown messageId=${messageId}`);
    expect(JSON.parse(formatSessionCommandError(error, true))).toEqual({
      status: "unknown",
      messageId,
      code: "SERVICE_UNAVAILABLE",
      message: "The OpenTag server is unavailable",
    });
  });
});
