import type { SlackAutoSetupResponse } from "@opentag/shared/browser";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, buttonClassName, Input } from "../ui/design-system.js";
import { messagingProviderLabel } from "./provider-label.js";
import { slackConfigurationMessage } from "./slack-configuration.js";

export function SlackAutoConnect({
  agentId,
  onConnected,
  onBusy,
  resume = false,
}: {
  agentId: string;
  resume?: boolean;
  onConnected: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [result, setResult] = useState<SlackAutoSetupResponse>();
  const [error, setError] = useState<unknown>();
  const apiError = error instanceof ApiError ? error : undefined;
  const [challenge, setChallenge] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const running = useRef(false);
  const id = useId();
  const run = useCallback(
    async (action: "authorize" | "connect", force = false) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(undefined);
      onBusy(true);
      try {
        const next = await browserApi.autoSetupSlack(agentId, {
          action,
          ...(force ? { force: true } : {}),
          ...(action === "connect" && challenge.trim() ? { challenge: challenge.trim() } : {}),
        });
        setResult(next);
        setChallenge("");
        if (next.status === "connected") await onConnected();
      } catch (cause) {
        setResult({ status: "failed", code: "failed" });
        setError(cause);
      } finally {
        running.current = false;
        setBusy(false);
        onBusy(false);
      }
    },
    [agentId, challenge, onBusy, onConnected],
  );
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void run(resume ? "connect" : "authorize");
    }
  }, [run, resume]);
  const needsCode = result?.status === "authorization_required";
  return (
    <div className="grid gap-3">
      <strong>{m.im_slack_auto_title({ provider: messagingProviderLabel("slack") })}</strong>
      <p className="text-sm text-kumo-subtle">
        {m.im_slack_auto_permissions({ provider: messagingProviderLabel("slack") })}
      </p>
      {busy ? <p role="status">{m.im_slack_auto_working()}</p> : null}
      {needsCode ? (
        <SlackTicket ticket={result.ticket} id={id} busy={busy} challenge={challenge} onChallenge={setChallenge} />
      ) : null}
      {result && !apiError ? <SetupResult result={result} /> : null}
      {apiError ? (
        <Banner role="alert" variant="error" description={slackConfigurationMessage(apiError.code ?? "")} />
      ) : null}
      {apiError && ["SLACK_CONFIGURATION_CONFLICT", "SLACK_CREDENTIALS_UNAVAILABLE"].includes(apiError.code ?? "") ? (
        <p className="text-sm">{m.im_slack_auto_manual_required()}</p>
      ) : null}
      {result && apiError?.status !== 409 ? (
        <SetupButton result={result} busy={busy} challenge={challenge} run={run} />
      ) : null}
    </div>
  );
}

function SetupResult({ result }: { result: SlackAutoSetupResponse }) {
  if (result.status === "authorized") return <p>{m.im_slack_auto_authorized({ team: result.teamName })}</p>;
  if (result.status !== "failed" && result.status !== "approval_pending") return null;
  const approval = result.status === "approval_pending" || result.code === "approval_denied";
  return (
    <>
      {result.status === "failed" ? (
        <Banner role="alert" variant="error" description={failureMessage(result.code, result.errorCode)} />
      ) : (
        <Banner
          role="status"
          variant="secondary"
          description={m.im_slack_auto_approval_pending({ provider: messagingProviderLabel("slack") })}
        />
      )}
      {result.status === "failed" && result.errorCode ? (
        <p className="text-sm">
          {m.im_slack_auto_error_code({ provider: messagingProviderLabel("slack"), code: result.errorCode })}
        </p>
      ) : null}
      {result.appId && result.teamId ? (
        <div className="grid gap-2">
          <p className="text-sm">{m.im_slack_auto_app_context({ app: result.appId, team: result.teamId })}</p>
          {approval ? (
            <>
              <p className="text-sm">{m.im_slack_auto_approval_help({ provider: messagingProviderLabel("slack") })}</p>
              <a
                className={buttonClassName({ variant: "secondary" })}
                href={`https://app.slack.com/apps-manage/${encodeURIComponent(result.teamId)}`}
                target="_blank"
                rel="noreferrer"
              >
                {m.im_slack_auto_open_approvals({ provider: messagingProviderLabel("slack") })}
              </a>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function failureMessage(
  code: Extract<SlackAutoSetupResponse, { status: "failed" }>["code"],
  errorCode?: string,
): string {
  switch (code) {
    case "busy":
      return m.im_slack_auto_busy();
    case "create_failed":
      return m.im_slack_auto_create_failed({ provider: messagingProviderLabel("slack") });
    case "computer_unavailable":
    case "capability_missing":
      return m.im_slack_auto_unavailable();
    case "create_uncertain":
      return m.im_slack_auto_uncertain({ provider: messagingProviderLabel("slack") });
    case "install_failed":
      if (errorCode === "http_request_failed")
        return m.im_slack_auto_network_failed({ provider: messagingProviderLabel("slack") });
      return m.im_slack_auto_install_failed({ provider: messagingProviderLabel("slack") });
    case "approval_denied":
      return m.im_slack_auto_approval_denied({ provider: messagingProviderLabel("slack") });
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
}: {
  ticket: string;
  id: string;
  busy: boolean;
  challenge: string;
  onChallenge: (value: string) => void;
}) {
  const command = `/slackauthticket ${ticket}`;
  return (
    <>
      <p className="text-sm">{m.im_slack_auto_instructions({ provider: messagingProviderLabel("slack") })}</p>
      <Input
        aria-label={m.im_slack_auto_command({ provider: messagingProviderLabel("slack") })}
        readOnly
        value={command}
        onFocus={(e) => e.target.select()}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => void navigator.clipboard.writeText(command).catch(() => undefined)}
      >
        {m.common_copy()}
      </Button>
      <label className="grid gap-2" htmlFor={id}>
        {m.im_slack_auto_code({ provider: messagingProviderLabel("slack") })}
        <Input
          id={id}
          value={challenge}
          onChange={(e) => onChallenge(e.target.value)}
          autoComplete="off"
          maxLength={256}
          disabled={busy}
        />
      </label>
    </>
  );
}

function SetupButton({
  result,
  busy,
  challenge,
  run,
}: {
  result: SlackAutoSetupResponse;
  busy: boolean;
  challenge: string;
  run: (action: "authorize" | "connect", force?: boolean) => Promise<void>;
}) {
  if (
    result.status === "connected" ||
    (result.status === "failed" && ["create_uncertain", "manual_required"].includes(result.code))
  )
    return null;
  const authorize =
    result.status === "failed" &&
    ["authorization_failed", "computer_unavailable", "capability_missing"].includes(result.code);
  const label = authorize
    ? m.im_slack_auto_retry_authorization()
    : result.status === "approval_pending" || (result.status === "failed" && result.code !== "create_failed")
      ? m.im_slack_auto_continue()
      : m.im_slack_auto_connect();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        disabled={busy || (result.status === "authorization_required" && !challenge.trim())}
        loading={busy}
        onClick={() => void run(authorize ? "authorize" : "connect", authorize)}
      >
        {label}
      </Button>
      {result.status === "failed" && !["busy", "approval_denied"].includes(result.code) && !authorize ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void run("authorize", true)}>
          {m.im_slack_auto_retry_authorization()}
        </Button>
      ) : null}
    </div>
  );
}
