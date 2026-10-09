import { AdditionalAllowedCommandSchema, type AgentPermissions } from "@opentag/shared/browser";
import { useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, Input, SettingsRow, Switch } from "../../../ui/design-system.js";

const SUGGESTED_COMMANDS = [
  "git status",
  "git diff",
  "git log",
  "docker ps",
  "docker images",
  "docker logs",
  "docker compose ps",
] as const;
const COMMAND_CHIP_CLASS_NAME = "!h-7 px-2 !text-xs";

export function PermissionsField({
  value,
  onChange,
}: {
  value: AgentPermissions;
  onChange(value: AgentPermissions): void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  function addCommand(raw: string) {
    const parsed = AdditionalAllowedCommandSchema.safeParse(raw.trim().replace(/\s+/g, " "));
    if (!parsed.success) {
      setError(m.agent_settings_command_invalid());
      return;
    }
    if (value.allowCommands.includes(parsed.data)) {
      setError(m.agent_settings_command_duplicate());
      return;
    }
    if (value.allowCommands.length >= 64) {
      setError(m.agent_settings_command_limit());
      return;
    }
    onChange({ ...value, allowCommands: [...value.allowCommands, parsed.data] });
    setDraft("");
    setError("");
  }

  return (
    <>
      <SettingsRow
        label={m.agent_settings_ask_for_approval()}
        description={m.agent_settings_ask_for_approval_description()}
      >
        <Switch
          aria-label={m.agent_settings_ask_for_approval()}
          checked={value.approvalPolicy === "on-request"}
          onCheckedChange={(checked) => onChange({ ...value, approvalPolicy: checked ? "on-request" : "never" })}
        />
      </SettingsRow>
      {value.approvalPolicy === "on-request" ? (
        <div className="grid gap-4 p-4" data-ui="settings-row">
          <div className="grid gap-1">
            <strong className="text-sm font-medium text-kumo-strong">{m.agent_settings_command_allowlist()}</strong>
            <p className="text-sm text-kumo-subtle">{m.agent_settings_command_allowlist_description()}</p>
          </div>
          {value.allowCommands.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label={m.agent_settings_command_allowlist()}>
              {value.allowCommands.map((command) => (
                <li key={command}>
                  <Button
                    aria-label={m.agent_settings_command_remove({ command })}
                    className={COMMAND_CHIP_CLASS_NAME}
                    onClick={() =>
                      onChange({ ...value, allowCommands: value.allowCommands.filter((item) => item !== command) })
                    }
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <code>{command}</code>
                    <Icon name="close" className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={m.agent_settings_command_input()}
              className="min-w-48 flex-1"
              maxLength={128}
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCommand(draft);
                }
              }}
              placeholder={m.agent_settings_command_input_placeholder()}
              value={draft}
            />
            <Button disabled={!draft.trim()} onClick={() => addCommand(draft)} type="button" variant="secondary">
              {m.agent_settings_command_add()}
            </Button>
          </div>
          {error ? (
            <p className="text-sm text-kumo-danger" role="alert">
              {error}
            </p>
          ) : null}
          {value.allowCommands.length < 64 ? (
            <div className="grid gap-2">
              <span className="text-sm text-kumo-subtle">{m.agent_settings_command_suggestions()}</span>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_COMMANDS.filter((command) => !value.allowCommands.includes(command)).map((command) => (
                  <Button
                    aria-label={m.agent_settings_command_suggestion_add({ command })}
                    className={COMMAND_CHIP_CLASS_NAME}
                    key={command}
                    onClick={() => addCommand(command)}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <Icon className="size-3" name="plus" />
                    {command}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
