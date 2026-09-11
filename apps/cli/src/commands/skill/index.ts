import type { Command } from "commander";
import { executeCommand } from "../../core/command/policy.js";
import {
  formatAgentSkills,
  formatSkillList,
  formatSkillPulled,
  formatSkillPushed,
} from "../../core/skill/formatting.js";
import { runSkillAssign, runSkillDelete, runSkillPush } from "../../core/skill/mutations.js";
import { runSkillList, runSkillPull, runSkillShow } from "../../core/skill/queries.js";

interface JsonOption {
  json?: boolean;
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command("skill")
    .description("Manage the Account's skill library and the skills assigned to each Agent");

  skill
    .command("list")
    .description("List every skill in the Account")
    .option("--json", "print JSON")
    .action(async (options: JsonOption) => {
      process.exitCode = await executeCommand(() => runSkillList(), {
        json: options.json === true,
        formatValue: formatSkillList,
        phase: "request",
      });
    });

  skill
    .command("show <name>")
    .description("Print a skill's SKILL.md")
    .option("--json", "print JSON")
    .action(async (name: string, options: JsonOption) => {
      process.exitCode = await executeCommand(() => runSkillShow(name), {
        json: options.json === true,
        phase: "request",
      });
    });

  skill
    .command("push <dir-or-zip>")
    .description("Publish a skill directory or zip; inside an Agent Session it is assigned to that Agent")
    .option("--replace", "replace an existing skill with the same name")
    .option("--session <session-id>", "the current Session id when running inside an Agent Session")
    .option("--json", "print JSON")
    .action(async (source: string, options: JsonOption & { replace?: boolean; session?: string }) => {
      process.exitCode = await executeCommand(
        () => runSkillPush(source, { replace: options.replace === true, session: options.session }),
        { json: options.json === true, formatValue: formatSkillPushed, phase: "request" },
      );
    });

  skill
    .command("pull <name>")
    .description("Download a skill and unpack it into <out>/<name>")
    .option("--out <dir>", "parent directory for the unpacked skill (default: current directory)")
    .option("--json", "print JSON")
    .action(async (name: string, options: JsonOption & { out?: string }) => {
      process.exitCode = await executeCommand(() => runSkillPull(name, { out: options.out }), {
        json: options.json === true,
        formatValue: formatSkillPulled,
        phase: "request",
      });
    });

  skill
    .command("delete <name>")
    .description("Delete a skill from the Account and unassign it from every Agent")
    .option("--yes", "skip the confirmation prompt")
    .option("--json", "print JSON")
    .action(async (name: string, options: JsonOption & { yes?: boolean }) => {
      process.exitCode = await executeCommand(() => runSkillDelete(name, { yes: options.yes === true }), {
        json: options.json === true,
        phase: "request",
      });
    });

  skill
    .command("assign <agent>")
    .description("Replace the skills assigned to an Agent (by id or name)")
    .requiredOption("--set <names...>", "the complete set of skill names to assign; pass none to clear")
    .option("--json", "print JSON")
    .action(async (agent: string, options: JsonOption & { set: string[] }) => {
      process.exitCode = await executeCommand(() => runSkillAssign(agent, { set: options.set }), {
        json: options.json === true,
        formatValue: formatAgentSkills,
        phase: "request",
      });
    });
}
