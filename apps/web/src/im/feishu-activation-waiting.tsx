import type { FeishuSetupActivation } from "@opentag/shared/browser";
import { formatDateTime } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Button, Collapsible, Icon, StatusIndicator } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { messagingProviderLabel } from "./provider-label.js";

/** Saved authorization survives page closure; each reason names the remaining prerequisite. */
export function FeishuActivationWaiting({
  activation,
  expiresAt,
  checking = false,
  disabled = false,
  onCheck,
  onCancel,
  presentation = "default",
}: {
  readonly activation: FeishuSetupActivation;
  readonly expiresAt: string;
  readonly checking?: boolean;
  readonly disabled?: boolean;
  readonly onCheck?: () => void;
  readonly onCancel?: () => void;
  readonly presentation?: "default" | "settings";
}) {
  const checkButton = onCheck ? (
    <Button
      className="otv2-activation-check"
      disabled={disabled}
      loading={checking}
      onClick={onCheck}
      variant="secondary"
    >
      {m.im_feishu_activation_check()}
    </Button>
  ) : null;
  const cancelButton = onCancel ? (
    <Button className="otv2-activation-cancel" disabled={disabled} variant="ghost" onClick={onCancel}>
      {m.im_feishu_activation_cancel()}
    </Button>
  ) : null;
  return (
    <div className="grid min-w-0 gap-4" data-ui="feishu-activation-waiting" data-presentation={presentation}>
      <div className="otv2-activation-summary grid min-w-0 gap-4">
        <div className="otv2-activation-identity">
          {presentation === "settings" ? (
            <div className="flex items-center gap-2">
              <ProviderIcon className="size-6" provider="feishu" />
              <strong>{messagingProviderLabel("feishu")}</strong>
            </div>
          ) : null}
          <div role="status">
            <StatusIndicator label={activationTitle(activation.reason)} tone="warning" />
          </div>
        </div>
        <p className="text-sm text-kumo-subtle">{m.im_feishu_activation_description()}</p>
        {presentation === "settings" && activation.reason === "runtime_unavailable" ? (
          <p className="otv2-connection-advice">{m.onboarding_v2_connection_activation_runtime()}</p>
        ) : null}
        {presentation === "settings" && activation.reason === "temporary_failure" ? (
          <p className="otv2-connection-advice">{m.onboarding_v2_connection_activation_temporary()}</p>
        ) : null}
        {activation.reason === "permissions_pending" ? (
          <p className="text-sm text-kumo-subtle">
            {m.im_feishu_activation_permissions_help({ provider: messagingProviderLabel("feishu") })}
          </p>
        ) : null}
        {activation.reason === "app_unavailable" ? (
          <p className="text-sm text-kumo-subtle">{m.im_feishu_activation_app_help()}</p>
        ) : null}
      </div>
      <Collapsible.Root className="otv2-activation-details min-w-0 text-sm text-kumo-subtle">
        <Collapsible.Trigger
          className="otv2-activation-details-trigger"
          render={<Button variant="ghost" size="compact" />}
        >
          {m.im_feishu_activation_details()}
          <Icon name="chevron-down" className="size-3.5 [[data-panel-open]_&]:rotate-180" />
        </Collapsible.Trigger>
        <Collapsible.Panel className="otv2-activation-details-panel grid min-w-0 gap-2 pt-2">
          <p className="break-all">{m.im_feishu_activation_app({ appId: activation.appId })}</p>
          <p>{m.im_feishu_activation_retained({ time: formatDateTime(expiresAt) })}</p>
          {activation.lastCheckedAt ? (
            <p>{m.im_feishu_activation_checked({ time: formatDateTime(activation.lastCheckedAt) })}</p>
          ) : null}
          {activation.missingScopes.length > 0 ? (
            <>
              <p>{m.im_feishu_activation_missing({ count: activation.missingScopes.length })}</p>
              <ul className="list-inside list-disc">
                {activation.missingScopes.map((scope) => (
                  <li className="break-all" key={scope}>
                    {scope}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Collapsible.Panel>
      </Collapsible.Root>
      {onCheck || onCancel ? (
        <div className="otv2-activation-actions flex flex-wrap gap-3">
          {presentation === "settings" ? (
            <>
              {cancelButton}
              {checkButton}
            </>
          ) : (
            <>
              {checkButton}
              {cancelButton}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function activationTitle(reason: FeishuSetupActivation["reason"]): string {
  switch (reason) {
    case "permissions_pending":
      return m.im_feishu_activation_permissions();
    case "app_unavailable":
      return m.im_feishu_activation_app_unavailable();
    case "runtime_unavailable":
      return m.im_feishu_activation_runtime();
    case "temporary_failure":
      return m.im_feishu_activation_retrying();
    case "checking":
      return m.im_feishu_activation_checking();
  }
}
