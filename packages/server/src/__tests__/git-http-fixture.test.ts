import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startGitRepositoryFixture } from "./support/git-http-fixture.js";

vi.mock("node:child_process", { spy: true });

afterEach(() => vi.clearAllMocks());

const successfulCgi = 'process.stdout.write("Status: 200 OK" + String.fromCharCode(13, 10, 13, 10) + "ok")';

describe("Git HTTP fixture", () => {
  it("returns an early CGI rejection even when the backend closes stdin before reading the body", async () => {
    const fixture = await startGitRepositoryFixture({ files: { "README.md": "test" } });
    try {
      const discoveryUrl = `${fixture.url}/info/refs?service=git-upload-pack`;
      const rejected = await fetch(discoveryUrl, {
        method: "POST",
        body: Buffer.alloc(4 * 1024 * 1024, 0x61),
      });
      expect(rejected.status).toBe(405);
      await rejected.arrayBuffer();

      const discovery = await fetch(discoveryUrl);
      expect(discovery.status).toBe(200);
      expect(await discovery.text()).toContain("# service=git-upload-pack");
    } finally {
      await fixture.close();
    }
  });

  it.each(["spawn failure", "nonzero exit", "missing CGI document"])("reports %s as HTTP 500", async (failure) => {
    const fixture = await startGitRepositoryFixture({ files: { "README.md": "test" } });
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    vi.mocked(childProcess.spawn).mockImplementationOnce(() =>
      failure === "spawn failure"
        ? spawn(`${fixture.root}/missing-git-backend`, [])
        : spawn(process.execPath, [
            "-e",
            failure === "nonzero exit" ? `${successfulCgi}; process.exitCode = 1` : "process.exit(0)",
          ]),
    );
    try {
      const response = await fetch(`${fixture.url}/info/refs?service=git-upload-pack`);
      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/Git backend/);
    } finally {
      await fixture.close();
    }
  });

  it("reports unexpected stdin failures even when the backend returns a successful CGI document", async () => {
    const fixture = await startGitRepositoryFixture({ files: { "README.md": "test" } });
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      const child = spawn(process.execPath, ["-e", successfulCgi]);
      queueMicrotask(() => child.stdin.destroy(Object.assign(new Error("input failed"), { code: "EIO" })));
      return child;
    });
    try {
      const response = await fetch(`${fixture.url}/info/refs?service=git-upload-pack`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Git backend failed");
    } finally {
      await fixture.close();
    }
  });
});
