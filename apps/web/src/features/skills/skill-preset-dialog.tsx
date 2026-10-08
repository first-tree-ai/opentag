import type { SkillPreset, SkillPresetInstallAction } from "@opentag/shared/browser";
import { useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader, Text } from "../../ui/design-system.js";
import {
  isSkillPresetActionable,
  skillErrorMessage,
  skillPresetActionLabel,
  skillPresetActionMessage,
  skillPresetCategoryLabel,
  skillPresetStateLabel,
} from "./skills-page-model.js";
import { useInstallSkillPreset, useSkillPresets } from "./skills-queries.js";

/**
 * The preset catalog: what the platform ships, and how each entry relates to this Agent.
 *
 * The Server computes the state, so this dialog only renders it and never joins the catalog against
 * the Skills list itself. The one write is a named install, and its result is reported from the
 * action the Server took rather than assumed: a repeat install answers `unchanged`.
 *
 * Search spans the whole catalog and temporarily overrides the category tabs, matching how the MCP
 * Discover surface treats search — a query should never be silently filtered by a tab the user
 * forgot was active.
 */
export function SkillPresetDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const catalog = useSkillPresets(agentId);
  const install = useInstallSkillPreset();
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();
  const [lastAction, setLastAction] = useState<{ name: string; action: SkillPresetInstallAction } | undefined>();

  const categories = catalog.data?.categories ?? [];
  const searching = query.trim().length > 0;
  const activeCategory = categoryId ?? categories[0]?.id;
  const visible = (catalog.data?.presets ?? []).filter((preset) =>
    searching ? matchesPreset(preset, query) : preset.category === activeCategory,
  );

  const installPreset = async (preset: SkillPreset) => {
    setError(undefined);
    setLastAction(undefined);
    try {
      const result = await install.mutateAsync({ agentId, presetName: preset.name });
      setLastAction({ name: preset.name, action: result.action });
    } catch (cause) {
      setError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  return (
    <Dialog
      busy={install.isPending}
      className="w-[min(90vw,44rem)]"
      description={m.skills_preset_description()}
      onClose={onClose}
      title={m.skills_preset_title()}
    >
      <div className="grid gap-4" data-ui="skill-preset-dialog">
        <Field htmlFor="skill-preset-search" label={m.skills_preset_search_label()}>
          <KumoInputControl
            id="skill-preset-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={m.skills_preset_search_placeholder()}
            value={query}
          />
        </Field>
        <fieldset className="flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">{m.skills_preset_title()}</legend>
          {categories.map((category) => {
            const active = !searching && category.id === activeCategory;
            return (
              <Button
                aria-pressed={active}
                key={category.id}
                onClick={() => {
                  setQuery("");
                  setCategoryId(category.id);
                }}
                size="compact"
                variant={active ? "secondary" : "ghost"}
              >
                {skillPresetCategoryLabel(category.id)}
              </Button>
            );
          })}
        </fieldset>
        {error === undefined ? null : <Banner variant="error">{error}</Banner>}
        {lastAction === undefined ? null : (
          <Text as="p" role="status" size="sm" variant="secondary">
            {m.skills_preset_result({
              name: lastAction.name,
              result: skillPresetActionMessage(lastAction.action),
            })}
          </Text>
        )}
        {catalog.isPending ? (
          <div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
            <span aria-hidden="true">
              <Loader size="sm" />
            </span>
            {m.common_loading()}
          </div>
        ) : null}
        {catalog.isError ? <Banner variant="alert">{m.skills_preset_load_failed()}</Banner> : null}
        {catalog.data !== undefined && visible.length === 0 ? (
          <Text as="p" size="sm" variant="secondary">
            {m.skills_preset_empty()}
          </Text>
        ) : null}
        {visible.length === 0 ? null : (
          <ul
            aria-label={m.skills_preset_list_aria()}
            className="ui-surface max-h-[min(50vh,22rem)] divide-y divide-kumo-line overflow-y-auto bg-kumo-base"
            data-ui="skill-preset-list"
          >
            {visible.map((preset) => (
              <SkillPresetCard busy={install.isPending} key={preset.name} onInstall={installPreset} preset={preset} />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function matchesPreset(preset: SkillPreset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return preset.name.toLowerCase().includes(needle) || preset.description.toLowerCase().includes(needle);
}

/** One catalog card: what the preset is, what this Agent's state is, and the one action allowed. */
function SkillPresetCard({
  preset,
  busy,
  onInstall,
}: {
  preset: SkillPreset;
  busy: boolean;
  onInstall: (preset: SkillPreset) => void;
}) {
  const actionable = isSkillPresetActionable(preset.state);
  return (
    <li className="flex items-start justify-between gap-3 p-3" data-ui="skill-preset-card">
      <div className="grid min-w-0 gap-1">
        <strong className="text-sm font-medium">{preset.name}</strong>
        <Text as="p" size="sm" variant="secondary">
          {preset.description}
        </Text>
        <Text as="p" size="sm" variant="secondary">
          {skillPresetStateLabel(preset.state)}
        </Text>
      </div>
      <Button
        aria-label={`${skillPresetActionLabel(preset.state)}: ${preset.name}`}
        disabled={busy || !actionable}
        onClick={() => onInstall(preset)}
        size="compact"
        variant={actionable ? "primary" : "secondary"}
      >
        {skillPresetActionLabel(preset.state)}
      </Button>
    </li>
  );
}
