import type { Skill } from "@opentag/shared/browser";
import { DownloadSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, DropdownMenu, Icon, Switch, Text, Tooltip } from "../../ui/design-system.js";
import { skillErrorMessage } from "./skills-page-model.js";
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
  onViewDetails,
  skill,
  storageAvailable,
}: {
  downloadUrl: string;
  onDelete: (skill: Skill) => void;
  onViewDetails: (skill: Skill, trigger: HTMLElement) => void;
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
    <li className="skill-row min-w-0 p-4" data-ui="skill-row">
      <Text as="h2" title={skill.name} variant="heading" DANGEROUS_className="min-w-0 truncate">
        <Button
          aria-label={m.skills_details_open({ name: skill.name })}
          className="max-w-full justify-start text-left"
          variant="inline"
          onClick={(event) => onViewDetails(skill, event.currentTarget)}
        >
          <span className="truncate">{skill.name}</span>
        </Button>
      </Text>
      <div className="skill-row-controls flex shrink-0 items-center gap-3">
        <Switch
          aria-label={m.skills_toggle_label({ name: skill.name })}
          checked={skill.enabled}
          disabled={update.isPending}
          onCheckedChange={(next) => void toggle(next)}
          transitioning={update.isPending}
        />
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                aria-label={m.skills_more_actions({ name: skill.name })}
                shape="square"
                size="compact"
                variant="ghost"
              />
            }
          >
            <Icon name="more-vertical" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {storageAvailable ? (
              <DropdownMenu.LinkItem
                closeOnClick
                href={downloadUrl}
                icon={DownloadSimple}
                render={<a href={downloadUrl} download={`${skill.name}.tar.gz`} />}
              >
                {m.skills_download_action()}
              </DropdownMenu.LinkItem>
            ) : (
              <DropdownMenu.Item disabled icon={DownloadSimple} title={m.skills_error_storage_unavailable()}>
                {m.skills_download_action()}
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              disabled={update.isPending}
              icon={Trash}
              onClick={() => onDelete(skill)}
              variant="danger"
            >
              {m.skills_delete_action()}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      <Tooltip
        content={skill.description}
        render={<p className="skill-row-description ui-text text-kumo-subtle" data-text-size="sm" />}
      >
        {skill.description}
      </Tooltip>
      {error ? (
        <div className="col-span-2 mt-2">
          <Banner variant="error">{error}</Banner>
        </div>
      ) : null}
    </li>
  );
}
