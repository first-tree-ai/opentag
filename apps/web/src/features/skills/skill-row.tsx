import type { Skill } from "@opentag/shared/browser";
import { Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Icon, Switch, Text, Tooltip } from "../../ui/design-system.js";
import { skillErrorMessage } from "./skills-page-model.js";
import { useUpdateSkill } from "./skills-queries.js";

/**
 * One Skill as a row.
 *
 * The switch writes immediately rather than waiting for a Save, so failures stay beside that Skill;
 * the inline delete button opens confirmation because removing a Skill deletes its stored archive
 * and cannot be undone.
 */
export function SkillRow({
  onDelete,
  onViewDetails,
  skill,
}: {
  onDelete: (skill: Skill, trigger: HTMLButtonElement) => void;
  onViewDetails: (skill: Skill, trigger: HTMLElement) => void;
  skill: Skill;
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
    <li className="skill-row min-w-0 p-4" data-ui="skill-row">
      <div className="skill-row-content min-w-0 rounded-md hover:bg-kumo-tint">
        <Text as="h2" variant="heading" DANGEROUS_className="min-w-0 truncate">
          <Button
            aria-label={m.skills_details_open({ name: skill.name })}
            aria-haspopup="dialog"
            className="skill-row-open max-w-full justify-start text-left"
            variant="inline"
            onClick={(event) => onViewDetails(skill, event.currentTarget)}
          >
            <span className="truncate">{skill.name}</span>
          </Button>
        </Text>
        <p className="skill-row-description ui-text text-kumo-subtle" data-text-size="sm">
          {skill.description}
        </p>
        <Icon name="chevron-right" className="skill-row-chevron text-kumo-subtle" />
      </div>
      <div className="skill-row-controls flex shrink-0 items-center gap-2">
        <Switch
          className="skill-row-toggle"
          aria-label={m.skills_toggle_label({ name: skill.name })}
          checked={skill.enabled}
          disabled={update.isPending}
          onCheckedChange={(next) => void toggle(next)}
          transitioning={update.isPending}
        />
        <Tooltip
          content={m.skills_delete_action()}
          render={
            <Button
              aria-label={m.skills_delete_label({ name: skill.name })}
              aria-haspopup="dialog"
              className="text-kumo-subtle hover:text-kumo-danger focus-visible:text-kumo-danger"
              data-ui="skill-delete"
              disabled={update.isPending}
              shape="square"
              size="compact"
              variant="ghost"
              onClick={(event) => onDelete(skill, event.currentTarget)}
            >
              <Trash aria-hidden="true" className="size-4" />
            </Button>
          }
        />
      </div>
      {error ? (
        <div className="col-span-2 mt-2">
          <Banner variant="error">{error}</Banner>
        </div>
      ) : null}
    </li>
  );
}
