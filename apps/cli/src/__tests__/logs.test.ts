import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { formatLogs, runLogs } from "../core/diagnostics/logs.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("opentag logs", () => {
  it("bundles current and rotated client logs with a safe environment summary", async () => {
    const home = await temporaryHome();
    const logs = join(home, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "client.log"), '{"token":"access-secret","message":"current"}\n');
    await writeFile(join(logs, "client.log.1"), '{"authorization":"Bearer old-secret","message":"rotated"}\n');
    await writeFile(join(logs, "client.log.ignore"), "must not be included\n");

    const result = await runLogs({
      environment: {
        NODE_ENV: "test",
        OPENTAG_HOME: home,
        OPENTAG_LOG_LEVEL: "info",
        OPENTAG_SERVER_URL: "https://opentag.example",
      },
      home,
    });
    const output = formatLogs(result);
    expect(result.files.map((file) => file.name)).toEqual(["client.log", "client.log.1"]);
    expect(output).toContain("current");
    expect(output).toContain("rotated");
    expect(output).not.toContain("access-secret");
    expect(output).not.toContain("old-secret");
    expect(output).not.toContain("must not be included");
  });

  it("registers a JSON logs command that writes one redacted envelope", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, "logs"), { recursive: true });
    await writeFile(join(home, "logs", "client.log"), "Authorization: Bearer command-secret\n");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "logs", "--home", home, "--json"]);
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(JSON.parse(output)).toMatchObject({ ok: true, result: { files: [{ name: "client.log" }] } });
      expect(output).not.toContain("command-secret");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      stdout.mockRestore();
    }
  });

  it("treats a missing log directory as an empty bundle", async () => {
    const home = await temporaryHome();
    await expect(runLogs({ home })).resolves.toMatchObject({ files: [] });
  });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-cli-logs-"));
  directories.push(home);
  return home;
}
