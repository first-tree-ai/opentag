import {
  type SaveSlackConfigurationRequest,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAutoSetupResponse,
  type SlackConfigurationView,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { isHandoffChecking } from "../features/agents/agent-model.js";
import { agentDetailLink } from "../features/agents/agent-routes.js";
import { spaceScriptBoundary } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import {
  Banner,
  Button,
  buttonClassName,
  Collapsible,
  Dialog,
  DropdownMenu,
  Input,
  InputArea,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { messagingProviderLabel } from "./provider-label.js";
import {
  slackAppCreateUrl,
  slackAppManifest,
  slackBotConversationUrl,
  slackBotDisplayName,
} from "./slack-app-manifest.js";
import { SlackAutoConnect } from "./slack-auto-connect.js";
import { slackConfigurationMessage } from "./slack-configuration.js";

export type SlackSetupApi = {
  slackConfiguration: typeof browserApi.slackConfiguration;
  saveSlackConfiguration: typeof browserApi.saveSlackConfiguration;
  autoSetupSlack: typeof browserApi.autoSetupSlack;
};

interface Props {
  api?: SlackSetupApi;
  agentId: string;
  bindingId?: string;
  onSaved: () => void;
  onOAuth?: () => void;
  manualOnly?: boolean;
  onDisconnect?: () => void;
  renderTrigger?: (control: {
    onClick: () => void;
    disabled: boolean;
    ref: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}

export function SlackCustomApp(props: Props) {
  return <SlackCustomAppFlow key={props.agentId} {...props} />;
}

function SlackCustomAppFlow({
  api = browserApi,
  agentId,
  bindingId,
  onSaved,
  onOAuth,
  manualOnly = false,
  renderTrigger,
  onDisconnect,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SlackConfigurationView>();
  const [busy, setBusy] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const [savedMethod, setSavedMethod] = useState<"auto" | "manual">();
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const configuration = useQuery({
    queryKey: ["slack-configuration", agentId, bindingId],
    queryFn: () => api.slackConfiguration(agentId),
    // A new binding key must not remove the open post-save verification dialog.
    placeholderData: (previous) => previous,
    retry: false,
    refetchInterval: (query) => (open && !editing && query.state.data?.handoff?.handoffReady === false ? 2_000 : false),
    refetchIntervalInBackground: false,
  });
  const view = configuration.data;

  function close() {
    if (saving.current || busy) return;
    setEditing(undefined);
    setAutoResume(false);
    setError(undefined);
    setOpen(false);
  }
  function start() {
    if (!view) return;
    setError(undefined);
    setAutoResume(false);
    setSavedMethod(undefined);
    setEditing(view.allowedIntent === "create" || view.binding?.reauthorizationRequired ? view : undefined);
    setOpen(true);
  }
  function update() {
    setAutoResume(false);
    if (view?.allowedIntent !== "reauthorize") return;
    setError(undefined);
    setEditing(view);
  }
  async function resumeAfterLostResponse(input: SaveSlackConfigurationRequest): Promise<boolean> {
    const observed = await configuration.refetch();
    const current = observed.data?.binding;
    if (current?.provider !== "slack") return false;
    const expected = input.expectedMessaging;
    if (expected.kind === "unbound") return true;
    return current.id === expected.bindingId && current.credentialGeneration > expected.credentialGeneration;
  }
  function finishSave(method: "auto" | "manual" = "manual") {
    if (!mounted.current) return;
    setSavedMethod(method);
    setAutoResume(false);
    setEditing(undefined);
    onSaved();
  }
  async function handleSaveFailure(cause: unknown, input: SaveSlackConfigurationRequest) {
    if (!mounted.current) return;
    const uncertain = !(cause instanceof ApiError) || cause.status >= 500;
    if (uncertain && (await resumeAfterLostResponse(input))) finishSave();
    else if (mounted.current) setError(customAppError(cause));
  }
  async function save(input: SaveSlackConfigurationRequest) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api.saveSlackConfiguration(agentId, input);
      if (!mounted.current) return;
      setEditing(undefined);
      await configuration.refetch();
      finishSave();
    } catch (cause) {
      // Never resubmit automatically after a potentially committed request.
      await handleSaveFailure(cause, input);
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (view?.binding?.provider === "feishu") return null;
  const officialRecovery = view?.preferredRecovery === "oauth" ? onOAuth : undefined;
  return (
    <>
      <SlackConfigurationEntry
        view={view}
        bindingId={bindingId}
        busy={busy}
        renderTrigger={renderTrigger}
        trigger={trigger}
        onOpen={start}
        onOAuth={officialRecovery}
        onDisconnect={onDisconnect}
        onEdit={() => {
          start();
          update();
        }}
      />
      {!open ? (
        <SlackConfigurationFeedback
          view={view}
          bindingId={bindingId}
          error={configuration.error}
          onRetry={() => void configuration.refetch()}
          onDisconnect={onDisconnect}
        />
      ) : null}
      {open && view ? (
        <SlackConfigurationDialog
          view={view}
          editing={editing}
          busy={busy}
          autoResume={autoResume}
          trigger={trigger}
          error={error}
          readError={configuration.isError}
          onClose={close}
          onRetry={() => void configuration.refetch()}
        >
          {editing ? (
            <SlackSetupEditor
              api={api}
              agentId={agentId}
              view={editing}
              busy={busy}
              manualOnly={manualOnly}
              automatic={editing.allowedIntent === "create" || autoResume}
              onBusy={setBusy}
              onSave={save}
              onConnected={async () => {
                await configuration.refetch();
                setBusy(false);
                finishSave("auto");
              }}
            />
          ) : (
            <SlackAppStatus
              agentId={agentId}
              view={view}
              onUpdate={update}
              onOAuth={officialRecovery}
              savedMethod={savedMethod}
              onAutoResume={() => {
                setAutoResume(true);
                setEditing(view);
              }}
            />
          )}
        </SlackConfigurationDialog>
      ) : null}
    </>
  );
}

function SlackConfigurationEntry({
  view,
  bindingId,
  busy,
  renderTrigger,
  trigger,
  onOpen,
  onOAuth,
  onDisconnect,
  onEdit,
}: {
  view?: SlackConfigurationView;
  bindingId?: string;
  busy: boolean;
  renderTrigger?: Props["renderTrigger"];
  trigger: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onOAuth?: () => void;
  onDisconnect?: () => void;
  onEdit: () => void;
}) {
  const bindingMatches = !bindingId || view?.binding?.id === bindingId;
  const disabled = busy || !view || Boolean(view.blockedReason) || !bindingMatches;
  if (renderTrigger) return renderTrigger({ onClick: onOpen, disabled, ref: trigger });
  if (view && !view.blockedReason && bindingMatches)
    return (
      <SlackAppEntry
        view={view}
        trigger={trigger}
        onOpen={onOpen}
        onOAuth={onOAuth}
        onDisconnect={onDisconnect}
        onEdit={onEdit}
      />
    );
  return (
    <Button
      ref={trigger}
      variant="secondary"
      disabled={disabled}
      icon={<ProviderIcon className="size-4" provider="slack" />}
    >
      {bindingId ? m.im_slack_continue_setup() : m.im_connect_slack({ provider: messagingProviderLabel("slack") })}
    </Button>
  );
}

function SlackConfigurationFeedback({
  view,
  bindingId,
  error,
  onRetry,
  onDisconnect,
}: {
  view?: SlackConfigurationView;
  bindingId?: string;
  error: unknown;
  onRetry: () => void;
  onDisconnect?: () => void;
}) {
  return (
    <>
      {error ? (
        <div className="grid gap-2">
          <Banner
            variant="error"
            role="alert"
            description={
              error instanceof ApiError && error.status === 404
                ? m.im_slack_upgrade_required({ provider: messagingProviderLabel("slack") })
                : m.im_slack_status_failed()
            }
          />
          <Button variant="ghost" onClick={onRetry}>
            {m.im_slack_retry()}
          </Button>
        </div>
      ) : null}
      {view?.blockedReason ? (
        <Banner variant="error" description={customAppError(new ApiError(409, "", view.blockedReason))} />
      ) : null}
      {bindingId && onDisconnect && (!view || view.blockedReason) ? (
        <Button variant="ghost" onClick={onDisconnect}>
          {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel("slack") }))}
        </Button>
      ) : null}
    </>
  );
}

function SlackConfigurationDialog({
  view,
  editing,
  busy,
  autoResume,
  trigger,
  error,
  readError,
  onClose,
  onRetry,
  children,
}: {
  view: SlackConfigurationView;
  editing?: SlackConfigurationView;
  busy: boolean;
  autoResume: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  error?: string;
  readError: boolean;
  onClose: () => void;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      busy={busy}
      returnFocusRef={trigger}
      onClose={onClose}
      title={
        editing?.allowedIntent === "reauthorize" && !autoResume
          ? m.im_slack_update_credentials()
          : m.im_connect_slack({ provider: messagingProviderLabel("slack") })
      }
      description={view.agentDisplayName}
    >
      <div className="grid gap-4">
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
        {readError ? (
          <div className="grid gap-2">
            <Banner variant="error" role="alert" description={m.im_slack_status_failed()} />
            <Button variant="secondary" onClick={onRetry}>
              {m.im_slack_retry()}
            </Button>
          </div>
        ) : null}
        {!editing && !view.binding ? <p role="status">{m.im_slack_auto_saved()}</p> : null}
        {children}
      </div>
    </Dialog>
  );
}

function SlackSetupEditor({
  api,
  agentId,
  view,
  automatic,
  manualOnly,
  busy,
  onBusy,
  onSave,
  onConnected,
}: {
  agentId: string;
  view: SlackConfigurationView;
  api: SlackSetupApi;
  automatic: boolean;
  manualOnly: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  onConnected: () => Promise<void>;
}) {
  const [manual, setManual] = useState(!automatic || manualOnly);
  const [result, setResult] = useState<SlackAutoSetupResponse>();
  const handleResult = useCallback((next: SlackAutoSetupResponse) => {
    setResult(next);
    if (next.status === "failed" && ["capability_missing", "manual_required"].includes(next.code)) setManual(true);
  }, []);
  const failure = result?.status === "failed" ? result.code : undefined;
  const canReturn =
    automatic && !manualOnly && !["capability_missing", "manual_required", "create_uncertain"].includes(failure ?? "");
  return (
    <>
      {automatic && !manualOnly ? (
        <SlackAutoConnect
          api={api}
          agentId={agentId}
          resume={view.allowedIntent !== "create"}
          hidden={manual}
          onBusy={onBusy}
          onConnected={onConnected}
          onResult={handleResult}
          onManual={() => setManual(true)}
        />
      ) : null}
      {manual ? (
        <ManualSlackSetup
          agentId={agentId}
          view={view}
          busy={busy}
          onSave={onSave}
          cloud={manualOnly}
          existingApp={
            Boolean(result && "appId" in result && result.appId) ||
            failure === "create_uncertain" ||
            failure === "manual_required"
          }
          unavailable={failure === "capability_missing" || failure === "manual_required"}
          onBack={canReturn ? () => setManual(false) : undefined}
        />
      ) : null}
    </>
  );
}

function ManualSlackSetup({
  agentId,
  view,
  busy,
  onSave,
  cloud,
  existingApp,
  unavailable,
  onBack,
}: {
  agentId: string;
  view: SlackConfigurationView;
  busy: boolean;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  cloud: boolean;
  existingApp: boolean;
  unavailable: boolean;
  onBack?: () => void;
}) {
  return (
    <>
      {cloud && view.allowedIntent === "create" ? (
        <p className="text-sm text-kumo-subtle">{m.im_slack_cloud_manual()}</p>
      ) : null}
      {unavailable ? <p className="text-sm text-kumo-subtle">{m.im_slack_auto_unavailable()}</p> : null}
      <SlackCredentialForm agentId={agentId} view={view} busy={busy} onSave={onSave} existingApp={existingApp} />
      {onBack ? (
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          {m.common_back()}
        </Button>
      ) : null}
    </>
  );
}

function slackEntryLabel(view: SlackConfigurationView, oauthAvailable: boolean) {
  if (!view.binding) return m.im_connect_slack({ provider: messagingProviderLabel("slack") });
  if (view.binding.reauthorizationRequired && view.preferredRecovery === "oauth" && oauthAvailable)
    return m.im_slack_explicit_oauth();
  if (view.identityClosure?.status === "pending") return m.im_slack_continue_setup();
  return m.im_slack_update_credentials();
}

function SlackAppEntry({
  view,
  trigger,
  onOpen,
  onOAuth,
  onDisconnect,
  onEdit,
}: {
  view: SlackConfigurationView;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onOAuth?: () => void;
  onDisconnect?: () => void;
  onEdit: () => void;
}) {
  const pending = view.identityClosure?.status === "pending";
  const binding = view.binding;
  if (!binding || pending || binding.reauthorizationRequired) {
    const recoverWithOAuth = binding?.reauthorizationRequired && view.preferredRecovery === "oauth";
    return (
      <>
        <Button
          ref={trigger}
          variant="secondary"
          icon={!binding ? <ProviderIcon className="size-4" provider="slack" /> : undefined}
          onClick={recoverWithOAuth && onOAuth ? onOAuth : onOpen}
        >
          {slackEntryLabel(view, Boolean(onOAuth))}
        </Button>
        {binding && onDisconnect ? (
          <Button variant="ghost" onClick={onDisconnect}>
            {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel("slack") }))}
          </Button>
        ) : null}
      </>
    );
  }
  if (binding.identity.provider !== "slack") return null;
  return (
    <>
      <a
        className={buttonClassName({ variant: "secondary" })}
        href={slackBotConversationUrl(binding.identity.appId, binding.identity.teamId)}
        target="_blank"
        rel="noreferrer"
      >
        {m.im_slack_open()}
      </a>
      {onDisconnect ? (
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button ref={trigger} variant="ghost" />}>
            {m.im_slack_more_settings()}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onClick={onEdit}>{m.im_slack_update_credentials()}</DropdownMenu.Item>
            <DropdownMenu.Item onClick={onOpen}>{m.im_slack_existing_app_help()}</DropdownMenu.Item>
            <DropdownMenu.Item onClick={onDisconnect}>
              {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel("slack") }))}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : (
        <Button ref={trigger} variant="ghost" onClick={onOpen}>
          {m.im_slack_more_settings()}
        </Button>
      )}
    </>
  );
}

