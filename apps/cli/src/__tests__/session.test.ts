import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "@opentag/client";
import { OpenTagApi } from "@opentag/client";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as sessionCore from "../core/session/index.js";
import {
  formatSessionCommandError,
  formatSessionCommandResult,
  formatSessionList,
  requestWithRetryKey,
  runSessionCreate,
  runSessionList,
  runSessionSend,
  SessionCommandRequestError,
} from "../core/session/index.js";

vi.mock("@opentag/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentag/client")>();
  return {
    ...actual,
    readComputerIdentity: vi.fn(),
    readSessionCliProofFile: vi.fn(),
    resolveOpenTagHome: vi.fn(),
  };
});

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

  it("executes session command actions with text, JSON, rejection, and list output", async () => {
    const create = vi.spyOn(sessionCore, "runSessionCreate").mockResolvedValue({
      status: "accepted",
      messageId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      code: "queued",
    });
    const send = vi.spyOn(sessionCore, "runSessionSend").mockResolvedValue({
      status: "rejected",
      messageId: "33333333-3333-4333-8333-333333333333",
      code: "VALIDATION_ERROR",
    });
    const list = vi.spyOn(sessionCore, "runSessionList").mockResolvedValue({ items: [], nextCursor: undefined });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync([
        "node",
        "opentag",
        "session",
        "create",
        "--message",
        "task",
        "--message-id",
        "11111111-1111-4111-8111-111111111111",
      ]);
      await createProgram().parseAsync([
        "node",
        "opentag",
        "session",
        "send",
        "22222222-2222-4222-8222-222222222222",
        "--message",
        "follow-up",
        "--json",
      ]);
      await createProgram().parseAsync(["node", "opentag", "session", "list", "--recursive", "--limit", "5"]);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ message: "task", messageId: expect.any(String) }));
      expect(send).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({ message: "follow-up" }),
      );
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ recursive: true, limit: 5 }));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status":"rejected"'));
      expect(process.exitCode).toBe(1);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode;
      create.mockRestore();
      send.mockRestore();
      list.mockRestore();
    }
  });

  it("renders a stable error when a session request is rejected", async () => {
    const error = new SessionCommandRequestError(
      "44444444-4444-4444-8444-444444444444",
      new client.OpenTagApiError("VALIDATION_ERROR", "validation", "bad request", 400),
    );
    const create = vi.spyOn(sessionCore, "runSessionCreate").mockRejectedValue(error);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "session", "create", "--message", "task", "--json"]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"status":"rejected"'));
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.mockRestore();
      process.exitCode = previousExitCode;
      create.mockRestore();
    }
  });

  it("presents list and generic transport failures through the shared policy", async () => {
    const list = vi.spyOn(sessionCore, "runSessionList").mockResolvedValue({ items: [], nextCursor: undefined });
    const create = vi.spyOn(sessionCore, "runSessionCreate").mockRejectedValue(new Error("connection refused"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "session", "list", "--json"]);
      expect(stdout).toHaveBeenCalledWith('{"ok":true,"result":{"items":[]}}\n');
      list.mockRejectedValueOnce(new Error("connection refused"));
      await createProgram().parseAsync(["node", "opentag", "session", "list", "--json"]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"category":"unavailable"'));
      await createProgram().parseAsync(["node", "opentag", "session", "create", "--message", "task", "--json"]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"category":"unavailable"'));
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
      list.mockRestore();
      create.mockRestore();
    }
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

  it("formats accepted and rejected command results and tabular list rows", () => {
    expect(formatSessionCommandResult({ status: "accepted", messageId: "m1", sessionId: "s1", code: "queued" })).toBe(
      "status=accepted messageId=m1 sessionId=s1 code=queued",
    );
    expect(formatSessionCommandResult({ status: "rejected", messageId: "m2" })).toBe("status=rejected messageId=m2");
    expect(
      formatSessionList({
        items: [
          {
            sessionId: "s1",
            parentSessionId: "11111111-1111-4111-8111-111111111111",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastMessageAt: "2026-01-01T00:00:00.000Z",
            lastDeliveryOutcome: "accepted",
            taskPreview: "line\tone\nline two",
          },
        ],
        nextCursor: "next",
      }),
    ).toContain(
      "s1\t11111111-1111-4111-8111-111111111111\t2026-01-01T00:00:00.000Z\t2026-01-01T00:00:00.000Z\taccepted\tline one line two\nNext cursor: next",
    );
    expect(formatSessionList({ items: [], nextCursor: undefined })).toBe(
      "SESSION ID\tPARENT SESSION\tCREATED\tLAST MESSAGE\tOUTCOME\tTASK",
    );
  });

  it("maps API rejections to the stable rejected request contract", async () => {
    const apiError = new client.OpenTagApiError("VALIDATION_ERROR", "validation", "bad message", 400);
    const error = await requestWithRetryKey("message-rejected", async () => {
      throw apiError;
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SessionCommandRequestError);
    if (!(error instanceof SessionCommandRequestError)) throw error;
    expect(error.status).toBe("rejected");
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.cause).toBe(apiError);
  });

  it("runs create, send, and list inside the managed session context", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-cli-"));
    const proofPath = join(home, "proof.json");
    await writeFile(proofPath, "ignored");
    vi.mocked(client.resolveOpenTagHome).mockReturnValue(home);
    vi.mocked(client.readComputerIdentity).mockResolvedValue({
      version: 2,
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      serverUrl: "https://opentag.example",
    });
    vi.mocked(client.readSessionCliProofFile).mockResolvedValue({
      proofId: "11111111-1111-4111-8111-111111111111",
      token: "p".repeat(40),
    });
    const create = vi.spyOn(OpenTagApi.prototype, "createInternalSession").mockResolvedValue({
      status: "accepted",
      messageId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    const send = vi.spyOn(OpenTagApi.prototype, "sendSessionMessage").mockResolvedValue({
      status: "accepted",
      messageId: "44444444-4444-4444-8444-444444444444",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    const list = vi.spyOn(OpenTagApi.prototype, "listInternalSessions").mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });

    const previousProof = process.env.OPENTAG_SESSION_PROOF_FILE;
    process.env.OPENTAG_SESSION_PROOF_FILE = proofPath;
    try {
      await expect(
        runSessionCreate({
          message: "create task",
          messageId: "22222222-2222-4222-8222-222222222222",
          model: "gpt-5",
          maxDurationMs: 5000,
        }),
      ).resolves.toMatchObject({ sessionId: "33333333-3333-4333-8333-333333333333" });
      await expect(
        runSessionSend("33333333-3333-4333-8333-333333333333", {
          message: "follow up",
          messageId: "44444444-4444-4444-8444-444444444444",
        }),
      ).resolves.toMatchObject({ sessionId: "33333333-3333-4333-8333-333333333333" });
      await expect(
        runSessionList({ recursive: true, limit: 5, cursor: "c", since: "2026-01-01T00:00:00.000Z" }),
      ).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
      expect(create).toHaveBeenCalledWith(
        "p".repeat(40),
        expect.objectContaining({ message: "create task", model: "gpt-5" }),
      );
      expect(send).toHaveBeenCalledWith(
        "p".repeat(40),
        expect.objectContaining({ targetSessionId: "33333333-3333-4333-8333-333333333333" }),
      );
      expect(list).toHaveBeenCalledWith("p".repeat(40), expect.objectContaining({ recursive: true, limit: 5 }));
    } finally {
      if (previousProof === undefined) delete process.env.OPENTAG_SESSION_PROOF_FILE;
      else process.env.OPENTAG_SESSION_PROOF_FILE = previousProof;
      await rm(home, { recursive: true, force: true });
      create.mockRestore();
      send.mockRestore();
      list.mockRestore();
    }
  });

  it("reads message files and rejects missing or empty session context", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-file-"));
    const messageFile = join(home, "message.txt");
    await writeFile(messageFile, "from file");
    const proofPath = join(home, "proof.json");
    vi.mocked(client.resolveOpenTagHome).mockReturnValue(home);
    vi.mocked(client.readComputerIdentity).mockResolvedValue({
      version: 2,
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      serverUrl: "https://opentag.example",
    });
    vi.mocked(client.readSessionCliProofFile).mockResolvedValue({
      proofId: "11111111-1111-4111-8111-111111111111",
      token: "p".repeat(40),
    });
    const create = vi.spyOn(OpenTagApi.prototype, "createInternalSession").mockResolvedValue({
      status: "accepted",
      messageId: "55555555-5555-4555-8555-555555555555",
    });
    const previousProof = process.env.OPENTAG_SESSION_PROOF_FILE;
    process.env.OPENTAG_SESSION_PROOF_FILE = proofPath;
    try {
      await runSessionCreate({ messageFile, messageId: "55555555-5555-4555-8555-555555555555" });
      await expect(runSessionCreate({ message: "both", messageFile })).rejects.toThrow(
        "Exactly one of --message and --message-file is required",
      );
      await expect(runSessionCreate({ message: "" })).rejects.toThrow("Session messages cannot be empty");
    } finally {
      if (previousProof === undefined) delete process.env.OPENTAG_SESSION_PROOF_FILE;
      else process.env.OPENTAG_SESSION_PROOF_FILE = previousProof;
      await rm(home, { recursive: true, force: true });
      create.mockRestore();
    }
  });

  it("fails closed when session proof or Computer binding is absent", async () => {
    const previousProof = process.env.OPENTAG_SESSION_PROOF_FILE;
    delete process.env.OPENTAG_SESSION_PROOF_FILE;
    await expect(runSessionList({})).rejects.toThrow("runtime context missing");
    process.env.OPENTAG_SESSION_PROOF_FILE = "/tmp/session-proof";
    vi.mocked(client.resolveOpenTagHome).mockReturnValue("/tmp/opentag-home");
    vi.mocked(client.readComputerIdentity).mockResolvedValue(undefined);
    await expect(runSessionList({})).rejects.toThrow("Computer binding missing");
    if (previousProof === undefined) delete process.env.OPENTAG_SESSION_PROOF_FILE;
    else process.env.OPENTAG_SESSION_PROOF_FILE = previousProof;
  });

  it("accepts stdin as the message source", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-session-stdin-"));
    const proofPath = join(home, "proof.json");
    vi.mocked(client.resolveOpenTagHome).mockReturnValue(home);
    vi.mocked(client.readComputerIdentity).mockResolvedValue({
      version: 2,
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      serverUrl: "https://opentag.example",
    });
    vi.mocked(client.readSessionCliProofFile).mockResolvedValue({
      proofId: "11111111-1111-4111-8111-111111111111",
      token: "p".repeat(40),
    });
    const create = vi.spyOn(OpenTagApi.prototype, "createInternalSession").mockResolvedValue({
      status: "accepted",
      messageId: "66666666-6666-4666-8666-666666666666",
    });
    const previousProof = process.env.OPENTAG_SESSION_PROOF_FILE;
    const originalIterator = process.stdin[Symbol.asyncIterator];
    process.env.OPENTAG_SESSION_PROOF_FILE = proofPath;
    Object.defineProperty(process.stdin, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield "stdin task";
      },
    });
    try {
      await runSessionCreate({ messageFile: "-", messageId: "66666666-6666-4666-8666-666666666666" });
      expect(create).toHaveBeenCalledWith("p".repeat(40), expect.objectContaining({ message: "stdin task" }));
    } finally {
      Object.defineProperty(process.stdin, Symbol.asyncIterator, { configurable: true, value: originalIterator });
      if (previousProof === undefined) delete process.env.OPENTAG_SESSION_PROOF_FILE;
      else process.env.OPENTAG_SESSION_PROOF_FILE = previousProof;
      await rm(home, { recursive: true, force: true });
      create.mockRestore();
    }
  });
});
