import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerSlackCommands } from "../commands/slack.js";
import { runSlackManagement } from "../core/slack-management.js";

vi.mock("../core/slack-management.js", async (original) => ({
  ...(await original<typeof import("../core/slack-management.js")>()),
  runSlackManagement: vi.fn().mockResolvedValue(0),
}));

afterEach(() => {
  process.exitCode = 0;
  vi.clearAllMocks();
});

it.each(["--help", "-h"])(
  "passes native api %s through the actual command entry without requiring Team or output",
  async (flag) => {
    const program = new Command().name("opentag").exitOverride();
    registerSlackCommands(program);
    await program.parseAsync(["node", "opentag", "slack", "manage", "--", "api", flag]);
    expect(runSlackManagement).toHaveBeenCalledExactlyOnceWith(["api", flag], {});
  },
);
