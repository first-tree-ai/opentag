import type { SlackAutoSetupRequest, SlackAutoSetupResponse } from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, buttonClassName, Collapsible, Input, InputArea } from "../ui/design-system.js";
import { messagingProviderLabel } from "./provider-label.js";
import { slackConfigurationMessage } from "./slack-configuration.js";

type Failure = Extract<SlackAutoSetupResponse, { status: "failed" }>;

export function SlackAutoConnect({
  footerAction,
  api = browserApi,
  agentId,
  onConnected,
  onBusy,
  onResult,
  onManual,
  resume = false,
  hidden = false,
}: {
  footerAction?: ReactNode;
  agentId: string;
  api?: { autoSetupSlack: typeof browserApi.autoSetupSlack };
  resume?: boolean;
  hidden?: boolean;
  onConnected: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onResult?: (result: SlackAutoSetupResponse) => void;
  onManual?: () => void;
}) {
  const [result, setResult] = useState<SlackAutoSetupResponse>();
  const [error, setError] = useState<unknown>();
  const [challenge, setChallenge] = useState("");
  const [operation, setOperation] = useState<"authorize" | "connect">();
  const busy = operation !== undefined;
  const started = useRef(false);
  const running = useRef(false);
  const lastAction = useRef<"authorize" | "connect">(resume ? "connect" : "authorize");
  const mounted = useRef(true);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (action: "authorize" | "connect", force = false) => {
      if (running.current) return;
      running.current = true;
      lastAction.current = action;
      setOperation(action);
      setError(undefined);
      onBusy(true);
      try {
        const next = await api.autoSetupSlack(agentId, setupRequest(action, force, challenge));
        if (!mounted.current) return;
        setResult(next);
        setChallenge("");
        onResult?.(next);
        if (next.status === "connected") await onConnected();
      } catch (cause) {
        if (!mounted.current) return;
        setResult({ status: "failed", code: "failed" });
        setError(cause);
      } finally {
        running.current = false;
        if (mounted.current) {
          setOperation(undefined);
          onBusy(false);
        }
      }
    },
    [api, agentId, challenge, onBusy, onConnected, onResult],
  );
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void run(resume ? "connect" : "authorize");
    }
  }, [run, resume]);
  return (
    <div hidden={hidden}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (result?.status === "authorization_required" && challenge.trim()) void run("connect");
        }}
      >
        {operation ? <SlackSetupProgress key={operation} operation={operation} /> : null}
        {result?.status === "authorization_required" ? (
          <SlackTicket
            ticket={result.ticket}
            id={id}
            busy={busy}
            hidden={hidden}
            challenge={challenge}
            onChallenge={setChallenge}
          />
        ) : null}
        <SlackSetupFeedback result={result} error={error} />
        <SlackSetupActions
          result={result}
          error={error}
          lastAction={lastAction.current}
          busy={busy}
          challenge={challenge}
          run={run}
          onManual={onManual}
          footerAction={footerAction}
        />
      </form>
    </div>
  );
}

function SlackSetupFeedback({ result, error }: { result?: SlackAutoSetupResponse; error: unknown }) {
  if (error === undefined) return result ? <SetupResult result={result} /> : null;
  const apiError = error instanceof ApiError ? error : undefined;
  const uncertain = !apiError || apiError.status >= 500;
  return (
    <>
      <Banner
        role="alert"
        variant="error"
        description={slackConfigurationMessage(
          apiError?.code ?? "",
          uncertain ? m.im_slack_auto_uncertain_response() : m.im_slack_auto_failed(),
        )}
      />
      {apiError && ["SLACK_CONFIGURATION_CONFLICT", "SLACK_CREDENTIALS_UNAVAILABLE"].includes(apiError.code ?? "") ? (
        <p className="text-sm">{m.im_slack_auto_manual_required()}</p>
      ) : null}
    </>
  );
}

function SlackSetupActions({
  result,
  error,
  lastAction,
  busy,
  challenge,
  run,
  onManual,
  footerAction,
}: {
  result?: SlackAutoSetupResponse;
  error: unknown;
  lastAction: "authorize" | "connect";
  busy: boolean;
  challenge: string;
  run: (action: "authorize" | "connect", force?: boolean) => Promise<void>;
  onManual?: () => void;
  footerAction?: ReactNode;
}) {
  const conflict = error instanceof ApiError && error.status === 409;
  return (
    <div className={autoActionsClass(footerAction)}>
      {onManual && !(result?.status === "failed" && result.code === "approval_denied") ? (
        <Button type="button" variant="ghost" disabled={busy} onClick={onManual}>
          {m.im_slack_auto_manual()}
        </Button>
      ) : null}
      {footerAction}
      {result && !conflict ? (
        <SetupButton
          result={result}
          busy={busy}
          challenge={challenge}
          run={run}
          retryAction={error !== undefined ? lastAction : undefined}
        />
      ) : null}
    </div>
  );
}

