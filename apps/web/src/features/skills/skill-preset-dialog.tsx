import type { SkillPreset, SkillPresetInstallAction } from "@opentag/shared/browser";
import { useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader, Text, Tooltip } from "../../ui/design-system.js";
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
  const showSearch = (catalog.data?.presets.length ?? 0) > 1;
  const showCategories = categories.length > 1;
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
      className={showSearch ? "skill-preset-dialog" : "skill-preset-dialog skill-preset-dialog--single"}
      description={m.skills_preset_description()}
      onClose={onClose}
      title={m.skills_preset_title()}
    >
      <div className="skill-preset-body" data-ui="skill-preset-dialog">
        {showSearch ? (
          <Field htmlFor="skill-preset-search" label={m.skills_preset_search_label()}>
            <KumoInputControl
              id="skill-preset-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={m.skills_preset_search_placeholder()}
              value={query}
            />
          </Field>
        ) : null}
        {showCategories ? (
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
        ) : null}
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
          <ul aria-label={m.skills_preset_list_aria()} className="skill-preset-grid" data-ui="skill-preset-list">
            {visible.map((preset) => (
              <SkillPresetCard
                busy={install.isPending}
                installing={install.isPending && install.variables?.presetName === preset.name}
                key={preset.name}
                onInstall={installPreset}
                preset={preset}
              />
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
  installing,
  onInstall,
}: {
  preset: SkillPreset;
  busy: boolean;
  installing: boolean;
  onInstall: (preset: SkillPreset) => void;
}) {
  const actionable = isSkillPresetActionable(preset.state);
  return (
    <li className="skill-preset-card ui-surface bg-kumo-base" data-ui="skill-preset-card">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <strong className="min-w-0 wrap-anywhere text-base font-semibold">{preset.name}</strong>
        <Button
          aria-label={`${skillPresetActionLabel(preset.state)}: ${preset.name}`}
          disabled={busy || !actionable}
          loading={installing}
          onClick={() => onInstall(preset)}
          size="compact"
          variant={actionable ? "primary" : "secondary"}
          className="shrink-0"
        >
          {skillPresetActionLabel(preset.state)}
        </Button>
      </div>
      <Tooltip
        content={preset.description}
        render={<p className="skill-preset-summary ui-text text-kumo-subtle" data-text-size="sm" />}
      >
        {preset.description}
      </Tooltip>
      {preset.state === "name_conflict" || preset.state === "update_available" ? (
        <Text as="p" size="sm" variant="secondary">
          {skillPresetStateLabel(preset.state)}
        </Text>
      ) : null}
    </li>
  );
}
