import type { SlackSetupAttempt, SlackSetupIntent } from "@opentag/shared/browser";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { Button } from "../ui/design-system.js";

const ACTIVE_STATES: readonly SlackSetupAttempt["state"][] = ["awaiting_credentials", "awaiting_verification"];
const RETRYABLE_STATES: readonly SlackSetupAttempt["state"][] = ["failed", "expired", "canceled"];
const POLL_INTERVAL_MS = 1_500;
const POLL_MAX_INTERVAL_MS = 30_000;
/** Consecutive transient poll failures tolerated before polling stops and asks for a manual refresh. */
const POLL_MAX_FAILURES = 6;
const SLACK_SETUP_MESSAGES: Record<string, string> = {
  IM_BINDING_FORBIDDEN: "Only Admins can manage this Slack setup.",
  IM_BINDING_PROVIDER_IMMUTABLE:
    "This Agent is connected to a different IM provider. Disable that binding before connecting Slack.",
  SLACK_ACTIVATION_FAILED:
    "Slack activation failed on the Server. Retry the setup, and contact an admin if it keeps failing.",
  SLACK_APP_TEAM_ALREADY_BOUND:
    "This Slack App installation is already connected to another Agent. Create a separate App for this Agent.",
  SLACK_AUTH_INVALID: "Slack rejected the Bot User OAuth Token. Copy the Bot Token from OAuth & Permissions.",
  SLACK_BINDING_IDENTITY_MISMATCH:
    "The Bot Token and signed Slack event identify different Apps or workspaces. Check both credentials and retry.",
  SLACK_BOT_ID_REAUTH_REQUIRED: "The Slack bot identity changed. Reauthorize to refresh the binding.",
  SLACK_IM_BINDING_ALREADY_EXISTS: "This Agent already has a Slack binding. Use Reauthorize or Replace instead.",
  SLACK_REAUTHORIZATION_REQUIRES_BINDING: "Reauthorization needs an active Slack binding. Connect a Slack App first.",
  SLACK_REPLACEMENT_REQUIRES_BINDING:
    "Replacement needs an active Slack binding. Resume or cancel the current setup instead.",
  SLACK_REPLACEMENT_REQUIRES_DIFFERENT_APP:
    "This is the current App. Use Reauthorize when you only need to replace credentials or permissions.",
  SLACK_SCOPE_REAUTH_REQUIRED:
    "The installed App is missing required bot scopes. Update the App from the generated manifest, reinstall it, and retry.",
  SLACK_SETUP_CANCELED: "Slack setup was canceled. Start again when you are ready.",
  SLACK_SETUP_CONFLICT: "Slack setup changed concurrently. Refresh the status and retry.",
  SLACK_SETUP_EXPIRED: "This Slack setup expired. Start again to create a fresh attempt.",
  SLACK_SETUP_INTENT_CONFLICT:
    "Another Slack setup is already in progress for this Agent. Cancel it before starting a different one.",
  SLACK_SETUP_NOT_ACTIVE: "This Slack setup attempt has already finished. Start again if the binding is not active.",
  SLACK_SETUP_NOT_FOUND: "This Slack setup attempt no longer exists. Start again to create a fresh attempt.",
  SLACK_SETUP_NOT_READY: "Submit the Bot Token and Signing Secret before Slack retries the Request URL.",
  SLACK_SIGNING_CHALLENGE_REQUIRED: "Slack has not verified the Request URL yet. Retry it from Event Subscriptions.",
  SLACK_SIGNING_SECRET_INVALID:
    "Slack could not verify the submitted Signing Secret. Copy it again from Basic Information and edit the credentials.",
  SLACK_TOKEN_REVOKED: "Slack revoked the Bot Token. Reauthorize to install fresh credentials.",
  SLACK_UPSTREAM_UNAVAILABLE: "Slack did not return installation details. Check Slack availability and retry.",
};

export interface SlackSetupControl {
  /** Starts one setup intent, or hydrates the in-flight attempt for it. False means nothing new was started. */
  start: (intent?: SlackSetupIntent) => Promise<boolean>;
  /** Opaque lifecycle feedback for the caller to place in its existing layout. */
  feedback: ReactNode;
}