/** A slow operation is not a timeout or proof of failure. Keep the existing single-flight request. */
function SlackSetupProgress({ operation }: { operation: "authorize" | "connect" }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="status" className="text-sm text-kumo-subtle">
      {slow
        ? m.im_slack_auto_slow()
        : operation === "authorize"
          ? m.im_slack_auto_preparing_ticket()
          : m.im_slack_auto_working()}
    </p>
  );
}

function autoActionsClass(footerAction: ReactNode) {
  return footerAction ? "otv2-connection-form-actions" : "flex flex-wrap items-center justify-between gap-3";
}

function setupRequest(action: "authorize" | "connect", force: boolean, challenge: string): SlackAutoSetupRequest {
  if (action === "authorize") return force ? { action, force: true } : { action };
  return challenge.trim() ? { action, challenge: challenge.trim() } : { action };
}

function SetupResult({ result }: { result: SlackAutoSetupResponse }) {
  if (result.status === "authorized")
    return <p role="status">{m.im_slack_auto_authorized({ team: result.teamName })}</p>;
  if (result.status !== "failed" && result.status !== "approval_pending") return null;
  const approval = result.status === "approval_pending" || result.code === "approval_denied";
  return (
    <>
      <Banner
        role={result.status === "failed" ? "alert" : "status"}
        variant={result.status === "failed" ? "error" : "secondary"}
        description={
          result.status === "failed"
            ? failureMessage(result.code, result.errorCode)
            : m.im_slack_auto_approval_pending()
        }
      />
      {approval && result.teamId ? (
        <a
          className={buttonClassName({ variant: "primary" })}
          href={`https://app.slack.com/apps-manage/${encodeURIComponent(result.teamId)}`}
          target="_blank"
          rel="noreferrer"
        >
          {m.im_slack_auto_open_approvals()}
        </a>
      ) : null}
      {result.status === "failed" && result.code === "create_uncertain" ? (
        <a
          className={buttonClassName({ variant: "primary" })}
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
        >
          {m.im_slack_your_apps()}
        </a>
      ) : null}
      <SetupDiagnostics result={result} approval={approval} />
    </>
  );
}

