import { useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Tooltip } from "../../../ui/design-system.js";
import { OpenTagLogo } from "../../../ui/opentag-logo.js";
import { soulPresets } from "./soul-presets.js";

export function SoulPresetSelector({
  disabled,
  id,
  value,
  onValueChange,
}: {
  disabled: boolean;
  id: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [previousDraft, setPreviousDraft] = useState<{ value: string; preset: string }>();
  const canUndo = previousDraft && value === previousDraft.preset;
  const choices = soulPresets();
  const scratch = choices[5];

  function choose(preset: (typeof choices)[number]) {
    if (value === preset.instructions) {
      if (preset.id === "scratch") onValueChange("");
      return;
    }
    setPreviousDraft({ value, preset: preset.instructions });
    onValueChange(preset.instructions);
  }

  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium" id={`${id}-presets-label`}>
        {m.agent_settings_soul_presets_title()}
      </p>
      <fieldset
        aria-describedby={`${id}-presets-help`}
        aria-labelledby={`${id}-presets-label`}
        className="grid min-w-0 grid-cols-1 gap-px overflow-hidden rounded-lg border border-kumo-line bg-kumo-line p-0 sm:grid-cols-2 xl:grid-cols-6"
      >
        {choices
          .filter((preset) => preset.id !== "scratch")
          .map((preset) => (
            <Button
              aria-pressed={value === preset.instructions}
              className="h-auto! min-h-12 w-full! min-w-0 justify-start rounded-none! bg-kumo-base px-3 py-2 text-left text-sm font-medium whitespace-normal transition-colors hover:bg-kumo-tint focus-visible:z-10 disabled:opacity-50 aria-pressed:bg-(--brand-soft) aria-pressed:text-kumo-brand"
              disabled={disabled}
              key={preset.id}
              type="button"
              variant="ghost"
              onClick={() => choose(preset)}
            >
              <span className="flex items-center gap-2">
                <img alt="" className="size-5 shrink-0 object-contain" height={20} src={preset.avatarPath} width={20} />
                <span>{preset.title}</span>
              </span>
            </Button>
          ))}
        <Tooltip
          content={m.agent_settings_soul_preset_scratch_help()}
          render={
            <Button
              aria-pressed={value === ""}
              className="h-auto! min-h-12 w-full! min-w-0 justify-start rounded-none! bg-kumo-recessed px-3 py-2 text-left text-sm font-semibold whitespace-normal transition-colors hover:bg-kumo-tint focus-visible:z-10 disabled:opacity-50 aria-pressed:bg-(--brand-soft) aria-pressed:text-kumo-brand"
              disabled={disabled}
              type="button"
              variant="ghost"
              onClick={() => choose(scratch)}
            >
              <span className="flex items-center gap-2">
                <OpenTagLogo className="h-5! shrink-0" label="" variant="mark" />
                <span>{scratch.title}</span>
              </span>
            </Button>
          }
        />
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-kumo-subtle" id={`${id}-presets-help`}>
          {m.agent_settings_soul_presets_help()}
        </p>
        {canUndo ? (
          <Button
            disabled={disabled}
            size="compact"
            type="button"
            variant="ghost"
            onClick={() => {
              onValueChange(previousDraft.value);
              setPreviousDraft(undefined);
            }}
          >
            {m.agent_settings_soul_preset_undo_action()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
