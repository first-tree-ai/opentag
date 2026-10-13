import {
  type SaveSlackConfigurationRequest,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackConfigurationView,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, buttonClassName, Collapsible, Dialog, Input, InputArea } from "../ui/design-system.js";
import { messagingProviderLabel } from "./provider-label.js";
import {
  slackAppCreateUrl,
  slackAppManifest,
  slackBotConversationUrl,
  slackBotDisplayName,
} from "./slack-app-manifest.js";
import { slackConfigurationMessage } from "./slack-configuration.js";

interface Props {
  agentId: string;
  bindingId?: string;
  onSaved: () => void;
  onOAuth?: () => void;
  oauthLabel?: string;
}

export function SlackCustomApp(props: Props) {
  return <SlackCustomAppFlow key={props.agentId} {...props} />;
}

function SlackCustomAppFlow({ agentId, bindingId, onSaved, onOAuth, oauthLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SlackConfigurationView>();
  const [busy, setBusy] = useState(false);
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
    queryFn: () => browserApi.slackConfiguration(agentId),
    retry: false,
    refetchInterval: (query) => (open && !editing && query.state.data?.handoff?.handoffReady === false ? 2_000 : false),
    refetchIntervalInBackground: false,
  });
  const view = configuration.data;

  function close() {
    if (saving.current) return;
    setEditing(undefined);
    setError(undefined);
    setOpen(false);
  }
  function start() {
    if (!view) return;
    setError(undefined);
    setEditing(view.allowedIntent === "create" || view.binding?.reauthorizationRequired ? view : undefined);
    setOpen(true);
  }
  function update() {
    if (view?.allowedIntent !== "reauthorize") return;
    setError(undefined);
    setEditing(view);
  }
  async function resumeAfterLostResponse(input: SaveSlackConfigurationRequest): Promise<boolean> {
    const observed = await configuration.refetch();
    const current = observed.data?.binding;
    if (!current) return false;
    const expected = input.expectedMessaging;
    if (expected.kind === "unbound") return true;
    return current.id === expected.bindingId && current.credentialGeneration > expected.credentialGeneration;
  }
  function finishSave() {
    if (!mounted.current) return;
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
      await browserApi.saveSlackConfiguration(agentId, input);
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

  if (!view || isNotFound(configuration.error))
    return unavailableSlackEntry(configuration.error, bindingId, onOAuth, oauthLabel);
  if (view.binding?.provider === "feishu") return null;
  if (view.blockedReason)
    return <Banner variant="error" description={customAppError(new ApiError(409, "", view.blockedReason))} />;
  return (
    <>
      <SlackAppEntry view={view} trigger={trigger} onOpen={start} onOAuth={onOAuth} />
      {open ? (
        <Dialog
          busy={busy}
          returnFocusRef={trigger}
          onClose={close}
          title={m.im_slack_custom_title({ provider: messagingProviderLabel("slack"), agent: view.agentDisplayName })}
        >
          <div className="grid gap-4">
            {error ? <Banner variant="error" role="alert" description={error} /> : null}
            {configuration.isError ? (
              <Banner
                variant="error"
                role="alert"
                description={m.im_slack_status_failed({ provider: messagingProviderLabel("slack") })}
              />
            ) : null}
            {editing ? (
              <SlackCredentialForm agentId={agentId} view={editing} busy={busy} onSave={save} onCancel={close} />
            ) : (
              <SlackAppStatus view={view} onUpdate={update} onOAuth={onOAuth} onClose={close} />
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function isNotFound(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}

function unavailableSlackEntry(
  error: unknown,
  bindingId: string | undefined,
  onOAuth: Props["onOAuth"],
  label?: string,
) {
  if (isNotFound(error))
    return bindingId && onOAuth ? <Button onClick={onOAuth}>{label ?? m.im_update_permissions()}</Button> : null;
  return error ? (
    <Banner variant="error" description={m.im_slack_status_failed({ provider: messagingProviderLabel("slack") })} />
  ) : null;
}

function SlackAppEntry({
  view,
  trigger,
  onOpen,
  onOAuth,
}: {
  view: SlackConfigurationView;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onOAuth?: () => void;
}) {
  const pending = view.identityClosure?.status === "pending";
  const binding = view.binding;
  if (!binding || pending || binding.reauthorizationRequired) {
    const label = !binding
      ? m.im_slack_custom_entry({ provider: messagingProviderLabel("slack") })
      : pending
        ? m.im_slack_continue_setup({ provider: messagingProviderLabel("slack") })
        : m.im_slack_update_credentials();
    const recoverWithOAuth = binding?.reauthorizationRequired && view.preferredRecovery === "oauth";
    return (
      <Button ref={trigger} variant="secondary" onClick={recoverWithOAuth && onOAuth ? onOAuth : onOpen}>
        {label}
      </Button>
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
        {m.im_slack_open_dm()}
      </a>
      <Button ref={trigger} variant="ghost" onClick={onOpen}>
        {m.im_slack_more_settings({ provider: messagingProviderLabel("slack") })}
      </Button>
    </>
  );
}

function SlackCredentialForm({
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
  onCancel: () => void;
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
      {create ? (
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
        <Button type="submit" disabled={busy} loading={busy}>
          {create
            ? m.im_slack_save_configuration({ provider: messagingProviderLabel("slack") })
            : m.im_slack_update_credentials()}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {m.common_cancel()}
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
  view,
  onUpdate,
  onOAuth,
  onClose,
}: {
  view: SlackConfigurationView;
  onUpdate: () => void;
  onOAuth?: () => void;
  onClose: () => void;
}) {
  const identity = view.binding?.identity;
  if (identity?.provider !== "slack") return null;
  const appSettings = `https://api.slack.com/apps/${encodeURIComponent(identity.appId)}/event-subscriptions`;
  const pending = view.identityClosure?.status === "pending";
  return (
    <>
      <strong>{view.binding?.bot.displayName ?? identity.appId}</strong>
      <span className="text-sm text-kumo-subtle">{identity.teamId}</span>
      <Banner role="status" variant="secondary" description={slackSetupStatus(view)} />
      <div className="flex flex-wrap gap-3">
        {pending && !view.binding?.lastInboundAt ? (
          <a className={buttonClassName({ variant: "secondary" })} href={appSettings} target="_blank" rel="noreferrer">
            {m.im_slack_open_settings({ provider: messagingProviderLabel("slack") })}
          </a>
        ) : null}
        <a
          className={buttonClassName({ variant: "secondary" })}
          href={slackBotConversationUrl(identity.appId, identity.teamId)}
          target="_blank"
          rel="noreferrer"
        >
          {m.im_slack_open_dm()}
        </a>
        <Button variant="secondary" onClick={onUpdate}>
          {m.im_slack_update_credentials()}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {m.im_slack_close()}
        </Button>
      </div>
      <Collapsible.Root>
        <Collapsible.Trigger render={<Button variant="ghost" />}>{m.im_slack_existing_app_help()}</Collapsible.Trigger>
        <Collapsible.Panel className="grid gap-3 pt-3">
          <p className="text-sm text-kumo-subtle">
            {m.im_slack_existing_app_instructions({ provider: messagingProviderLabel("slack") })}
          </p>
          <code className="break-all text-sm">{view.eventsUrl}</code>
          <ul className="text-sm">
            {SLACK_SUBSCRIBED_BOT_EVENTS.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ul>
          <a href={appSettings} target="_blank" rel="noreferrer">
            {m.im_slack_open_settings({ provider: messagingProviderLabel("slack") })}
          </a>
          {onOAuth ? (
            <Button variant="ghost" onClick={onOAuth}>
              {m.im_slack_explicit_oauth()}
            </Button>
          ) : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </>
  );
}

function slackSetupStatus(view: SlackConfigurationView): string {
  if (view.identityClosure?.status === "verified")
    return view.handoff?.handoffReady
      ? m.im_slack_ready({ provider: messagingProviderLabel("slack") })
      : m.im_slack_preparing_agent({ provider: messagingProviderLabel("slack") });
  if (view.binding?.lastInboundAt) return m.im_slack_verify_updated_credentials();
  return view.binding?.lastRuntimeObservationAt
    ? m.im_slack_waiting_message({ provider: messagingProviderLabel("slack") })
    : m.im_slack_verify_instructions();
}

function customAppError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return m.im_slack_status_failed({ provider: messagingProviderLabel("slack") });
  if (cause.code === "SLACK_BINDING_IDENTITY_MISMATCH") return m.im_slack_identity_mismatch();
  if (cause.code === "SLACK_CONFIGURATION_CONFLICT") return m.im_slack_configuration_changed();
  if (cause.code === "SLACK_CREDENTIALS_UNAVAILABLE") return m.im_slack_credentials_unavailable();
  if (cause.code === "SLACK_AUTH_INVALID" || cause.code === "SLACK_AUTH_IDENTITY_INCOMPLETE")
    return m.im_slack_invalid_token({ provider: messagingProviderLabel("slack") });
  return slackConfigurationMessage(cause.code ?? "");
}
