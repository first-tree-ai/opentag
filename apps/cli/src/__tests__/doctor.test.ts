import type { AgentRuntimeCliInstallation, StoredMachineCredentials } from "@opentag/client";
import { ServerHealthNetworkError } from "@opentag/client";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { runDoctor } from "../core/diagnostics/doctor.js";

const COMPUTER_ID = "00000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "00000000-0000-4000-8000-000000000002";

function credentials(...serverUrls: string[]): StoredMachineCredentials {
  return {
    version: 1,
    enrollments: serverUrls.map((serverUrl, index) => ({
      computerId: COMPUTER_ID,
      machineToken: `otmc_fixture-${index}`,
      serverUrl,
      workspaceComputerId: index === 0 ? ENROLLMENT_ID : `00000000-0000-4000-8000-00000000000${index + 2}`,
    })),
  };
}

function runtimes(codex: boolean, claudeCode: boolean): AgentRuntimeCliInstallation[] {
  return [
    {
      provider: "codex",
      displayName: "Codex CLI",
      installed: codex,
      ...(codex ? { path: "/opt/codex", source: "path" as const } : {}),
    },
    {
      provider: "claude-code",
      displayName: "Claude Code CLI",
      installed: claudeCode,
      ...(claudeCode ? { path: "/opt/claude", source: "well-known" as const } : {}),
    },
  ];
}

describe("doctor command contract", () => {
  it("does not expose a Server URL selector", () => {
    const doctor = createProgram().commands.find((command) => command.name() === "doctor");
    expect(doctor?.options.map((option) => option.long)).not.toContain("--server-url");
  });
});

describe("runDoctor", () => {
  it("checks the enrolled Server and reports install-only Agent Runtime facts", async () => {
    const healthChecker = vi.fn().mockResolvedValue({ status: "ok", service: "opentag-server" } as const);

    const result = await runDoctor({
      env: { OPENTAG_SERVER_URL: "https://ignored.example" },
      healthChecker,
      home: "/configured-home",
      readCredentials: async (home) => {
        expect(home).toBe("/configured-home");
        return credentials("https://operator:secret@enrolled.example/private");
      },
      probeRuntimeInstallations: async () => runtimes(true, false),
    });

    expect(result.exitCode).toBe(0);
    expect(healthChecker).toHaveBeenCalledWith("https://operator:secret@enrolled.example/private");
    expect(healthChecker).not.toHaveBeenCalledWith("https://ignored.example");
    expect(result.message).toContain("healthy (opentag-server) at https://enrolled.example");
    expect(result.message).not.toContain("secret");
    expect(result.message).toContain("✓ Agent Runtime CLI: Codex CLI installed");
    expect(result.message).toContain("- Claude Code CLI: not installed");
    expect(result.message).toContain("Agent Runtime authentication was not checked.");
    expect(result.message).toContain("Integration CLI availability was not checked.");
  });

  it("fails closed when this computer has no configured enrollment", async () => {
    const healthChecker = vi.fn();
    const result = await runDoctor({
      healthChecker,
      readCredentials: async () => undefined,
      probeRuntimeInstallations: async () => runtimes(true, false),
    });

    expect(result.exitCode).toBe(1);
    expect(healthChecker).not.toHaveBeenCalled();
    expect(result.message).toContain("✗ OpenTag server: not configured");
  });

  it("checks every distinct enrolled Server exactly once", async () => {
    const healthChecker = vi.fn().mockResolvedValue({ status: "ok", service: "opentag-server" } as const);
    const result = await runDoctor({
      healthChecker,
      readCredentials: async () => credentials("https://two.example", "https://one.example", "https://two.example"),
      probeRuntimeInstallations: async () => runtimes(false, true),
    });

    expect(result.exitCode).toBe(0);
    expect(healthChecker.mock.calls.map(([url]) => url)).toEqual(["https://one.example", "https://two.example"]);
  });

  it("categorizes a configured Server network failure", async () => {
    const result = await runDoctor({
      healthChecker: async () => {
        throw new ServerHealthNetworkError("offline");
      },
      readCredentials: async () => credentials("https://offline.example"),
      probeRuntimeInstallations: async () => runtimes(true, true),
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("✗ OpenTag server: unreachable at https://offline.example");
  });

  it("requires at least one supported Agent Runtime CLI without requiring both", async () => {
    const result = await runDoctor({
      healthChecker: async () => ({ status: "ok", service: "opentag-server" }),
      readCredentials: async () => credentials("https://server.example"),
      probeRuntimeInstallations: async () => runtimes(false, false),
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("✗ Agent Runtime CLI: no supported Agent Runtime CLI is installed");
  });

  it("reports credential and installation detector failures without hiding the other section", async () => {
    const result = await runDoctor({
      readCredentials: async () => {
        throw new Error("invalid credential file");
      },
      probeRuntimeInstallations: async () => {
        throw new Error("probe failed");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("cannot read this computer's enrollment (invalid credential file)");
    expect(result.message).toContain("installation detection failed (probe failed)");
  });
});
