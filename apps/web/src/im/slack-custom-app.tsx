import type {
  SaveSlackConfigurationRequest,
  SlackAutoSetupResponse,
  SlackConfigurationView,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { spaceScriptBoundary } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import {
  Banner,
  Button,
  buttonClassName,
  Collapsible,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  InputArea,
  Text,
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
import {
  SlackAppIdentity,
  type SlackConnectionPanel,
  SlackSavedApp,
  slackConnectionDescription,
  slackConnectionTitle,
} from "./slack-connection-views.js";

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
  const [panel, setPanel] = useState<SlackConnectionPanel>("test");
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
    setPanel("test");
  }
  function start() {
    if (!view) return;
    setError(undefined);
    setAutoResume(false);
    setSavedMethod(undefined);
    setPanel("test");
    setEditing(view.allowedIntent === "create" || view.binding?.reauthorizationRequired ? view : undefined);
    setOpen(true);
  }
  function retrySetup() {
    if (!view) return;
    setError(undefined);
    setAutoResume(true);
    setEditing(view);
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
    setPanel("test");
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
          panel={panel}
          trigger={trigger}
          error={error}
          readError={configuration.isError}
          onClose={close}
          onBack={
            view.binding && (editing || panel !== "test")
              ? () => {
                  setEditing(undefined);
                  setAutoResume(false);
                  setError(undefined);
                  setPanel(editing || panel === "details" ? "help" : "test");
                }
              : undefined
          }
          onRetry={() => void configuration.refetch()}
        >
          {editing ? (
            <SlackSetupEditor
              api={api}
              agentId={agentId}
              view={editing}
              busy={busy}
              manualOnly={manualOnly}
              autoResume={autoResume}
              onBusy={setBusy}
              onSave={save}
              onCancel={
                view.binding
                  ? () => {
                      setEditing(undefined);
                      setAutoResume(false);
                      setError(undefined);
                      setPanel("help");
                    }
                  : undefined
              }
              onConnected={async () => {
                await configuration.refetch();
                setBusy(false);
                finishSave("auto");
              }}
            />
          ) : (
            <SlackSavedApp
              agentId={agentId}
              view={view}
              panel={panel}
              onPanel={setPanel}
              onClose={close}
              onUpdate={update}
              onOAuth={officialRecovery}
              savedMethod={savedMethod}
              manualOnly={manualOnly}
              onRetrySetup={retrySetup}
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

function slackDialogTitle(
  view: SlackConfigurationView,
  editing: SlackConfigurationView | undefined,
  autoResume: boolean,
  panel: SlackConnectionPanel,
): string {
  if (autoResume) return m.im_slack_retry_setup();
  if (editing?.allowedIntent === "reauthorize")
    return m.im_slack_update_title({ provider: messagingProviderLabel("slack") });
  if (editing || !view.binding) return m.im_connect_slack({ provider: messagingProviderLabel("slack") });
  return slackConnectionTitle(view, panel);
}

function SlackConfigurationDialog({
  view,
  editing,
  busy,
  autoResume,
  panel,
  trigger,
  error,
  readError,
  onClose,
  onBack,
  onRetry,
  children,
}: {
  view: SlackConfigurationView;
  editing?: SlackConfigurationView;
  busy: boolean;
  autoResume: boolean;
  panel: SlackConnectionPanel;
  trigger: RefObject<HTMLButtonElement | null>;
  error?: string;
  readError: boolean;
  onClose: () => void;
  onBack?: () => void;
  onRetry: () => void;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLSpanElement>(null);
  const navigationKey = `${panel}-${editing ? "editing" : "saved"}-${autoResume}`;
  useEffect(() => {
    if (navigationKey) headingRef.current?.focus();
  }, [navigationKey]);
  const title = slackDialogTitle(view, editing, autoResume, panel);
  return (
    <Dialog
      className="w-[calc(100vw-2rem)]! max-h-[calc(100dvh-4rem)]! sm:w-[36rem]! sm:max-w-xl sm:max-h-[calc(100dvh-8rem)]! sm:p-8"
      busy={busy}
      returnFocusRef={trigger}
      initialFocusRef={headingRef}
      onClose={onClose}
      onBack={onBack}
      closeLabel={m.common_close_title({ title })}
      eyebrow={
        <span className="mb-3 flex items-center gap-3 uppercase">
          <ProviderIcon className="size-6" provider="slack" />
          {m.im_slack_setup_label({ provider: messagingProviderLabel("slack") })}
        </span>
      }
      title={
        <Text
          as="span"
          variant="heading"
          headingSize="section"
          ref={headingRef}
          tabIndex={-1}
          DANGEROUS_className="outline-none"
        >
          {title}
        </Text>
      }
      description={
        autoResume
          ? m.im_slack_retry_setup_help()
          : !editing && view.binding
            ? slackConnectionDescription(view, panel)
            : undefined
      }
    >
      <div className="grid min-w-0 gap-6">
        {view.binding ? <SlackAppIdentity view={view} /> : null}
        {!view.binding ? <p className="text-sm text-kumo-subtle">{view.agentDisplayName}</p> : null}
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
  autoResume,
  manualOnly,
  busy,
  onBusy,
  onSave,
  onConnected,
  onCancel,
}: {
  agentId: string;
  view: SlackConfigurationView;
  api: SlackSetupApi;
  autoResume: boolean;
  manualOnly: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  onConnected: () => Promise<void>;
  onCancel?: () => void;
}) {
  const automatic = view.allowedIntent === "create" || autoResume;
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
          onCancel={onCancel}
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
  onCancel,
}: {
  agentId: string;
  view: SlackConfigurationView;
  busy: boolean;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  cloud: boolean;
  existingApp: boolean;
  unavailable: boolean;
  onBack?: () => void;
  onCancel?: () => void;
}) {
  return (
    <>
      {cloud && view.allowedIntent === "create" ? (
        <p className="text-sm text-kumo-subtle">{m.im_slack_cloud_manual()}</p>
      ) : null}
      {unavailable ? <p className="text-sm text-kumo-subtle">{m.im_slack_auto_unavailable()}</p> : null}
      <SlackCredentialForm
        agentId={agentId}
        view={view}
        busy={busy}
        onSave={onSave}
        existingApp={existingApp}
        onCancel={onCancel}
      />
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
  onCancel,
}: {
  agentId: string;
  view: SlackConfigurationView;
  busy: boolean;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  onCancel?: () => void;
  existingApp: boolean;
}) {
  // Credentials live only in this mounted form. Success, close and Agent changes destroy it.
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  const create = view.allowedIntent === "create";
  const canSave = Boolean(credentialRequest(view, token, secret));
  const showSaveHint = !create && !canSave;
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
      {create ? (
        <SlackAppCreation agentId={agentId} view={view} existingApp={existingApp} />
      ) : (
        <p className="text-sm text-kumo-subtle">{m.im_slack_update_help()}</p>
      )}
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <SlackTokenField id={`${id}-token`} create={create} busy={busy} token={token} onChange={setToken} />
      {!create && view.binding?.identity.provider === "slack" ? (
        <a
          className="text-sm text-kumo-link underline underline-offset-4"
          href={`https://api.slack.com/apps/${encodeURIComponent(view.binding.identity.appId)}/oauth`}
          target="_blank"
          rel="noreferrer"
        >
          {m.im_slack_open_permissions({ provider: messagingProviderLabel("slack") })}
        </a>
      ) : null}
      <Collapsible.Root defaultOpen={create}>
        {!create ? (
          <Collapsible.Trigger
            render={
              <Button
                aria-label={m.im_slack_change_secret()}
                className="h-auto! w-full justify-between! border-t border-kumo-line py-4!"
                variant="ghost"
                type="button"
                disabled={busy}
              />
            }
          >
            <span className="grid gap-1 text-left">
              <span>{m.im_slack_change_secret()}</span>
              <span className="text-sm font-normal text-kumo-subtle">
                {m.im_slack_secret_update_help({ provider: messagingProviderLabel("slack") })}
              </span>
            </span>
            <Icon name="chevron-down" />
          </Collapsible.Trigger>
        ) : null}
        <Collapsible.Panel>
          <label className="grid gap-2 pt-2" htmlFor={`${id}-secret`}>
            {m.im_slack_secret_label()}
            <Input
              id={`${id}-secret`}
              aria-label={m.im_slack_secret_label()}
              type="password"
              disabled={busy}
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
      {showSaveHint ? <p className="text-sm text-kumo-subtle">{m.im_slack_update_enable_save()}</p> : null}
      <div
        className={create ? "flex flex-wrap gap-3" : "flex flex-wrap justify-end gap-3 border-t border-kumo-line pt-5"}
      >
        {!create && onCancel ? (
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {m.common_cancel()}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={canSave ? "primary" : "secondary"}
          className="disabled:bg-kumo-tint! disabled:text-kumo-subtle! disabled:opacity-100!"
          disabled={busy || !canSave}
          loading={busy}
        >
          {create ? m.im_slack_save_configuration() : m.im_slack_save_changes()}
        </Button>
      </div>
    </form>
  );
}

function SlackTokenField({
  id,
  create,
  busy,
  token,
  onChange,
}: {
  id: string;
  create: boolean;
  busy: boolean;
  token: string;
  onChange: (value: string) => void;
}) {
  const [showToken, setShowToken] = useState(false);
  const label = create ? m.im_slack_token_label() : m.im_slack_new_token();
  return (
    <div className="grid gap-2">
      <label htmlFor={id}>{label}</label>
      <span className="relative block">
        <Input
          id={id}
          aria-label={label}
          aria-describedby={`${id}-help`}
          type={showToken ? "text" : "password"}
          className="w-full pr-12"
          placeholder={create ? undefined : m.im_slack_token_placeholder()}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          required={create}
          value={token}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-label={showToken ? m.im_slack_hide_token() : m.im_slack_show_token()}
          aria-pressed={showToken}
          disabled={busy}
          shape="square"
          size="compact"
          variant="ghost"
          onClick={() => setShowToken(!showToken)}
        >
          <Icon name={showToken ? "eye-slash" : "eye"} />
        </Button>
      </span>
      <span id={`${id}-help`} className="text-sm text-kumo-subtle">
        {m.im_slack_token_help()}
      </span>
    </div>
  );
}

function credentialRequest(
  view: SlackConfigurationView,
  token: string,
  secret: string,
): SaveSlackConfigurationRequest | undefined {
  const expected = view.expectedMessaging;
  if (view.allowedIntent === "create" && expected?.kind === "unbound") {
    if (!token.trim() || !secret.trim()) return undefined;
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

function SlackAppCreation({
  agentId,
  view,
  existingApp,
}: {
  agentId: string;
  view: SlackConfigurationView;
  existingApp: boolean;
}) {
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
  if (existingApp)
    return (
      <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
        {m.im_slack_your_apps()}
      </a>
    );
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

function customAppError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return m.im_slack_status_failed();
  if (cause.code === "SLACK_BINDING_IDENTITY_MISMATCH") return m.im_slack_identity_mismatch();
  if (cause.code === "SLACK_CONFIGURATION_CONFLICT") return m.im_slack_configuration_changed();
  if (cause.code === "SLACK_CREDENTIALS_UNAVAILABLE") return m.im_slack_credentials_unavailable();
  if (cause.code === "SLACK_AUTH_INVALID" || cause.code === "SLACK_AUTH_IDENTITY_INCOMPLETE")
    return m.im_slack_invalid_token({ provider: messagingProviderLabel("slack") });
  return slackConfigurationMessage(cause.code ?? "");
}