function SlackCredentialForm({
  existingApp,
  agentId,
  view,
  busy,
  onSave,
}: {
  agentId: string;
  view: SlackConfigurationView;
  busy: boolean;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  existingApp: boolean;
}) {
  // Credentials live only in this mounted form. Success, close and Agent changes destroy it.
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  const create = view.allowedIntent === "create";
  function submit(event: FormEvent) {
    event.preventDefault();
    const input = credentialRequest(view, token, secret);
    if (!input) {
      setError(m.im_slack_changed_required());
      return;
    }
    setError(undefined);
    void onSave(input);
  }
  return (
    <form className="grid gap-4" onSubmit={submit} autoComplete="off">
      {create && existingApp ? (
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
          {m.im_slack_your_apps()}
        </a>
      ) : create ? (
        <SlackAppCreation agentId={agentId} view={view} />
      ) : (
        <p className="text-sm text-kumo-subtle">{m.im_slack_update_help()}</p>
      )}
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <label className="grid gap-2" htmlFor={`${id}-token`}>
        {m.im_slack_token_label()}
        <Input
          id={`${id}-token`}
          aria-label={m.im_slack_token_label()}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          required={create}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="text-sm text-kumo-subtle">{m.im_slack_token_help()}</span>
      </label>
      <Collapsible.Root defaultOpen={create}>
        {!create ? (
          <Collapsible.Trigger render={<Button variant="ghost" type="button" />}>
            {m.im_slack_change_secret()}
          </Collapsible.Trigger>
        ) : null}
        <Collapsible.Panel>
          <label className="grid gap-2 pt-2" htmlFor={`${id}-secret`}>
            {m.im_slack_secret_label()}
            <Input
              id={`${id}-secret`}
              aria-label={m.im_slack_secret_label()}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              required={create}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <span className="text-sm text-kumo-subtle">{m.im_slack_secret_help()}</span>
          </label>
        </Collapsible.Panel>
      </Collapsible.Root>
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={busy || (create ? !token.trim() || !secret.trim() : !token.trim() && !secret.trim())}
          loading={busy}
        >
          {m.im_slack_save_configuration()}
        </Button>
      </div>
    </form>
  );
}

