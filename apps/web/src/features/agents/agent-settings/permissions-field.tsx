import type { AgentPermissions, AgentRuntimeProvider } from "@opentag/shared/browser";
import * as m from "../../../paraglide/messages.js";
import { Input, InputArea, SettingsRow } from "../../../ui/design-system.js";

const EXAMPLES: Record<AgentRuntimeProvider, string> = {
  codex: '[{"pattern":["git","status"],"decision":"allow"}]',
  "claude-code": '{"allow":["Bash(git status)"]}',
  pi: '{"bash":{"*":"ask","git status":"allow"}}',
};
export function PermissionsField({
  provider,
  value,
  onChange,
}: {
  provider: AgentRuntimeProvider;
  value: AgentPermissions;
  onChange(value: AgentPermissions): void;
}) {
  return (
    <>
      <SettingsRow
        label={m.agent_settings_permissions_approver()}
        description={m.agent_settings_permissions_description()}
      >
        <Input
          aria-label={m.agent_settings_permissions_approver()}
          value={value.approverExternalId ?? ""}
          onChange={(event) => onChange({ ...value, approverExternalId: event.target.value.trim() || null })}
          placeholder={m.agent_settings_permissions_approver_placeholder()}
          maxLength={128}
        />
      </SettingsRow>
      <SettingsRow
        label={m.agent_settings_permissions_rules()}
        description={m.agent_settings_permissions_rules_description()}
      >
        <InputArea
          aria-label={m.agent_settings_permissions_rules()}
          value={value.rules}
          onChange={(event) => onChange({ ...value, rules: event.target.value })}
          placeholder={EXAMPLES[provider]}
          minRows={3}
          maxRows={12}
          maxLength={16384}
          className="font-mono"
        />
      </SettingsRow>
    </>
  );
}
