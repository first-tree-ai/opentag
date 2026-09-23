import type { Skill } from "@opentag/shared/browser";
import { useState } from "react";
import { ApiError } from "../../api.js";
import { formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Badge, Banner, Button, buttonClassName, Switch, Text } from "../../ui/design-system.js";
import { formatArchiveBytes, skillErrorMessage, skillSourceLabel } from "./skills-page-model.js";
import { useUpdateSkill } from "./skills-queries.js";

/**
 * One Skill as a row.
 *
 * The switch writes immediately rather than waiting for a Save, so failures stay beside that Skill;
 * the delete action is a dialog, not an inline button, because
 * removing a Skill deletes its stored archive and cannot be undone.
 */
export function SkillRow({
  downloadUrl,
  onDelete,
  skill,
  storageAvailable,
}: {
  downloadUrl: string;
  onDelete: (skill: Skill) => void;
  skill: Skill;
  storageAvailable: boolean;
}) {
  // The write carries the row's own Agent id, not the page's current prop, so a row rendered for one
  // Agent can never be written through a mutation that belongs to another.
  const update = useUpdateSkill();
  const [error, setError] = useState<string>();

  const toggle = async (enabled: boolean) => {
    if (update.isPending) return;
    setError(undefined);
    try {
      await update.mutateAsync({ agentId: skill.agentId, skillId: skill.id, enabled });
    } catch (cause) {
      setError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  return (
    <li className="grid gap-3 rounded-lg border border-kumo-line p-4" data-ui="skill-row">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2">
        <div className="min-w-0 wrap-anywhere">
          <Text as="h2" variant="heading">
            {skill.name}
          </Text>
        </div>
        <Switch
          aria-label={m.skills_toggle_label({ name: skill.name })}
          checked={skill.enabled}
          disabled={update.isPending}
          onCheckedChange={(next) => void toggle(next)}
          transitioning={update.isPending}
        />
        <div className="col-span-2 min-w-0 wrap-anywhere">
          <Text as="p" variant="secondary">
            {skill.description}
          </Text>
        </div>
      </div>
      <div className="grid gap-3 @min-[44rem]/content:grid-cols-[minmax(0,1fr)_auto] @min-[44rem]/content:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="outline">{skillSourceLabel(skill.source)}</Badge>
          <Text as="p" size="sm" variant="secondary">
            {`${formatArchiveBytes(skill.archiveBytes)} · ${m.skills_file_count({ count: skill.fileCount })} · ${m.skills_updated({ time: formatRelativeTime(skill.updatedAt) })}`}
          </Text>
        </div>
        <div className="flex items-center gap-2" data-ui="skill-actions">
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
          <Button
            disabled={update.isPending}
            onClick={() => onDelete(skill)}
            size="compact"
            variant="secondary-destructive"
          >
            {m.skills_delete()}
          </Button>
        </div>
      </div>
      {error ? <Banner variant="error">{error}</Banner> : null}
    </li>
  );
}