function credentialRequest(
  view: SlackConfigurationView,
  token: string,
  secret: string,
): SaveSlackConfigurationRequest | undefined {
  const expected = view.expectedMessaging;
  if (view.allowedIntent === "create" && expected?.kind === "unbound") {
    return {
      intent: "create",
      expectedMessaging: expected,
      botAccessToken: token.trim(),
      signingSecret: secret.trim(),
    };
  }
  if (view.allowedIntent !== "reauthorize" || expected?.kind !== "bound" || expected.provider !== "slack")
    return undefined;
  if (!token.trim() && !secret.trim()) return undefined;
  return {
    intent: "reauthorize",
    expectedMessaging: { ...expected, provider: "slack" },
    ...(token.trim() ? { botAccessToken: token.trim() } : {}),
    ...(secret.trim() ? { signingSecret: secret.trim() } : {}),
  };
}

function SlackAppCreation({ agentId, view }: { agentId: string; view: SlackConfigurationView }) {
  const [fallback, setFallback] = useState<string>();
  const provider = messagingProviderLabel("slack");
  async function copy() {
    const text = JSON.stringify(slackAppManifest(agentId, view.agentDisplayName, view.eventsUrl), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setFallback(undefined);
    } catch {
      setFallback(text);
    }
  }
  return (
    <div className="grid gap-3">
      <a
        className={buttonClassName({ variant: "secondary" })}
        target="_blank"
        rel="noreferrer"
        href={slackAppCreateUrl(agentId, view.agentDisplayName, view.eventsUrl)}
      >
        {m.im_slack_create_app({ provider })}
      </a>
      <p className="break-all text-sm">
        {m.im_slack_bot_name({ provider, name: slackBotDisplayName(agentId, view.agentDisplayName) })}
      </p>
      <p className="text-sm text-kumo-subtle">{m.im_slack_create_instructions()}</p>
      <Collapsible.Root>
        <Collapsible.Trigger render={<Button variant="ghost" type="button" />}>
          {m.im_slack_create_help()}
        </Collapsible.Trigger>
        <Collapsible.Panel className="grid gap-3 pt-3">
          <p className="text-sm text-kumo-subtle">{m.im_slack_create_recovery({ provider })}</p>
          <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
            {m.im_slack_your_apps({ provider })}
          </a>
          <Button type="button" variant="ghost" onClick={() => void copy()}>
            {m.im_slack_copy_manifest()}
          </Button>
          {fallback ? (
            <InputArea
              aria-label={m.im_slack_copy_manifest()}
              className="w-full text-sm"
              readOnly
              value={fallback}
              rows={6}
            />
          ) : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

function SlackAppStatus({
  agentId,
  view,
  onUpdate,
  onOAuth,
  savedMethod,
  onAutoResume,
}: {
  agentId: string;
  view: SlackConfigurationView;
  onUpdate: () => void;
  onOAuth?: () => void;
  savedMethod?: "auto" | "manual";
  onAutoResume: () => void;
}) {
  const identity = view.binding?.identity;
  if (identity?.provider !== "slack") return null;
  const appSettings = `https://api.slack.com/apps/${encodeURIComponent(identity.appId)}/event-subscriptions`;
  const verified = view.identityClosure?.status === "verified";
  const verifyUrl = needsSlackUrlVerification(view, savedMethod);
  return (
    <>
      <strong>{view.binding?.bot.displayName ?? m.im_slack_current_app()}</strong>
      <Banner
        role="status"
        variant="secondary"
        description={
          verified
            ? m.im_slack_connected({ provider: messagingProviderLabel("slack") })
            : m.im_slack_pending_verification()
        }
      />
      {!verified ? (
        <p className="text-sm">{verifyUrl ? m.im_slack_verify_instructions() : m.im_slack_auto_saved()}</p>
      ) : null}
      {verified && !view.handoff?.handoffReady ? (
        <>
          <p role="status">
            {isHandoffChecking(view.handoff) ? m.im_slack_preparing_agent() : m.im_slack_check_agent()}
          </p>
          <Link className={buttonClassName({ variant: "primary" })} {...agentDetailLink(agentId)}>
            {m.im_slack_agent_status()}
          </Link>
        </>
      ) : (
        <a
          className={buttonClassName({ variant: "primary" })}
          href={verifyUrl ? appSettings : slackBotConversationUrl(identity.appId, identity.teamId)}
          target="_blank"
          rel="noreferrer"
        >
          {verifyUrl ? m.im_slack_open_settings() : m.im_slack_open_dm()}
        </a>
      )}
      <SlackAppHelp
        view={view}
        identity={identity}
        appSettings={appSettings}
        verified={verified}
        onUpdate={onUpdate}
        onOAuth={onOAuth}
        onAutoResume={onAutoResume}
      />
    </>
  );
}

function needsSlackUrlVerification(view: SlackConfigurationView, method?: "auto" | "manual") {
  return (
    view.identityClosure?.status !== "verified" &&
    method === "manual" &&
    !view.binding?.lastRuntimeObservationAt &&
    !view.binding?.lastInboundAt
  );
}

function SlackAppHelp({
  view,
  identity,
  appSettings,
  verified,
  onUpdate,
  onOAuth,
  onAutoResume,
}: {
  view: SlackConfigurationView;
  identity: Extract<NonNullable<SlackConfigurationView["binding"]>["identity"], { provider: "slack" }>;
  appSettings: string;
  verified: boolean;
  onUpdate: () => void;
  onOAuth?: () => void;
  onAutoResume: () => void;
}) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button variant="ghost" />}>{m.im_slack_existing_app_help()}</Collapsible.Trigger>
      <Collapsible.Panel className="grid gap-3 pt-3">
        <p className="text-sm text-kumo-subtle">
          {m.im_slack_existing_app_instructions({ provider: messagingProviderLabel("slack") })}
        </p>
        <a href={appSettings} target="_blank" rel="noreferrer">
          {m.im_slack_open_settings()}
        </a>
        {view.preferredRecovery !== "oauth" && !verified ? (
          <Button variant="secondary" onClick={onAutoResume}>
            {m.im_slack_auto_continue()}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onUpdate}>
          {m.im_slack_update_credentials()}
        </Button>
        {onOAuth ? (
          <Button variant="ghost" onClick={onOAuth}>
            {m.im_slack_explicit_oauth()}
          </Button>
        ) : null}
        <Collapsible.Root>
          <Collapsible.Trigger render={<Button variant="ghost" />}>{m.im_slack_diagnostics()}</Collapsible.Trigger>
          <Collapsible.Panel className="grid gap-2 pt-2 text-sm text-kumo-subtle">
            <p>{m.im_slack_auto_app_context({ app: identity.appId, team: identity.teamId })}</p>
            <code className="break-all">{view.eventsUrl}</code>
            <ul>
              {SLACK_SUBSCRIBED_BOT_EVENTS.map((event) => (
                <li key={event}>{event}</li>
              ))}
            </ul>
          </Collapsible.Panel>
        </Collapsible.Root>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function customAppError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return m.im_slack_status_failed();
  if (cause.code === "SLACK_BINDING_IDENTITY_MISMATCH") return m.im_slack_identity_mismatch();
  if (cause.code === "SLACK_CONFIGURATION_CONFLICT") return m.im_slack_configuration_changed();
  if (cause.code === "SLACK_CREDENTIALS_UNAVAILABLE") return m.im_slack_credentials_unavailable();
  if (cause.code === "SLACK_AUTH_INVALID" || cause.code === "SLACK_AUTH_IDENTITY_INCOMPLETE")
    return m.im_slack_invalid_token({ provider: messagingProviderLabel("slack") });
  return slackConfigurationMessage(cause.code ?? "");
}
