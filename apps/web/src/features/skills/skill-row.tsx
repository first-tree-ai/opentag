import type { Skill } from "@opentag/shared/browser";
import { ApiError } from "../../api.js";
import { formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Badge, Button, buttonClassName, Switch, Text } from "../../ui/design-system.js";
import { formatArchiveBytes, skillErrorMessage, skillSourceLabel } from "./skills-page-model.js";
import { useUpdateSkill } from "./skills-queries.js";

/**
 * One Skill as a row.
 *
 * The switch writes immediately rather than waiting for a Save, so it reports its own failure back
 * to the page instead of swallowing it; the delete action is a dialog, not an inline button, because
 * removing a Skill deletes its stored archive and cannot be undone.
 */
export function SkillRow({
  downloadUrl,
  onDelete,
  onError,
  skill,
  storageAvailable,
}: {
  downloadUrl: string;
  onDelete: (skill: Skill) => void;
  onError: (message: string | undefined) => void;
  skill: Skill;
  storageAvailable: boolean;
}) {
  // The write carries the row's own Agent id, not the page's current prop, so a row rendered for one
  // Agent can never be written through a mutation that belongs to another.
  const update = useUpdateSkill();

  const toggle = async (enabled: boolean) => {
    onError(undefined);
    try {
      await update.mutateAsync({ agentId: skill.agentId, skillId: skill.id, enabled });
    } catch (cause) {
      onError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  return (
    <li className="grid gap-3 rounded-lg border border-kumo-line p-4" data-ui="skill-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Text as="h3" variant="heading">
              {skill.name}
            </Text>
            <Badge variant="neutral">{skillSourceLabel(skill.source)}</Badge>
          </div>
          <Text as="p" variant="secondary">
            {skill.description}
          </Text>
          <Text as="p" size="sm" variant="secondary">
            {`${formatArchiveBytes(skill.archiveBytes)} · ${m.skills_file_count({ count: skill.fileCount })} · ${m.skills_updated({ time: formatRelativeTime(skill.updatedAt) })}`}
          </Text>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Switch
            aria-label={m.skills_toggle_label({ name: skill.name })}
            checked={skill.enabled}
            disabled={update.isPending}
            onCheckedChange={(next) => void toggle(next)}
            transitioning={update.isPending}
          />
          {storageAvailable ? (
            /*
             * The bundle is the canonical `tar.gz` the Server stores. Naming the file after the
             * Skill alone produced an extensionless download that this page's own upload pre-check
             * rejected (`unsupported_format`), so a downloaded bundle could never be re-uploaded.
             */
            <a
              className={buttonClassName({ size: "compact", variant: "secondary" })}
              download={`${skill.name}.tar.gz`}
              href={downloadUrl}
            >
              {m.skills_download()}
            </a>
          ) : null}
          <Button onClick={() => onDelete(skill)} size="compact" variant="ghost">
            {m.skills_delete()}
          </Button>
        </div>
      </div>
    </li>
  );
}
