import type {
  AgentSetupAction,
  AgentSetupSnapshot,
  ImProvider,
  ProviderCliHandoffProgress,
} from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { agentCreateLink } from "../features/agents/agent-routes.js";
import { formatDateTime, spaceScriptBoundary } from "../i18n/format.js";
import { FeishuActivationWaiting } from "../im/feishu-activation-waiting.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import { slackConfigurationMessage } from "../im/slack-configuration.js";
import { SlackCustomApp, type SlackSetupApi } from "../im/slack-custom-app.js";
import * as m from "../paraglide/messages.js";
import { QrCode, WAITING_LINE } from "../setup/index.js";
import {
  Banner,
  Button,
  buttonClassName,
  Collapsible,
  Dialog,
  Icon,
  StatusIndicator,
  Text,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { BrandMark } from "./brand-mark.js";
import { providerCliWaitingCopy } from "./messaging-readiness-copy.js";
import { CardCopy } from "./steps.js";
import { type AgentSetupController, FEISHU_ACTION_ERRORS, providerTitle } from "./use-agent-setup.js";

const SECTION = "flex flex-col gap-6";
const HINT = "text-sm text-kumo-subtle m-0";
const CHOICE_GRID = "otv2-choices--grid grid gap-3 m-0 p-0 list-none";
const CARD =
  "otv2-choice flex w-full items-center justify-start gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";

export function MessagingSetupSection({
  slackApi,
  controller,
  oauthError,
  refreshAction,
  snapshot,
}: {
  readonly slackApi?: SlackSetupApi;
  readonly controller: AgentSetupController;
  readonly oauthError?: string;
  readonly refreshAction?: ReactNode;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { messaging } = snapshot;
  const [slackOpen, setSlackOpen] = useState(false);
  return (
    <section
      className={`${SECTION} otv2-messaging-settings`}
      data-state={messaging.kind}
      data-slack-open={slackOpen || undefined}
      data-ui="agent-setup-messaging"
    >
      {oauthError ? <Banner variant="error" role="alert" description={oauthError} /> : null}
      {!slackOpen && messaging.kind === "authorizing" && messaging.provider === "feishu" ? (
        <FeishuAuthorizing
          busyKey={controller.busyKey}
          messaging={messaging}
          onAct={controller.act}
          snapshot={snapshot}
        />
      ) : null}
      {!slackOpen && messaging.kind === "authorizing" && messaging.provider === "slack" ? (
        <SlackAuthorizing messaging={messaging} />
      ) : null}
      {!slackOpen && messaging.kind === "waiting-handoff" ? (
        <MessagingHandoff
          controller={controller}
          messaging={messaging}
          snapshot={snapshot}
          refreshAction={refreshAction}
        />
      ) : null}
      {!slackOpen && messaging.kind === "blocked" ? (
        <BlockedMessaging controller={controller} messaging={messaging} snapshot={snapshot} />
      ) : null}
      {controller.actionError && messaging.kind !== "blocked" && messaging.kind !== "waiting-handoff" ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
      <MessagingConnections
        controller={controller}
        snapshot={snapshot}
        slackApi={slackApi}
        onSetupOpenChange={setSlackOpen}
      />
    </section>
  );
}

/** Custom App setup remains available independently of the official OAuth actions. */
function SlackSetupConfiguration({
  slackApi,
  onSetupOpenChange,
  controller,
  snapshot,
  renderTrigger,
}: {
  slackApi?: SlackSetupApi;
  onSetupOpenChange?: (open: boolean) => void;
  controller: AgentSetupController;
  snapshot: AgentSetupSnapshot;
  renderTrigger?: ComponentProps<typeof SlackCustomApp>["renderTrigger"];
}) {
  const messaging = snapshot.messaging;
  if (messaging.kind !== "not-configured" && !("provider" in messaging && messaging.provider === "slack")) return null;
  const reauthorize = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "reauthorize-messaging" }> =>
      action.kind === "reauthorize-messaging" && action.provider === "slack",
  );
  return (
    <SlackCustomApp
      presentation="inline"
      onOpenChange={onSetupOpenChange}
      api={slackApi}
      agentId={snapshot.agent.id}
      bindingId={"bindingId" in messaging ? messaging.bindingId : undefined}
      onSaved={controller.reload}
      cloud={snapshot.computer.kind === "cloud"}
      onOAuth={reauthorize ? () => void controller.act(reauthorize) : undefined}
      renderTrigger={renderTrigger}
    />
  );
}

/** Keep the configuration dialog in one tree position while the saved binding refreshes. */
function MessagingConnections({
  controller,
  slackApi,
  onSetupOpenChange,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly slackApi?: SlackSetupApi;
  onSetupOpenChange?: (open: boolean) => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const starting = useRef(false);
  async function start(action: AgentSetupAction) {
    if (starting.current) return;
    starting.current = true;
    try {
      await controller.act(action);
    } finally {
      starting.current = false;
    }
  }
  const choosing = snapshot.messaging.kind === "not-configured";
  const startActions = snapshot.actions.filter(
    (action): action is Extract<AgentSetupAction, { kind: "start-messaging" }> => action.kind === "start-messaging",
  );
  const slack = startActions.find((action) => action.provider === "slack");
  const feishu = startActions.find((action) => action.provider === "feishu");
  if (!choosing && "provider" in snapshot.messaging && snapshot.messaging.provider !== "slack") return null;
  return (
    <ul
      className={choosing && startActions.length ? CHOICE_GRID : "m-0 flex list-none flex-wrap gap-3 p-0"}
      data-ui={
        choosing && startActions.length ? "agent-setup-messaging-choices" : "agent-setup-messaging-configuration"
      }
    >
      <li key="slack">
        <SlackSetupConfiguration
          onSetupOpenChange={onSetupOpenChange}
          controller={controller}
          snapshot={snapshot}
          slackApi={slackApi}
          renderTrigger={
            choosing && slack
              ? ({ onClick, disabled, ref }) => (
                  <Button
                    ref={ref}
                    className={CARD}
                    disabled={disabled || controller.busyKey !== undefined}
                    onClick={() => {
                      if (!starting.current) onClick();
                    }}
                    variant="ghost"
                  >
                    <MessagingChoiceCopy provider="slack" />
                  </Button>
                )
              : undefined
          }
        />
      </li>
      {choosing && feishu ? (
        <li key="feishu">
          <Button
            className={CARD}
            disabled={controller.busyKey !== undefined}
            loading={controller.busyKey?.kind === "start-messaging" && controller.busyKey.provider === "feishu"}
            onClick={() => void start(feishu)}
            variant="ghost"
          >
            <MessagingChoiceCopy provider="feishu" />
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function MessagingChoiceCopy({ provider }: { provider: "slack" | "feishu" }) {
  return (
    <>
      <BrandMark brand={provider} label={providerTitle(provider)} />
      <CardCopy
        description={
          provider === "feishu"
            ? m.onboarding_v2_connection_method_feishu({ provider: messagingProviderLabel("feishu") })
            : m.onboarding_v2_connection_method_slack({ provider: messagingProviderLabel("slack") })
        }
        title={providerTitle(provider)}
      />
      <Icon name="chevron-right" className="otv2-messaging-settings__chevron" aria-hidden="true" />
    </>
  );
}

/**
 * Hide unusable QR pixels locally; only the Server may end or replace the attempt. Also answers the
 * whole minutes left, re-read each minute, so the expiry reads relative ("15 分钟后过期").
 */
function useQrValidity(expiresAt: string): { valid: boolean; minutesLeft: number } {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) return;
    let timer: number | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const remaining = expiry - current;
      if (remaining > 0) timer = window.setTimeout(tick, Math.min(remaining, 60_000));
    };
    const remaining = expiry - Date.now();
    if (remaining > 0) timer = window.setTimeout(tick, Math.min(remaining, 60_000));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const remaining = Date.parse(expiresAt) - now;
  return { valid: remaining > 0, minutesLeft: Math.max(1, Math.ceil(remaining / 60_000)) };
}

function FeishuAuthorizing({
  busyKey,
  messaging,
  onAct,
  snapshot,
}: {
  readonly busyKey: AgentSetupAction | undefined;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "authorizing"; provider: "feishu" }>;
  readonly onAct: (action: AgentSetupAction) => Promise<boolean>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { valid: qrValid, minutesLeft } = useQrValidity(messaging.expiresAt);
  const cancel = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "cancel-messaging-attempt" }> =>
      action.kind === "cancel-messaging-attempt" && action.attemptId === messaging.attemptId,
  );
  if (messaging.activation) {
    const check = snapshot.actions.find((action) => action.kind === "refresh");
    return (
      <FeishuActivationWaiting
        presentation="settings"
        activation={messaging.activation}
        expiresAt={messaging.expiresAt}
        disabled={busyKey !== undefined}
        checking={busyKey?.kind === "refresh"}
        onCheck={check ? () => void onAct(check) : undefined}
        onCancel={cancel ? () => void onAct(cancel) : undefined}
      />
    );
  }
  return (
    <div className="otv2-connection-card otv2-connection-scan">
      <div className="otv2-connection-card__body">
        <div className="otv2-connection-card__identity">
          <Text as="h2" variant="heading" size="lg">
            <ProviderIcon className="size-6" provider="feishu" />
            <strong>{spaceScriptBoundary(m.im_connect_feishu({ provider: providerTitle("feishu") }))}</strong>
          </Text>
        </div>
        {/* The scanning instruction matches the QR code, which shows from 768px up; on a phone it
            says to open Lark instead, matching the button below. */}
        <p className={`${HINT} hidden md:block`}>
          {spaceScriptBoundary(m.onboarding_v2_messaging_lark_intro({ provider: providerTitle("feishu") }))}
        </p>
        <p className={`${HINT} md:hidden`}>
          {spaceScriptBoundary(m.onboarding_v2_messaging_lark_intro_phone({ provider: providerTitle("feishu") }))}
        </p>
        <p className={WAITING_LINE} role="status">
          {/* Pending, not done: the same spinner as the connect command window, never a success dot. */}
          {qrValid ? <span aria-hidden="true" className="otv2-pending-spinner" /> : null}
          {!qrValid ? (
            m.onboarding_v2_connection_qr_elapsed()
          ) : messaging.qrUrl ? (
            <>
              <span className="hidden md:inline">{m.onboarding_v2_messaging_waiting()}</span>
              <span className="md:hidden">{m.onboarding_v2_messaging_waiting_phone()}</span>
            </>
          ) : (
            m.onboarding_v2_connection_qr_loading()
          )}
        </p>
        {qrValid && messaging.qrUrl ? (
          <>
            {/* A QR code is for a second device; below 768px the reader is usually on the phone that
                would scan it, so the same authorization link opens in Feishu instead. */}
            <div className="otv2-connection-scan__content" data-ui="agent-setup-feishu-qr">
              <QrCode value={messaging.qrUrl} />
            </div>
            <a
              className={buttonClassName({ className: "w-full md:hidden" })}
              data-ui="agent-setup-feishu-open"
              href={messaging.qrUrl}
              rel="noreferrer"
              target="_blank"
            >
              {spaceScriptBoundary(m.im_feishu_open({ provider: providerTitle("feishu") }))}
            </a>
          </>
        ) : null}
      </div>
      <div className="otv2-connection-card__footer">
        <p className="otv2-connection-card__metadata">
          {qrValid ? m.im_feishu_qr_expires_in({ minutes: minutesLeft }) : m.im_feishu_qr_expired()}
        </p>
        {cancel ? (
          <Button
            disabled={busyKey !== undefined}
            loading={busyKey?.kind === "cancel-messaging-attempt"}
            onClick={() => void onAct(cancel)}
            variant="ghost"
          >
            {m.common_cancel()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SlackAuthorizing({
  messaging,
}: {
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "authorizing"; provider: "slack" }>;
}) {
  return (
    <div className="otv2-connection-card">
      <div className="otv2-connection-card__body">
        <span className="otv2-connection-card__provider">
          <ProviderIcon className="size-6" provider="slack" />
          <strong>{providerTitle("slack")}</strong>
        </span>
        <p className={WAITING_LINE} role="status">
          <span aria-hidden="true" className="otv2-pending-spinner" />
          {spaceScriptBoundary(m.onboarding_v2_messaging_slack_waiting({ provider: providerTitle("slack") }))}
        </p>
      </div>
      <div className="otv2-connection-card__footer">
        <p className="otv2-connection-card__metadata">
          {m.onboarding_v2_setup_slack_install_expires({ date: formatDateTime(messaging.expiresAt) })}
        </p>
      </div>
    </div>
  );
}

function messagingHandoffCopy(progress: ProviderCliHandoffProgress, provider: ImProvider): string {
  if (progress.phase === "preparing_cli") {
    return m.onboarding_v2_setup_messaging_confirming_computer({ provider: providerTitle(provider) });
  }
  if (progress.reason === "upgrade_required") {
    return m.onboarding_v2_setup_messaging_computer_attention({ provider: providerTitle(provider) });
  }
  if (progress.phase === "needs_attention" && !progress.reason) {
    return m.onboarding_v2_setup_messaging_computer_attention({ provider: providerTitle(provider) });
  }
  return providerCliWaitingCopy(progress);
}

function MessagingHandoff({
  controller,
  messaging,
  snapshot,
  refreshAction,
}: {
  readonly controller: AgentSetupController;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "waiting-handoff" }>;
  readonly snapshot: AgentSetupSnapshot;
  readonly refreshAction?: ReactNode;
}) {
  const [unbindAsked, setUnbindAsked] = useState(false);
  const unbindButtonRef = useRef<HTMLButtonElement>(null);
  const unbind = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "unbind-messaging" }> =>
      action.kind === "unbind-messaging" &&
      action.provider === messaging.provider &&
      action.bindingId === messaging.bindingId,
  );
  return (
    <div className="otv2-connection-card">
      <div className="otv2-connection-card__body">
        <span className="otv2-connection-card__provider">
          <ProviderIcon className="size-6" provider={messaging.provider} />
          <strong>{providerTitle(messaging.provider)}</strong>
        </span>
        <p className={WAITING_LINE} role="status">
          <span aria-hidden="true" className="otv2-pending-spinner" />
          {m.onboarding_v2_messaging_confirming()}
        </p>
        {messaging.progress ? (
          <p className={HINT}>{messagingHandoffCopy(messaging.progress, messaging.provider)}</p>
        ) : null}
        {messaging.provider === "feishu" ? (
          <p className={HINT}>
            {m.onboarding_v2_connection_feishu_test({ provider: messagingProviderLabel("feishu") })}
          </p>
        ) : null}
        {!messaging.progress && messaging.provider === "slack" ? (
          <p className={HINT}>
            {m.onboarding_v2_messaging_slack_observe({ provider: providerTitle(messaging.provider) })}
          </p>
        ) : null}
      </div>
      {unbind || refreshAction ? (
        <div className="otv2-connection-card__footer">
          {unbind ? (
            <div data-ui="agent-setup-messaging-destructive-action">
              <Button
                className="otv2-connection-disconnect"
                disabled={controller.busyKey !== undefined}
                onClick={() => setUnbindAsked(true)}
                ref={unbindButtonRef}
                variant="secondary-destructive"
              >
                {m.im_disconnect({ providerName: providerTitle(unbind.provider) })}
              </Button>
            </div>
          ) : null}
          {refreshAction}
        </div>
      ) : null}
      {controller.actionError && !unbindAsked ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
      {unbind && unbindAsked ? (
        <UnbindMessagingDialog
          action={unbind}
          busyKey={controller.busyKey}
          error={controller.actionError}
          onAct={controller.act}
          onClose={() => setUnbindAsked(false)}
          returnFocusRef={unbindButtonRef}
        />
      ) : null}
    </div>
  );
}

function blockedMessagingCopy(messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "blocked" }>): string {
  const provider = providerTitle(messaging.provider);
  if (messaging.errorCode) {
    const known =
      messaging.provider === "feishu" && Object.hasOwn(FEISHU_ACTION_ERRORS, messaging.errorCode)
        ? FEISHU_ACTION_ERRORS[messaging.errorCode]
        : undefined;
    if (known) return known();
    if (
      messaging.provider === "slack" &&
      [
        "AGENT_COMPUTER_NOT_BOUND",
        "SLACK_CONFIGURATION_CONFLICT",
        "SLACK_CREDENTIALS_UNAVAILABLE",
        "SLACK_SCOPE_REAUTH_REQUIRED",
        "SLACK_TOKEN_REVOKED",
        "SLACK_UPSTREAM_UNAVAILABLE",
        "SLACK_APP_TEAM_ALREADY_BOUND",
      ].includes(messaging.errorCode)
    )
      return slackConfigurationMessage(messaging.errorCode);
  }
  if (messaging.code === "reauthorization-required")
    return m.onboarding_v2_setup_messaging_reauth_required({ provider });
  if (messaging.code === "unbind-required") return m.onboarding_v2_setup_messaging_unbind_required({ provider });
  return m.onboarding_v2_connection_failure_unknown();
}

function messagingRepairAdvice(messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "blocked" }>): string {
  const code = messaging.errorCode ?? "";
  if (code.includes("UPSTREAM_UNAVAILABLE")) return m.onboarding_v2_connection_repair_service();
  if (code.includes("EXPIRED") || code === "FEISHU_SETUP_CANCELED") return m.onboarding_v2_connection_repair_new_code();
  if (code.includes("ALREADY_BOUND")) return m.onboarding_v2_connection_repair_other_bot();
  if (code.includes("SCOPE") || code === "SLACK_TOKEN_REVOKED" || messaging.code === "reauthorization-required") {
    return m.onboarding_v2_connection_repair_permissions();
  }
  return m.onboarding_v2_connection_repair_authorize();
}

function currentBindingOf(
  messaging: AgentSetupSnapshot["messaging"],
): { provider: ImProvider; bindingId: string } | undefined {
  if (messaging.kind === "waiting-handoff" || messaging.kind === "ready") {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
  }
  if (messaging.kind === "blocked" && messaging.bindingId) {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
  }
  return undefined;
}

function MessagingDiagnostics({ errorCode }: { errorCode: string | null | undefined }) {
  if (!errorCode) return null;
  return (
    <Collapsible.Root className="otv2-connection-diagnostics">
      <Collapsible.Trigger render={<Button variant="ghost" size="compact" />}>
        {m.onboarding_v2_connection_diagnostics()}
        <Icon name="chevron-down" aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <code>{m.onboarding_v2_connection_error_code({ code: errorCode })}</code>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function isFeishuStartAction(action: AgentSetupAction): boolean {
  return action.kind === "start-messaging" && action.provider === "feishu";
}

function BlockedMessaging({
  controller,
  messaging,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "blocked" }>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const [unbindAsked, setUnbindAsked] = useState(false);
  const unbindButtonRef = useRef<HTMLButtonElement>(null);
  if (messaging.errorCode === "IM_BINDING_IDENTITY_DISCONNECTED")
    return (
      <div className="grid gap-3" data-ui="agent-setup-messaging-disconnected">
        <p>{m.im_identity_disconnected()}</p>
        <Link {...agentCreateLink()} className={buttonClassName({ variant: "primary" })}>
          {m.agents_new_agent()}
        </Link>
      </div>
    );
  const binding = currentBindingOf(messaging);
  const switchBlocker = snapshot.blockers.find(
    (blocker): blocker is Extract<AgentSetupSnapshot["blockers"][number], { code: "messaging-unbind-required" }> =>
      blocker.code === "messaging-unbind-required",
  );
  const reauthorize = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "reauthorize-messaging" }> =>
      action.kind === "reauthorize-messaging" &&
      action.provider === "feishu" &&
      binding !== undefined &&
      action.provider === binding.provider &&
      action.bindingId === binding.bindingId,
  );
  const unbind = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "unbind-messaging" }> =>
      action.kind === "unbind-messaging" &&
      binding !== undefined &&
      action.provider === binding.provider &&
      action.bindingId === binding.bindingId,
  );
  const hasActions = [unbind, reauthorize, snapshot.actions.find(isFeishuStartAction)].some(Boolean);
  const busy = controller.busyKey !== undefined;
  return (
    <div className="otv2-messaging-recovery" data-ui="agent-setup-messaging-recovery">
      <div className="otv2-messaging-recovery__summary">
        <div className="otv2-messaging-recovery__identity" data-ui="agent-setup-messaging-identity">
          <span className="otv2-messaging-recovery__provider">
            <ProviderIcon className="size-6" provider={messaging.provider} />
            <strong>{providerTitle(messaging.provider)}</strong>
          </span>
          <StatusIndicator label={m.onboarding_v2_setup_messaging_needs_attention()} tone="warning" />
        </div>
        <div className="otv2-connection-failure" role="alert">
          <strong>{m.onboarding_v2_connection_failure_heading()}</strong>
          <p>{blockedMessagingCopy(messaging)}</p>
        </div>
        <div className="otv2-connection-advice">
          <strong>{m.onboarding_v2_connection_next_step()}</strong>
          <p>{messagingRepairAdvice(messaging)}</p>
        </div>
        <MessagingDiagnostics errorCode={messaging.errorCode} />
        {switchBlocker ? (
          <p className={HINT}>
            {m.onboarding_v2_setup_messaging_switch_required({
              current: providerTitle(switchBlocker.currentProvider),
              requested: providerTitle(switchBlocker.requestedProvider),
            })}
          </p>
        ) : null}
      </div>
      {hasActions ? (
        <div className="otv2-messaging-recovery__footer">
          {unbind ? (
            <div className="otv2-destructive-action" data-ui="agent-setup-messaging-destructive-action">
              <Button
                disabled={busy}
                onClick={() => setUnbindAsked(true)}
                ref={unbindButtonRef}
                variant="secondary-destructive"
              >
                {m.im_disconnect({ providerName: providerTitle(unbind.provider) })}
              </Button>
            </div>
          ) : null}
          <div className="otv2-messaging-recovery__actions" data-ui="agent-setup-messaging-recovery-actions">
            <RetryInitialAuthorization controller={controller} snapshot={snapshot} />
            {reauthorize ? (
              <Button
                disabled={busy}
                loading={controller.busyKey?.kind === "reauthorize-messaging"}
                onClick={() => void controller.act(reauthorize)}
              >
                {messaging.code === "reauthorization-required" ? m.im_update_permissions() : m.im_reconnect()}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {controller.actionError && !unbindAsked ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
      {unbind && unbindAsked ? (
        <UnbindMessagingDialog
          action={unbind}
          configured={messaging.credentialGeneration !== 0}
          busyKey={controller.busyKey}
          error={controller.actionError}
          onAct={controller.act}
          onClose={() => setUnbindAsked(false)}
          returnFocusRef={unbindButtonRef}
        />
      ) : null}
    </div>
  );
}

function RetryInitialAuthorization({
  controller,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const retry = snapshot.actions.find((action) => action.kind === "start-messaging" && action.provider === "feishu");
  if (!retry) return null;
  return (
    <Button
      disabled={controller.busyKey !== undefined}
      loading={controller.busyKey?.kind === "start-messaging"}
      onClick={() => void controller.act(retry)}
    >
      {snapshot.messaging.kind === "blocked" && snapshot.messaging.errorCode === "FEISHU_SETUP_EXPIRED"
        ? m.onboarding_v2_connection_qr_new()
        : m.im_feishu_retry_setup({ provider: providerTitle("feishu") })}
    </Button>
  );
}

/**
 * Disconnecting a messaging app is irreversible from this page and takes the Agent's channel down
 * with it, so it is asked rather than done: what will happen, a safe default focus, and a busy
 * state that cannot be dismissed while the outcome is uncertain.
 */
function UnbindMessagingDialog({
  action,
  configured = true,
  busyKey,
  error,
  onAct,
  onClose,
  returnFocusRef,
}: {
  readonly configured?: boolean;
  readonly action: Extract<AgentSetupAction, { kind: "unbind-messaging" }>;
  readonly busyKey: AgentSetupAction | undefined;
  readonly error: string | undefined;
  readonly onAct: (action: AgentSetupAction) => Promise<boolean>;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const providerName = providerTitle(action.provider);
  const busy = busyKey?.kind === "unbind-messaging";
  return (
    <Dialog
      busy={busy}
      description={configured ? m.im_disconnect_description({ providerName }) : m.im_cancel_initial_setup_description()}
      returnFocusRef={returnFocusRef}
      role="alertdialog"
      title={m.im_disconnect_title({ providerName })}
      onClose={onClose}
    >
      <div className="grid gap-5">
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {m.im_disconnect_cancel()}
          </Button>
          <Button
            disabled={busy}
            loading={busy}
            onClick={() =>
              void onAct(action).then((ok) => {
                if (ok) onClose();
              })
            }
            variant="danger"
          >
            {m.im_disconnect({ providerName })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
