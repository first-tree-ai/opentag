import {
  type SaveSlackConfigurationRequest,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAutoSetupResponse,
  type SlackConfigurationView,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { AGENT_SETUP_READ_TIMEOUT_MS, ApiError, browserApi, withDeadline } from "../api.js";
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
import { clearStoredSlackAutoSetup, SlackAutoConnect } from "./slack-auto-connect.js";
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
  presentation?: "dialog" | "inline";
  onOpenChange?: (open: boolean) => void;
  api?: SlackSetupApi;
  agentId: string;
  bindingId?: string;
  onSaved: () => void;
  onOAuth?: () => void;
  cloud?: boolean;
  manualOnly?: boolean;
  readOnly?: boolean;
  onDisconnect?: () => void;
  renderTrigger?: (control: {
    onClick: () => void;
    disabled: boolean;
    ref: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}

export function SlackCustomApp(props: Props) {
  return <SlackCustomAppFlow key={`${props.agentId}:${props.readOnly ?? false}`} {...props} />;
}

function SlackCustomAppFlow({
  presentation = "dialog",
  onOpenChange,
  api = browserApi,
  agentId,
  bindingId,
  onSaved,
  onOAuth,
  cloud = false,
  manualOnly = false,
  readOnly = false,
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
  const wasOpen = useRef(false);
  useEffect(() => {
    onOpenChange?.(open);
    if (presentation === "inline" && wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open, onOpenChange, presentation]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const configuration = useQuery({
    queryKey: ["slack-configuration", agentId, bindingId],
    queryFn: ({ signal: querySignal }) =>
      withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) => api.slackConfiguration(agentId, signal), querySignal),
    // A new binding key must not remove the open post-save verification dialog.
    placeholderData: (previous) => previous,
    retry: false,
    refetchInterval: (query) => (open && !editing && !slackSetupReady(query.state.data) ? 2_000 : false),
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
    setEditing(
      !readOnly && (view.allowedIntent === "create" || view.binding?.reauthorizationRequired) ? view : undefined,
    );
    setOpen(true);
  }
  function update() {
    setAutoResume(false);
    if (readOnly || view?.allowedIntent !== "reauthorize") return;
    setError(undefined);
    setEditing(view);
  }
  function retrySetup() {
    if (readOnly || !view) return;
    setError(undefined);
    setAutoResume(true);
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
    clearStoredSlackAutoSetup(agentId);
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
    if (readOnly || saving.current) return;
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
  const officialRecovery = slackOfficialRecovery(readOnly, view?.preferredRecovery, onOAuth);
  return (
    <>
      {presentation !== "inline" || !open ? (
        <SlackConfigurationEntry
          readOnly={readOnly}
          view={view}
          bindingId={bindingId}
          busy={busy}
          renderTrigger={renderTrigger}
          trigger={trigger}
          onOpen={start}
          onOAuth={officialRecovery}
          onDisconnect={readOnly ? undefined : onDisconnect}
          onEdit={() => {
            start();
            update();
          }}
        />
      ) : null}
      {!open ? (
        <SlackConfigurationFeedback
          view={view}
          bindingId={bindingId}
          error={configuration.error}
          onRetry={() => void configuration.refetch()}
          onDisconnect={readOnly ? undefined : onDisconnect}
        />
      ) : null}
      {open && view ? (
        <SlackConfigurationDialog
          presentation={presentation}
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
            presentation === "dialog" && view.binding && (editing || panel !== "test")
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
          {(closeAction) => (
            <SlackConfigurationContent
              presentation={presentation}
              view={view}
              editing={editing}
              busy={busy}
              autoResume={autoResume}
              panel={panel}
              footerAction={closeAction}
              api={api}
              agentId={agentId}
              cloud={cloud}
              manualOnly={manualOnly}
              readOnly={readOnly}
              savedMethod={savedMethod}
              onBusy={setBusy}
              onSave={save}
              onConnected={async () => {
                await configuration.refetch();
                setBusy(false);
                finishSave("auto");
              }}
              onPanel={setPanel}
              onUpdate={update}
              onOAuth={officialRecovery}
              onRetrySetup={retrySetup}
              onClose={close}
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

function slackOfficialRecovery(
  readOnly: boolean,
  preferredRecovery: SlackConfigurationView["preferredRecovery"] | undefined,
  onOAuth: (() => void) | undefined,
): (() => void) | undefined {
  if (readOnly || preferredRecovery !== "oauth") return undefined;
  return onOAuth;
}

function SlackConfigurationContent({
  presentation,
  view,
  editing,
  busy,
  autoResume,
  panel,
  footerAction,
  api,
  agentId,
  cloud,
  manualOnly,
  readOnly,
  savedMethod,
  onBusy,
  onSave,
  onConnected,
  onPanel,
  onUpdate,
  onOAuth,
  onRetrySetup,
  onClose,
  onAutoResume,
}: {
  presentation: "dialog" | "inline";
  view: SlackConfigurationView;
  editing?: SlackConfigurationView;
  busy: boolean;
  autoResume: boolean;
  panel: SlackConnectionPanel;
  footerAction?: ReactNode;
  api: SlackSetupApi;
  agentId: string;
  cloud: boolean;
  manualOnly: boolean;
  readOnly: boolean;
  savedMethod?: "auto" | "manual";
  onBusy: (busy: boolean) => void;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  onConnected: () => Promise<void>;
  onPanel: (panel: SlackConnectionPanel) => void;
  onUpdate: () => void;
  onOAuth?: () => void;
  onRetrySetup: () => void;
  onClose: () => void;
  onAutoResume: () => void;
}) {
  if (editing) {
    return (
      <SlackSetupEditor
        footerAction={footerAction}
        api={api}
        agentId={agentId}
        view={editing}
        busy={busy}
        cloud={cloud}
        manualOnly={manualOnly}
        automatic={editing.allowedIntent === "create" || autoResume}
        onBusy={onBusy}
        onSave={onSave}
        onConnected={onConnected}
      />
    );
  }
  if (presentation === "dialog" && view.binding) {
    return (
      <SlackSavedApp
        readOnly={readOnly}
        agentId={agentId}
        view={view}
        panel={panel}
        onPanel={onPanel}
        onUpdate={onUpdate}
        onOAuth={onOAuth}
        savedMethod={savedMethod}
        manualOnly={manualOnly}
        cloud={cloud}
        onRetrySetup={onRetrySetup}
        onClose={onClose}
      />
    );
  }
  return (
    <SlackAppStatus
      readOnly={readOnly}
      agentId={agentId}
      view={view}
      onUpdate={onUpdate}
      onOAuth={onOAuth}
      savedMethod={savedMethod}
      onAutoResume={onAutoResume}
    />
  );
}

function SlackConfigurationEntry({
  readOnly,
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
  readOnly: boolean;
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
  if (readOnly)
    return (
      <>
        <Button ref={trigger} variant="secondary" disabled={!view?.binding} onClick={onOpen}>
          {bindingId ? m.im_slack_more_settings() : m.im_connect_slack({ provider: messagingProviderLabel("slack") })}
        </Button>
        {bindingId ? (
          <Button disabled variant="ghost">
            {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel("slack") }))}
          </Button>
        ) : null}
      </>
    );
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
  presentation,
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
  presentation: "dialog" | "inline";
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
  children: (closeAction?: ReactNode) => ReactNode;
}) {
  const inlineHeadingRef = useRef<HTMLHeadingElement>(null);
  const dialogHeadingRef = useRef<HTMLSpanElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (presentation === "inline") inlineHeadingRef.current?.focus();
  }, [presentation]);
  const navigationKey = `${panel}-${editing ? "editing" : "saved"}-${autoResume}`;
  useEffect(() => {
    if (presentation === "dialog" && navigationKey) dialogHeadingRef.current?.focus();
  }, [navigationKey, presentation]);
  const inlineTitle = slackInlineTitle(editing, autoResume);
  const dialogTitle = slackDialogTitle(view, editing, autoResume, panel);
  const closeAction = (
    <Button
      type="button"
      disabled={busy}
      variant="ghost"
      size="compact"
      onClick={onClose}
      aria-label={editing ? undefined : `${m.common_close()} ${inlineTitle}`}
    >
      {editing ? m.common_cancel() : m.common_close()}
    </Button>
  );
  if (presentation === "inline") {
    return (
      <SlackInlineConfiguration
        view={view}
        editing={editing}
        headingId={headingId}
        headingRef={inlineHeadingRef}
        title={inlineTitle}
        closeAction={closeAction}
        error={error}
        readError={readError}
        onRetry={onRetry}
      >
        {children(closeAction)}
      </SlackInlineConfiguration>
    );
  }
  return (
    <SlackDialogConfiguration
      view={view}
      editing={editing}
      busy={busy}
      autoResume={autoResume}
      panel={panel}
      trigger={trigger}
      headingRef={dialogHeadingRef}
      title={dialogTitle}
      error={error}
      readError={readError}
      onClose={onClose}
      onBack={onBack}
      onRetry={onRetry}
    >
      {children()}
    </SlackDialogConfiguration>
  );
}

function slackInlineTitle(editing: SlackConfigurationView | undefined, autoResume: boolean): string {
  if (editing?.allowedIntent === "reauthorize" && !autoResume) return m.im_slack_update_credentials();
  return m.im_connect_slack({ provider: messagingProviderLabel("slack") });
}

function slackDialogTitle(
  view: SlackConfigurationView,
  editing: SlackConfigurationView | undefined,
  autoResume: boolean,
  panel: SlackConnectionPanel,
): string {
  if (autoResume) return m.im_slack_retry_setup();
  if (editing?.allowedIntent === "reauthorize") return m.im_slack_update_credentials();
  if (editing || !view.binding) return m.im_connect_slack({ provider: messagingProviderLabel("slack") });
  return slackConnectionTitle(view, panel);
}

function SlackDialogFeedback({
  error,
  readError,
  onRetry,
}: {
  error?: string;
  readError: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      {readError ? (
        <div className="grid gap-2">
          <Banner variant="error" role="alert" description={m.im_slack_status_failed()} />
          <Button variant="secondary" onClick={onRetry}>
            {m.im_slack_retry()}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SlackInlineConfiguration({
  view,
  editing,
  headingId,
  headingRef,
  title,
  closeAction,
  error,
  readError,
  onRetry,
  children,
}: {
  view: SlackConfigurationView;
  editing?: SlackConfigurationView;
  headingId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  title: string;
  closeAction: ReactNode;
  error?: string;
  readError: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <section className="otv2-slack-inline otv2-connection-card" aria-labelledby={headingId}>
      <div className="otv2-connection-card__body">
        <div className="otv2-connection-card__identity">
          <Text as="h2" variant="heading" size="lg" id={headingId} ref={headingRef} tabIndex={-1}>
            <ProviderIcon className="size-6" provider="slack" />
            {title}
          </Text>
        </div>
        <div className="grid gap-4">
          <SlackDialogFeedback error={error} readError={readError} onRetry={onRetry} />
          {!editing && !view.binding ? <p role="status">{m.im_slack_auto_saved()}</p> : null}
          {children}
        </div>
      </div>
      {!editing ? (
        <div className="otv2-connection-card__footer otv2-connection-card__footer--finish">{closeAction}</div>
      ) : null}
    </section>
  );
}

function SlackDialogConfiguration({
  view,
  editing,
  busy,
  autoResume,
  panel,
  trigger,
  headingRef,
  title,
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
  headingRef: RefObject<HTMLSpanElement | null>;
  title: string;
  error?: string;
  readError: boolean;
  onClose: () => void;
  onBack?: () => void;
  onRetry: () => void;
  children: ReactNode;
}) {
  const description = autoResume
    ? m.im_slack_retry_setup_help()
    : !editing && view.binding
      ? slackConnectionDescription(view, panel)
      : undefined;
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
      description={description}
    >
      <div className="grid min-w-0 gap-6">
        {view.binding ? <SlackAppIdentity view={view} /> : null}
        {!view.binding ? <p className="text-sm text-kumo-subtle">{view.agentDisplayName}</p> : null}
        <SlackDialogFeedback error={error} readError={readError} onRetry={onRetry} />
        {children}
      </div>
    </Dialog>
  );
}

function SlackSetupEditor({
  footerAction,
  api,
  agentId,
  view,
  automatic,
  cloud = false,
  manualOnly,
  busy,
  onBusy,
  onSave,
  onConnected,
}: {
  footerAction?: ReactNode;
  agentId: string;
  view: SlackConfigurationView;
  api: SlackSetupApi;
  automatic: boolean;
  cloud?: boolean;
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
          footerAction={footerAction}
          api={api}
          agentId={agentId}
          cloud={cloud}
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
          footerAction={footerAction}
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
  footerAction,
  agentId,
  view,
  busy,
  onSave,
  cloud,
  existingApp,
  unavailable,
  onBack,
}: {
  footerAction?: ReactNode;
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
      <SlackCredentialForm
        agentId={agentId}
        view={view}
        busy={busy}
        detailed={!footerAction && view.allowedIntent === "reauthorize"}
        onSave={onSave}
        existingApp={existingApp}
        footerAction={
          footerAction ? (
            <>
              {onBack ? (
                <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
                  {m.common_back()}
                </Button>
              ) : null}
              {footerAction}
            </>
          ) : undefined
        }
      />
      {onBack && !footerAction ? (
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
  footerAction,
  existingApp,
  agentId,
  view,
  busy,
  detailed,
  onSave,
}: {
  footerAction?: ReactNode;
  agentId: string;
  view: SlackConfigurationView;
  busy: boolean;
  detailed: boolean;
  onSave: (input: SaveSlackConfigurationRequest) => Promise<void>;
  existingApp: boolean;
}) {
  // Credentials live only in this mounted form. Success, close and Agent changes destroy it.
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  const create = view.allowedIntent === "create";
  const canSave = Boolean(credentialRequest(view, token, secret));
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
      <SlackCredentialIntro create={create} existingApp={existingApp} agentId={agentId} view={view} />
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <SlackCredentialToken
        id={`${id}-token`}
        view={view}
        busy={busy}
        create={create}
        detailed={detailed}
        token={token}
        onChange={setToken}
      />
      <SlackCredentialSecret
        id={`${id}-secret`}
        busy={busy}
        create={create}
        detailed={detailed}
        secret={secret}
        onChange={setSecret}
      />
      {detailed && !canSave ? <p className="text-sm text-kumo-subtle">{m.im_slack_update_enable_save()}</p> : null}
      <div className={footerAction ? "otv2-connection-form-actions" : "flex flex-wrap gap-3"}>
        {footerAction}
        <Button
          type="submit"
          variant={detailed && !canSave ? "secondary" : "primary"}
          className={detailed ? "disabled:bg-kumo-tint! disabled:text-kumo-subtle! disabled:opacity-100!" : undefined}
          disabled={busy || !canSave}
          loading={busy}
        >
          {detailed ? m.im_slack_save_changes() : m.im_slack_save_configuration()}
        </Button>
      </div>
    </form>
  );
}

function SlackCredentialIntro({
  create,
  existingApp,
  agentId,
  view,
}: {
  create: boolean;
  existingApp: boolean;
  agentId: string;
  view: SlackConfigurationView;
}) {
  if (!create) return <p className="text-sm text-kumo-subtle">{m.im_slack_update_help()}</p>;
  if (!existingApp) return <SlackAppCreation agentId={agentId} view={view} />;
  return (
    <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
      {m.im_slack_your_apps()}
    </a>
  );
}

function SlackCredentialToken({
  id,
  view,
  busy,
  create,
  detailed,
  token,
  onChange,
}: {
  id: string;
  view: SlackConfigurationView;
  busy: boolean;
  create: boolean;
  detailed: boolean;
  token: string;
  onChange: (value: string) => void;
}) {
  const slackIdentity = view.binding?.identity.provider === "slack" ? view.binding.identity : undefined;
  return (
    <>
      {detailed ? (
        <SlackTokenField id={id} busy={busy} token={token} onChange={onChange} />
      ) : (
        <label className="grid gap-2" htmlFor={id}>
          {m.im_slack_token_label()}
          <Input
            id={id}
            aria-label={m.im_slack_token_label()}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            required={create}
            value={token}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="text-sm text-kumo-subtle">{m.im_slack_token_help()}</span>
        </label>
      )}
      {detailed && slackIdentity ? (
        <a
          className="text-sm text-kumo-link underline underline-offset-4"
          href={`https://api.slack.com/apps/${encodeURIComponent(slackIdentity.appId)}/oauth`}
          target="_blank"
          rel="noreferrer"
        >
          {m.im_slack_open_permissions({ provider: messagingProviderLabel("slack") })}
        </a>
      ) : null}
    </>
  );
}

function SlackCredentialSecret({
  id,
  busy,
  create,
  detailed,
  secret,
  onChange,
}: {
  id: string;
  busy: boolean;
  create: boolean;
  detailed: boolean;
  secret: string;
  onChange: (value: string) => void;
}) {
  const trigger = detailed ? (
    <Button
      aria-label={m.im_slack_change_secret()}
      className="h-auto! w-full justify-between! border-t border-kumo-line py-4!"
      variant="ghost"
      type="button"
      disabled={busy}
    />
  ) : (
    <Button variant="ghost" type="button" />
  );
  const triggerLabel = detailed ? (
    <>
      <span className="grid gap-1 text-left">
        <span>{m.im_slack_change_secret()}</span>
        <span className="text-sm font-normal text-kumo-subtle">
          {m.im_slack_secret_update_help({ provider: messagingProviderLabel("slack") })}
        </span>
      </span>
      <Icon name="chevron-down" />
    </>
  ) : (
    m.im_slack_change_secret()
  );
  return (
    <Collapsible.Root defaultOpen={create}>
      {!create ? <Collapsible.Trigger render={trigger}>{triggerLabel}</Collapsible.Trigger> : null}
      <Collapsible.Panel>
        <label className="grid gap-2 pt-2" htmlFor={id}>
          {m.im_slack_secret_label()}
          <Input
            id={id}
            aria-label={m.im_slack_secret_label()}
            type="password"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            maxLength={512}
            required={create}
            value={secret}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="text-sm text-kumo-subtle">{m.im_slack_secret_help()}</span>
        </label>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function SlackTokenField({
  id,
  busy,
  token,
  onChange,
}: {
  id: string;
  busy: boolean;
  token: string;
  onChange: (value: string) => void;
}) {
  const [showToken, setShowToken] = useState(false);
  const label = m.im_slack_new_token();
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
          placeholder={m.im_slack_token_placeholder()}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
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
  const botAccessToken = token.trim();
  const signingSecret = secret.trim();
  if (view.allowedIntent === "create" && expected?.kind === "unbound") {
    if (!botAccessToken || !signingSecret) return undefined;
    return {
      intent: "create",
      expectedMessaging: expected,
      botAccessToken,
      signingSecret,
    };
  }
  if (view.allowedIntent !== "reauthorize" || expected?.kind !== "bound" || expected.provider !== "slack")
    return undefined;
  if (!botAccessToken && !signingSecret) return undefined;
  return {
    intent: "reauthorize",
    expectedMessaging: { ...expected, provider: "slack" },
    ...(botAccessToken ? { botAccessToken } : {}),
    ...(signingSecret ? { signingSecret } : {}),
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

function slackSetupReady(view: SlackConfigurationView | undefined): boolean {
  return Boolean(
    view?.identityClosure?.status === "verified" &&
      view.handoff?.bindingState === "active" &&
      view.handoff.handoffReady,
  );
}

function slackVerificationLabel(view: SlackConfigurationView): string {
  if (slackSetupReady(view)) return m.im_slack_connected({ provider: messagingProviderLabel("slack") });
  return view.identityClosure?.status === "verified"
    ? m.im_slack_identity_verified()
    : m.im_slack_pending_verification();
}

function SlackAppStatus({
  readOnly,
  agentId,
  view,
  onUpdate,
  onOAuth,
  savedMethod,
  onAutoResume,
}: {
  readOnly: boolean;
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
      <Banner role="status" variant="secondary" description={slackVerificationLabel(view)} />
      {!verified ? (
        <p className="text-sm">{verifyUrl ? m.im_slack_verify_instructions() : m.im_slack_auto_saved()}</p>
      ) : null}
      {slackSetupReady(view) ? (
        <p className="text-sm">{m.im_slack_delivery_check({ provider: messagingProviderLabel("slack") })}</p>
      ) : null}
      {verified && !slackSetupReady(view) ? (
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
        readOnly={readOnly}
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
  readOnly,
  view,
  identity,
  appSettings,
  verified,
  onUpdate,
  onOAuth,
  onAutoResume,
}: {
  readOnly: boolean;
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
          <Button disabled={readOnly} variant="secondary" onClick={onAutoResume}>
            {m.im_slack_auto_continue()}
          </Button>
        ) : null}
        <Button disabled={readOnly} variant="secondary" onClick={onUpdate}>
          {m.im_slack_update_credentials()}
        </Button>
        {onOAuth || (readOnly && view.preferredRecovery === "oauth") ? (
          <Button disabled={readOnly} variant="ghost" onClick={onOAuth}>
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
