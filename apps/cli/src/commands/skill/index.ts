import type { Command } from "commander";
import { executeCommand } from "../../core/command/policy.js";
import {
  runSkillList,
  runSkillPull,
  runSkillPush,
  runSkillRemove,
  runSkillSetEnabled,
} from "../../core/skill/operations.js";
import {
  formatSkill,
  formatSkillEnabled,
  formatSkillList,
  formatSkillPull,
  formatSkillRemoval,
} from "../../core/skill/shared.js";

/**
 * `skill` — the Agent's own Skills.
 *
 * Inside a managed Session the Agent may push, list, and pull its own Skills; outside one an
 * operator names an Agent with `--agent`. `context.ts` enforces both, so `--agent` is optional here
 * and rejected only when a Session proof is present.
 */
export function registerSkillCommand(program: Command): void {
  const skill = program.command("skill").description("Manage an Agent's Agent Skills");

  skill
    .command("push <dir>")
    .description("Upload a local skill directory (requires SKILL.md); adopts it if it is the Skill's target")
    .option("--agent <agent-id>", "the Agent that owns the Skill, as an Account operator")
    .option("--replace", "replace an existing Skill with the same name")
    .option("--json", "print JSON")
    .action(async (dir: string, options: { agent?: string; replace?: boolean; json?: boolean }) => {
      process.exitCode = await executeCommand(
        () =>
          runSkillPush(dir, {
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
            ...(options.replace === true ? { replace: true } : {}),
          }),
        { json: options.json === true, formatValue: formatSkill, phase: "request" },
      );
    });

  skill
    .command("list")
    .description("List the Agent's Skills")
    .option("--agent <agent-id>", "the Agent whose Skills to list, as an Account operator")
    .option("--json", "print JSON")
    .action(async (options: { agent?: string; json?: boolean }) => {
      process.exitCode = await executeCommand(
        () => runSkillList(options.agent === undefined ? {} : { agentId: options.agent }),
        { json: options.json === true, formatValue: formatSkillList, phase: "request" },
      );
    });

  skill
    .command("pull <name>")
    .description("Download a Skill into an empty directory")
    .option("--agent <agent-id>", "the Agent that owns the Skill, as an Account operator")
    .option("--out <dir>", "destination directory; defaults to <name> under the current directory")
    .option("--json", "print JSON")
    .action(async (name: string, options: { agent?: string; out?: string; json?: boolean }) => {
      process.exitCode = await executeCommand(
        () =>
          runSkillPull(name, {
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
            ...(options.out === undefined ? {} : { outDir: options.out }),
          }),
        { json: options.json === true, formatValue: formatSkillPull, phase: "request" },
      );
    });

  skill
    .command("remove <name>")
    .description("Delete a Skill; an Account operator may do this, an Agent may not")
    .option("--agent <agent-id>", "the Agent that owns the Skill, as an Account operator")
    .option("--json", "print JSON")
    .action(async (name: string, options: { agent?: string; json?: boolean }) => {
      process.exitCode = await executeCommand(
        () => runSkillRemove(name, options.agent === undefined ? {} : { agentId: options.agent }),
        { json: options.json === true, formatValue: formatSkillRemoval, phase: "request" },
      );
    });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    skill
      .command(`${name} <name>`)
      .description(enabled ? "Enable a Skill for its Agent" : "Disable a Skill, keeping it stored")
      .option("--agent <agent-id>", "the Agent that owns the Skill, as an Account operator")
      .option("--json", "print JSON")
      .action(async (skillName: string, options: { agent?: string; json?: boolean }) => {
        process.exitCode = await executeCommand(
          () => runSkillSetEnabled(skillName, enabled, options.agent === undefined ? {} : { agentId: options.agent }),
          { json: options.json === true, formatValue: formatSkillEnabled, phase: "request" },
        );
      });
  }
}
