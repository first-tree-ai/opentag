import type { SlackSetupAttempt, SlackSetupIntent } from "@opentag/shared/browser";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { Button } from "../ui/design-system.js";

const ACTIVE_STATES: readonly SlackSetupAttempt["state"][] = ["awaiting_credentials", "awaiting_verification"];
const POLL_INTERVAL_MS = 1_500;
const SLACK_SETUP_MESSAGES: Record<string, string> = {
  SLACK_APP_TEAM_ALREADY_BOUND:
    "This Slack App installation is already connected to another Agent. Create a separate App for this Agent.",
  SLACK_AUTH_INVALID: "Slack rejected the Bot User OAuth Token. Copy the Bot Token from OAuth & Permissions.",
  SLACK_BINDING_IDENTITY_MISMATCH:
    "The Bot Token and signed Slack event identify different Apps or workspaces. Check both credentials and retry.",
  SLACK_REPLACEMENT_REQUIRES_DIFFERENT_APP:
    "This is the current App. Use Reauthorize when you only need to replace credentials or permissions.",
  SLACK_SCOPE_REAUTH_REQUIRED:
    "The installed App is missing required bot scopes. Update the App from the generated manifest, reinstall it, and retry.",
  SLACK_SETUP_EXPIRED: "This Slack setup expired. Start again to create a fresh attempt.",
  SLACK_SIGNING_SECRET_INVALID:
    "Slack could not verify the submitted Signing Secret. Copy it again from Basic Information.",
  SLACK_UPSTREAM_UNAVAILABLE: "Slack did not return installation details. Check Slack availability and retry.",
};

export interface SlackSetupControl {
  start: (intent?: SlackSetupIntent) => Promise<boolean>;
  feedback: ReactNode;
}

interface SlackSetupProps {
  agentId: string;
  children: (control: SlackSetupControl) => ReactNode;
  onSuccess: () => void;
}

export function SlackSetup({ agentId, children, onSuccess }: SlackSetupProps) {
  return (
    <SlackSetupLifecycle agentId={agentId} key={agentId} onSuccess={onSuccess}>
      {children}
    </SlackSetupLifecycle>
  );
}

function SlackSetupLifecycle({ agentId, children, onSuccess }: SlackSetupProps) {
  const [attempt, setAttempt] = useState<SlackSetupAttempt>();
  const [error, setError] = useState<string>();
  const creatingRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const start = useCallback(
    async (intent: SlackSetupIntent = "create") => {
      if (creatingRef.current) return false;
      creatingRef.current = true;
      setError(undefined);
      try {
        const started = await browserApi.createSlackSetupAttempt(agentId, intent);
        setAttempt(started);
        if (started.state === "succeeded") onSuccessRef.current();
        return true;
      } catch (cause) {
        setError(normalizeSlackSetupError(cause, "Unable to start Slack setup"));
        return false;
      } finally {
        creatingRef.current = false;
      }
    },
    [agentId],
  );

  const activeAttemptId = attempt && ACTIVE_STATES.includes(attempt.state) ? attempt.id : undefined;
  useEffect(() => {
    if (!activeAttemptId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await browserApi.slackSetupAttempt(activeAttemptId);
        if (!active) return;
        setAttempt(next);
        if (next.state === "succeeded") {
          onSuccessRef.current();
          return;
        }
        if (ACTIVE_STATES.includes(next.state)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (!active) return;
        setError(normalizeSlackSetupError(cause, "Unable to refresh Slack setup"));
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeAttemptId]);

  return children({
    start,
    feedback: (
      <>
        {attempt ? (
          <SlackSetupFeedback attempt={attempt} onAttempt={setAttempt} onError={setError} onRetry={start} />
        ) : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </>
    ),
  });
}

function SlackSetupFeedback({
  attempt,
  onAttempt,
  onError,
  onRetry,
}: {
  attempt: SlackSetupAttempt;
  onAttempt: (attempt: SlackSetupAttempt) => void;
  onError: (message: string | undefined) => void;
  onRetry: (intent: SlackSetupIntent) => Promise<boolean>;
}) {
  const [botAccessToken, setBotAccessToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    onError(undefined);
    try {
      const next = await browserApi.submitSlackSetupCredentials(attempt.id, { botAccessToken, signingSecret });
      setBotAccessToken("");
      setSigningSecret("");
      onAttempt(next);
    } catch (cause) {
      onError(normalizeSlackSetupError(cause, "Unable to validate Slack credentials"));
    } finally {
      setSubmitting(false);
    }
  }

  const retryable = ["failed", "expired", "canceled"].includes(attempt.state);
  return (
    <div className="notice">
      <strong>Slack App setup</strong>
      <ol>
        <li>
          <a href={attempt.manifestUrl} rel="noreferrer" target="_blank">
            Create a dedicated Slack App from the generated manifest
          </a>
          , then install it to the intended workspace.
        </li>
        <li>
          In <strong>OAuth &amp; Permissions</strong>, copy the Bot User OAuth Token. In{" "}
          <strong>Basic Information</strong>, copy the Signing Secret.
        </li>
        <li>
          After validation, return to <strong>Event Subscriptions</strong> and retry this Request URL:
          <br />
          <code>{attempt.eventsUrl}</code>
        </li>
        <li>Invite the bot to a test channel and mention it. The first matching signed event completes activation.</li>
      </ol>
      <p>Required bot scopes: {attempt.requiredBotScopes.join(", ")}.</p>
      {attempt.identity ? (
        <p>
          Validated installation: App {attempt.identity.appId}, workspace {attempt.identity.teamId}, bot user{" "}
          {attempt.identity.botUserId}.
        </p>
      ) : null}
      {attempt.state === "awaiting_credentials" ? (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label>
            Bot User OAuth Token
            <input
              autoComplete="off"
              name="slackBotAccessToken"
              onChange={(event) => setBotAccessToken(event.target.value)}
              required
              type="password"
              value={botAccessToken}
            />
          </label>
          <label>
            Signing Secret
            <input
              autoComplete="off"
              name="slackSigningSecret"
              onChange={(event) => setSigningSecret(event.target.value)}
              required
              type="password"
              value={signingSecret}
            />
          </label>
          <Button disabled={submitting} type="submit">
            {submitting ? "Validating Slack installation…" : "Validate Slack installation"}
          </Button>
        </form>
      ) : null}
      {attempt.state === "awaiting_verification" ? (
        <p>
          Credentials validated. Slack must verify the Request URL, then send one matching App event before this binding
          becomes active.
        </p>
      ) : null}
      {attempt.errorCode ? <p>{SLACK_SETUP_MESSAGES[attempt.errorCode] ?? "Slack setup needs attention."}</p> : null}
      {retryable ? <Button onClick={() => void onRetry(attempt.intent)}>Retry Slack setup</Button> : null}
    </div>
  );
}

function normalizeSlackSetupError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && SLACK_SETUP_MESSAGES[code]) return SLACK_SETUP_MESSAGES[code];
  return cause instanceof Error ? cause.message : fallback;
}