interface SlackSetupProps {
  agentId: string;
  children: (control: SlackSetupControl) => ReactNode;
  onSuccess: () => void;
}

interface SlackSetupError {
  message: string;
  source: "start" | "poll" | "submit" | "cancel";
  /** Polling gave up; the admin can restart it explicitly. */
  pollingStopped?: boolean;
}

/**
 * Owns one Slack setup lifecycle for an Agent behind a small rendering seam.
 * Secrets live only inside the credential form while it is being filled; they never enter
 * lifecycle state, and the Server never returns them.
 */
export function SlackSetup({ agentId, children, onSuccess }: SlackSetupProps) {
  return (
    <SlackSetupLifecycle agentId={agentId} key={agentId} onSuccess={onSuccess}>
      {children}
    </SlackSetupLifecycle>
  );
}

function SlackSetupLifecycle({ agentId, children, onSuccess }: SlackSetupProps) {
  const [attempt, setAttempt] = useState<SlackSetupAttempt>();
  const [error, setError] = useState<SlackSetupError>();
  const [pollEpoch, setPollEpoch] = useState(0);
  const attemptRef = useRef<SlackSetupAttempt>(undefined);
  const creatingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
    },
    [],
  );

  const adopt = useCallback((next: SlackSetupAttempt) => {
    attemptRef.current = next;
    setAttempt(next);
    if (next.state === "succeeded") onSuccessRef.current();
  }, []);

  const start = useCallback(
    async (intent: SlackSetupIntent = "create") => {
      const current = attemptRef.current;
      if (creatingRef.current || (current?.intent === intent && ACTIVE_STATES.includes(current.state))) return false;

      const lifecycle = lifecycleRef.current;
      creatingRef.current = true;
      setError(undefined);
      try {
        const started = await browserApi.createSlackSetupAttempt(agentId, intent);
        if (lifecycleRef.current !== lifecycle) return false;
        creatingRef.current = false;
        if (current && attemptRef.current !== current && started.id === current.id) return true;
        setError(undefined);
        if (attemptRef.current?.id !== started.id || !ACTIVE_STATES.includes(started.state)) {
          lifecycleRef.current = lifecycle + 1;
        }
        setPollEpoch((value) => value + 1);
        adopt(started);
        return true;
      } catch (cause) {
        if (lifecycleRef.current !== lifecycle) return false;
        setError({ message: normalizeSlackSetupError(cause, "Unable to start Slack setup"), source: "start" });
        return false;
      } finally {
        if (lifecycleRef.current === lifecycle) creatingRef.current = false;
      }
    },
    [agentId, adopt],
  );

  const restartPolling = useCallback(() => {
    setError((current) => (current?.source === "poll" ? undefined : current));
    setPollEpoch((value) => value + 1);
  }, []);

  const activeAttemptId = attempt && ACTIVE_STATES.includes(attempt.state) ? attempt.id : undefined;
  // The epoch lets an explicit refresh restart polling for the same attempt after it gave up.
  const pollTarget = useMemo(
    () => (activeAttemptId ? { attemptId: activeAttemptId, epoch: pollEpoch } : undefined),
    [activeAttemptId, pollEpoch],
  );
  useEffect(() => {
    if (!pollTarget) return;
    const { attemptId } = pollTarget;
    const lifecycle = lifecycleRef.current;
    let active = true;
    let timer: number | undefined;
    let failures = 0;

    const schedule = (delay: number) => {
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      try {
        const next = await browserApi.slackSetupAttempt(attemptId);
        if (!active || lifecycleRef.current !== lifecycle) return;
        failures = 0;
        adopt(next);
        setError((current) => (current?.source === "poll" ? undefined : current));
        if (ACTIVE_STATES.includes(next.state)) schedule(POLL_INTERVAL_MS);
      } catch (cause) {
        if (!active || lifecycleRef.current !== lifecycle) return;
        failures += 1;
        const stopped = isTerminalPollFailure(cause) || failures >= POLL_MAX_FAILURES;
        setError((current) =>
          current && current.source !== "poll"
            ? current
            : { message: describePollFailure(cause, stopped), source: "poll", pollingStopped: stopped },
        );
        if (!stopped) schedule(Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_MAX_INTERVAL_MS));
      }
    };

    schedule(POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pollTarget, adopt]);

  return children({
    start,
    feedback: (
      <>
        {attempt ? (
          <SlackSetupFeedback attempt={attempt} key={attempt.id} onAttempt={adopt} onError={setError} onRetry={start} />
        ) : null}
        {error ? (
          <div className="notice error" role="alert">
            {error.message}
            {error.pollingStopped ? (
              <>
                {" "}
                <Button variant="secondary" onClick={restartPolling}>
                  Refresh status
                </Button>
              </>
            ) : null}
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
  onError: (error: SlackSetupError | undefined) => void;
  onRetry: (intent: SlackSetupIntent) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const showForm = attempt.state === "awaiting_credentials" || (attempt.state === "awaiting_verification" && editing);

  async function cancel() {
    if (canceling) return;
    setCanceling(true);
    onError(undefined);
    try {
      onAttempt(await browserApi.cancelSlackSetupAttempt(attempt.id));
    } catch (cause) {
      onError({ message: normalizeSlackSetupError(cause, "Unable to cancel Slack setup"), source: "cancel" });
    } finally {
      setCanceling(false);
    }
  }

  return (
    <div className="notice">
      <strong>Slack App setup</strong>
      <br />
      State: {attempt.state}. Expires {formatSetupDate(attempt.expiresAt)}.
      <SlackManifestGuide attempt={attempt} />
      <p>Required bot scopes: {attempt.requiredBotScopes.join(", ")}.</p>
      {showForm ? (
        <SlackCredentialsForm
          attempt={attempt}
          onAttempt={(next) => {
            setEditing(false);
            onAttempt(next);
          }}
          onError={onError}
        >
          {editing ? (
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Keep current credentials
            </Button>
          ) : null}
        </SlackCredentialsForm>
      ) : null}
      {attempt.state === "awaiting_verification" && !editing ? (
        <SlackVerificationStatus attempt={attempt} onEdit={() => setEditing(true)} />
      ) : null}
      {ACTIVE_STATES.includes(attempt.state) ? (
        <p>
          <Button disabled={canceling} variant="danger" onClick={() => void cancel()}>
            {canceling ? "Canceling…" : "Cancel setup"}
          </Button>
        </p>
      ) : null}
      {attempt.errorCode ? <p>{SLACK_SETUP_MESSAGES[attempt.errorCode] ?? "Slack setup needs attention."}</p> : null}
      {RETRYABLE_STATES.includes(attempt.state) ? (
        <Button onClick={() => void onRetry(attempt.intent)}>Retry Slack setup</Button>
      ) : null}
    </div>
  );
}

function SlackVerificationStatus({ attempt, onEdit }: { attempt: SlackSetupAttempt; onEdit: () => void }) {
  const identity = attempt.identity;
  return (
    <div className="form-stack">
      <p>
        <strong>Bot Token validated</strong>
        {identity
          ? ` for App ${identity.appId} in workspace ${identity.teamId} (bot user ${identity.botUserId}).`
          : ". Slack did not report an App ID for this token; the first signed event establishes it."}
      </p>
      <p>
        {attempt.challengeVerified ? (
          <>
            <strong>Signing Secret verified.</strong> Slack accepted the Request URL. Invite the bot to a channel and
            mention it; the first matching event completes activation.
          </>
        ) : (
          <>
            <strong>Signing Secret not yet verified.</strong> Slack verifies it when you retry the Request URL in{" "}
            <strong>Event Subscriptions</strong>. Until then this attempt waits, and the current binding (if any) keeps
            working.
          </>
        )}
      </p>
      {attempt.lastVerificationErrorCode ? (
        <p className="notice error" role="status">
          {SLACK_SETUP_MESSAGES[attempt.lastVerificationErrorCode] ?? "Slack could not verify the last request."}
          {attempt.lastVerificationAt ? ` (last attempt ${formatSetupDate(attempt.lastVerificationAt)})` : null}
        </p>
      ) : null}
      <p>
        <Button variant="secondary" onClick={onEdit}>
          Edit credentials
        </Button>
      </p>
    </div>
  );
}

function SlackCredentialsForm({
  attempt,
  children,
  onAttempt,
  onError,
}: {
  attempt: SlackSetupAttempt;
  children?: ReactNode;
  onAttempt: (attempt: SlackSetupAttempt) => void;
  onError: (error: SlackSetupError | undefined) => void;
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
      onError({ message: normalizeSlackSetupError(cause, "Unable to validate Slack credentials"), source: "submit" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
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
      <div className="im-actions">
        <Button disabled={submitting} type="submit">
          {submitting ? "Validating Slack installation…" : "Validate Slack installation"}
        </Button>
        {children}
      </div>
    </form>
  );
}

function SlackManifestGuide({ attempt }: { attempt: SlackSetupAttempt }) {
  const manifestJson = JSON.stringify(attempt.manifest, null, 2);
  const existingAppUrl = attempt.currentAppId
    ? `https://api.slack.com/apps/${encodeURIComponent(attempt.currentAppId)}/app-manifest`
    : "https://api.slack.com/apps";
  return (
    <ol>
      {attempt.intent === "reauthorize" ? (
        <>
          <li>
            <a href={existingAppUrl} rel="noreferrer" target="_blank">
              Open the current Slack App's manifest
            </a>
            {attempt.currentAppId ? ` (App ${attempt.currentAppId})` : null}, replace its manifest with the JSON below,
            and save. Reauthorization must keep the same App, workspace, and bot user.
            <SlackManifestJson value={manifestJson} />
          </li>
          <li>
            In <strong>OAuth &amp; Permissions</strong>, choose <strong>Reinstall to Workspace</strong> and approve the
            updated scopes. Then copy the Bot User OAuth Token (it may have changed) and, from{" "}
            <strong>Basic Information</strong>, the Signing Secret.
          </li>
        </>
      ) : (
        <>
          <li>
            <a href={attempt.manifestUrl} rel="noreferrer" target="_blank">
              {attempt.intent === "replace"
                ? "Create a new dedicated Slack App from the generated manifest"
                : "Create a dedicated Slack App from the generated manifest"}
            </a>
            , then install it to the intended workspace. If the link does not prefill the manifest, create the App from
            scratch and paste this JSON.
            <SlackManifestJson value={manifestJson} />
          </li>
          <li>
            In <strong>OAuth &amp; Permissions</strong>, copy the Bot User OAuth Token. In{" "}
            <strong>Basic Information</strong>, copy the Signing Secret.
          </li>
        </>
      )}
      <li>
        After validation, return to <strong>Event Subscriptions</strong> and retry this Request URL:
        <br />
        <code>{attempt.eventsUrl}</code>
      </li>
      <li>Invite the bot to a test channel and mention it. The first matching signed event completes activation.</li>
    </ol>
  );
}

function SlackManifestJson({ value }: { value: string }) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="form-stack">
      <textarea aria-label="Slack App manifest JSON" readOnly rows={8} value={value} />
      <div className="im-actions">
        <Button variant="secondary" onClick={() => void copy()}>
          Copy manifest JSON
        </Button>
        {copied === "copied" ? <span role="status">Copied</span> : null}
        {copied === "failed" ? <span role="status">Copy failed; select the JSON above manually.</span> : null}
      </div>
    </div>
  );
}

/** Deterministic client errors mean the attempt is gone or inaccessible; polling again cannot change that. */
function isTerminalPollFailure(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429;
}

function describePollFailure(cause: unknown, stopped: boolean): string {
  const message = normalizeSlackSetupError(cause, "Unable to refresh Slack setup");
  if (!stopped) return message;
  if (cause instanceof ApiError && cause.status === 404) return SLACK_SETUP_MESSAGES.SLACK_SETUP_NOT_FOUND ?? message;
  if (cause instanceof ApiError && cause.status === 403) return SLACK_SETUP_MESSAGES.IM_BINDING_FORBIDDEN ?? message;
  return isTerminalPollFailure(cause)
    ? `${message} Polling stopped.`
    : "Unable to refresh Slack setup after repeated failures. Polling stopped; refresh the status to continue.";
}

/**
 * One recovery message per Server-reported code, whether it arrives as a failed
 * attempt or as the error of a request that never produced one.
 */
function normalizeSlackSetupError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && SLACK_SETUP_MESSAGES[code]) return SLACK_SETUP_MESSAGES[code];
  return cause instanceof Error ? cause.message : fallback;
}

function formatSetupDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