function SetupDiagnostics({
  result,
  approval,
}: {
  result: Failure | Extract<SlackAutoSetupResponse, { status: "approval_pending" }>;
  approval: boolean;
}) {
  if (!approval && !(result.appId && result.teamId) && !(result.status === "failed" && result.errorCode)) return null;
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button variant="ghost" type="button" />}>
        {m.im_slack_diagnostics()}
      </Collapsible.Trigger>
      <Collapsible.Panel className="grid gap-2 pt-2 text-sm text-kumo-subtle">
        {result.appId && result.teamId ? (
          <p>{m.im_slack_auto_app_context({ app: result.appId, team: result.teamId })}</p>
        ) : null}
        {result.status === "failed" && result.errorCode ? (
          <p>{m.im_slack_auto_error_code({ code: result.errorCode, provider: messagingProviderLabel("slack") })}</p>
        ) : null}
        {approval ? <p>{m.im_slack_auto_approval_help({ provider: messagingProviderLabel("slack") })}</p> : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function failureMessage(code: Failure["code"], errorCode?: string): string {
  switch (code) {
    case "busy":
      return m.im_slack_auto_busy();
    case "create_failed":
      return m.im_slack_auto_create_failed();
    case "computer_unavailable":
      return m.im_slack_auto_computer_offline();
    case "capability_missing":
      return m.im_slack_auto_unavailable();
    case "authorization_failed":
      return m.im_slack_auto_authorization_failed({ provider: messagingProviderLabel("slack") });
    case "create_uncertain":
      return m.im_slack_auto_uncertain();
    case "install_failed":
      return errorCode === "http_request_failed" ? m.im_slack_auto_network_failed() : m.im_slack_auto_install_failed();
    case "approval_denied":
      return m.im_slack_auto_approval_denied();
    case "callbacks_failed":
      return m.im_slack_auto_callbacks_failed();
    case "manual_required":
      return m.im_slack_auto_existing_manual();
    default:
      return m.im_slack_auto_failed();
  }
}

function SlackTicket({
  ticket,
  id,
  busy,
  challenge,
  onChallenge,
  hidden,
}: {
  ticket: string;
  id: string;
  busy: boolean;
  challenge: string;
  onChallenge: (value: string) => void;
  hidden: boolean;
}) {
  const command = `/slackauthticket ${ticket}`;
  const input = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    const field = input.current;
    if (!field || hidden || field.value !== command) return;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    resize();
    setCopied(false);
    setCopyFailed(false);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [command, hidden]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      input.current?.focus();
      input.current?.select();
      setCopied(false);
      setCopyFailed(true);
    }
  }
  return (
    <>
      <p className="text-sm text-kumo-subtle">{m.im_slack_auto_permissions()}</p>
      <div className="grid gap-2">
        <label htmlFor={`${id}-command`} className="text-sm font-medium">
          1 {m.im_slack_auto_command({ provider: messagingProviderLabel("slack") })}
        </label>
        <p id={`${id}-command-help`} className="text-sm text-kumo-subtle">
          {m.im_slack_auto_instructions()}
        </p>
        <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
          <InputArea
            ref={input}
            id={`${id}-command`}
            aria-label={m.im_slack_auto_command({ provider: messagingProviderLabel("slack") })}
            aria-describedby={`${id}-command-help`}
            readOnly
            value={command}
            rows={2}
            className="min-w-0 flex-1 basis-full break-all font-mono text-sm sm:basis-auto"
            onFocus={(event) => event.target.select()}
          />
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void copy()}>
            {copied ? m.im_slack_copied() : m.common_copy()}
          </Button>
        </div>
        {copyFailed ? (
          <p role="alert" className="text-sm text-kumo-subtle">
            {m.im_slack_copy_failed()}
          </p>
        ) : null}
        {copied ? (
          <span className="sr-only" role="status">
            {m.im_slack_copied()}
          </span>
        ) : null}
      </div>
      <label className="grid gap-2" htmlFor={id}>
        <span className="text-sm font-medium">2 {m.im_slack_auto_code()}</span>
        <span id={`${id}-code-help`} className="text-sm text-kumo-subtle">
          {m.im_slack_auto_code_help({ provider: messagingProviderLabel("slack") })}
        </span>
        <Input
          id={id}
          aria-describedby={`${id}-code-help`}
          aria-label={m.im_slack_auto_code()}
          value={challenge}
          placeholder={m.im_slack_code_placeholder()}
          onChange={(event) => onChallenge(event.target.value)}
          autoComplete="off"
          maxLength={256}
          disabled={busy}
        />
      </label>
    </>
  );
}

type SetupAction = { action: "authorize" | "connect"; label: string; force?: boolean; secondary?: boolean };

function setupAction(result: SlackAutoSetupResponse): SetupAction | undefined {
  if (result.status === "connected") return undefined;
  if (result.status === "failed") return failureAction(result.code);
  return {
    action: "connect",
    label: result.status === "approval_pending" ? m.im_slack_auto_continue() : m.im_slack_auto_connect(),
    secondary: result.status === "approval_pending",
  };
}

function failureAction(code: Failure["code"]): SetupAction | undefined {
  switch (code) {
    case "create_uncertain":
    case "manual_required":
    case "approval_denied":
    case "capability_missing":
    case "computer_unavailable":
      return undefined;
    case "authorization_failed":
      return { action: "authorize", label: m.im_slack_auto_retry_authorization(), force: true };
    case "busy":
    case "callbacks_failed":
      return { action: "connect", label: m.im_slack_auto_continue() };
    default:
      return { action: "connect", label: m.im_slack_retry() };
  }
}

function SetupButton({
  retryAction,
  result,
  busy,
  challenge,
  run,
}: {
  retryAction?: "authorize" | "connect";
  result: SlackAutoSetupResponse;
  busy: boolean;
  challenge: string;
  run: (action: "authorize" | "connect", force?: boolean) => Promise<void>;
}) {
  const next = retryAction ? { action: retryAction, label: m.im_slack_retry() } : setupAction(result);
  if (!next) return null;
  const submit = result.status === "authorization_required";
  return (
    <div className="ml-auto flex justify-end">
      <Button
        type={submit ? "submit" : "button"}
        variant={next.secondary ? "secondary" : "primary"}
        disabled={busy || (submit && !challenge.trim())}
        loading={busy}
        onClick={submit ? undefined : () => void run(next.action, next.force)}
      >
        {busy ? m.im_slack_auto_working() : next.label}
      </Button>
    </div>
  );
}
