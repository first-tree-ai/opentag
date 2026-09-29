import { type Command, Option } from "commander";
import {
  formatAgentSchedule,
  formatAgentScheduleList,
  formatAgentSchedulePreview,
  runAgentSelfScheduleCreate,
  runAgentSelfScheduleDelete,
  runAgentSelfScheduleList,
  runAgentSelfSchedulePause,
  runAgentSelfSchedulePreview,
  runAgentSelfScheduleResume,
  runAgentSelfScheduleShow,
  runAgentSelfScheduleUpdate,
} from "../../core/agent/self-schedule.js";
import { executeCommand } from "../../core/command/policy.js";

interface ScheduleOptions {
  at?: string;
  cron?: string;
  cursor?: string;
  every?: string;
  json?: boolean;
  limit?: string;
  name?: string;
  prompt?: string;
  promptFile?: string;
  timezone?: string;
}

function addRuleOptions(command: Command): Command {
  return command
    .addOption(new Option("--at <iso>", "absolute instant with UTC offset").conflicts(["every", "cron"]))
    .addOption(new Option("--every <seconds>", "fixed interval, at least 60 seconds").conflicts(["at", "cron"]))
    .addOption(new Option("--cron <expression>", "five-field cron expression").conflicts(["at", "every"]));
}

function addPromptOptions(command: Command): Command {
  return command
    .addOption(new Option("--prompt <text>", "full task prompt").conflicts("promptFile"))
    .addOption(new Option("--prompt-file <path>", "read the exact UTF-8 task prompt").conflicts("prompt"));
}

export function registerAgentSelfScheduleCommands(self: Command): void {
  const schedule = self.command("schedule").description("Manage this Agent's schedules for a fixed IM Chat or thread");

  addRuleOptions(
    addPromptOptions(schedule.command("create").description("Create a schedule for this Session's visible IM target")),
  )
    .requiredOption("--name <name>", "schedule name")
    .requiredOption("--timezone <iana>", "IANA timezone")
    .option("--json", "print JSON")
    .action(async (options: ScheduleOptions) => {
      process.exitCode = await executeCommand(
        () => {
          if (options.name === undefined || options.timezone === undefined) {
            throw new Error("--name and --timezone are required");
          }
          return runAgentSelfScheduleCreate({ ...options, name: options.name, timezone: options.timezone });
        },
        { json: options.json === true, formatValue: formatAgentSchedule, phase: "request" },
      );
    });

  schedule
    .command("list")
    .description("List this Agent's schedules without full prompts")
    .option("--limit <n>", "page size (1-100)")
    .option("--cursor <cursor>", "page cursor")
    .option("--json", "print JSON")
    .action(async (options: ScheduleOptions) => {
      process.exitCode = await executeCommand(() => runAgentSelfScheduleList(options), {
        json: options.json === true,
        formatValue: formatAgentScheduleList,
        phase: "request",
      });
    });

  schedule
    .command("show <id>")
    .description("Show a schedule and its full prompt")
    .option("--json", "print JSON")
    .action(async (id: string, options: ScheduleOptions) => {
      process.exitCode = await executeCommand(() => runAgentSelfScheduleShow(id), {
        json: options.json === true,
        formatValue: formatAgentSchedule,
        phase: "request",
      });
    });

  addRuleOptions(
    addPromptOptions(schedule.command("update <id>").description("Change a name, prompt, rule, or timezone")),
  )
    .option("--name <name>", "new schedule name")
    .option("--timezone <iana>", "new IANA timezone")
    .option("--json", "print JSON")
    .action(async (id: string, options: ScheduleOptions) => {
      process.exitCode = await executeCommand(() => runAgentSelfScheduleUpdate(id, options), {
        json: options.json === true,
        formatValue: formatAgentSchedule,
        phase: "request",
      });
    });

  for (const [name, action] of [
    ["pause", runAgentSelfSchedulePause],
    ["resume", runAgentSelfScheduleResume],
  ] as const) {
    schedule
      .command(`${name} <id>`)
      .description(`${name === "pause" ? "Pause" : "Resume"} a schedule`)
      .option("--json", "print JSON")
      .action(async (id: string, options: ScheduleOptions) => {
        process.exitCode = await executeCommand(() => action(id), {
          json: options.json === true,
          formatValue: formatAgentSchedule,
          phase: "request",
        });
      });
  }

  schedule
    .command("delete <id>")
    .description("Delete a schedule")
    .option("--json", "print JSON")
    .action(async (id: string, options: ScheduleOptions) => {
      process.exitCode = await executeCommand(() => runAgentSelfScheduleDelete(id), {
        json: options.json === true,
        formatValue: (result) => `Deleted ${result.scheduleId}`,
        phase: "request",
      });
    });

  addRuleOptions(
    schedule.command("preview [id]").description("Preview the next five occurrences of a stored or proposed rule"),
  )
    .option("--timezone <iana>", "IANA timezone for a proposed rule")
    .option("--json", "print JSON")
    .action(async (id: string | undefined, options: ScheduleOptions) => {
      process.exitCode = await executeCommand(() => runAgentSelfSchedulePreview({ ...options, scheduleId: id }), {
        json: options.json === true,
        formatValue: formatAgentSchedulePreview,
        phase: "request",
      });
    });
}
