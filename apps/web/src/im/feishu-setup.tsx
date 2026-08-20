import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../api.js";

const ACTIVE_STATES: readonly FeishuSetupAttempt["state"][] = ["awaiting_user", "validating"];
const RETRYABLE_STATES: readonly FeishuSetupAttempt["state"][] = ["expired", "failed", "canceled"];
const POLL_INTERVAL_MS = 1_500;

export interface FeishuSetupControl {
  /** Starts one setup intent. False means no new attempt was started. */
  start: (intent?: FeishuSetupIntent) => Promise<boolean>;
  /** Opaque lifecycle feedback for the caller to place in its existing layout. */
  feedback: ReactNode;
}

interface FeishuSetupProps {
  agentId: string;
  children: (control: FeishuSetupControl) => ReactNode;
  onSuccess: () => void;
}

/**
 * Owns one Feishu setup lifecycle for an Agent behind a small rendering seam.
 * ImTab refreshes its binding on success; onboarding can use the same callback
 * to reload fresh Server facts and derive its next step without learning setup internals.
 */
export function FeishuSetup({ agentId, children, onSuccess }: FeishuSetupProps) {
  return (
    <FeishuSetupLifecycle agentId={agentId} key={agentId} onSuccess={onSuccess}>
      {children}
    </FeishuSetupLifecycle>
  );
}

function FeishuSetupLifecycle({ agentId, children, onSuccess }: FeishuSetupProps) {
  const [attempt, setAttempt] = useState<FeishuSetupAttempt>();
  const [error, setError] = useState<string>();
  const attemptRef = useRef<FeishuSetupAttempt>(undefined);
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

  const start = useCallback(
    async (intent: FeishuSetupIntent = "create") => {
      const current = attemptRef.current;
      if (creatingRef.current || (current?.intent === intent && ACTIVE_STATES.includes(current.state))) return false;

      const lifecycle = lifecycleRef.current + 1;
      lifecycleRef.current = lifecycle;
      creatingRef.current = true;
      attemptRef.current = undefined;
      setAttempt(undefined);
      setError(undefined);
      try {
        const started = await browserApi.createFeishuSetupAttempt(agentId, intent);
        if (lifecycleRef.current !== lifecycle) return false;
        attemptRef.current = started;
        setAttempt(started);
        if (started.state === "succeeded") onSuccessRef.current();
        return true;
      } catch (cause) {
        if (lifecycleRef.current !== lifecycle) return false;
        setError(normalizeError(cause, "Unable to start setup"));
        return false;
      } finally {
        if (lifecycleRef.current === lifecycle) creatingRef.current = false;
      }
    },
    [agentId],
  );

  const activeAttemptId = attempt && ACTIVE_STATES.includes(attempt.state) ? attempt.id : undefined;
  useEffect(() => {
    if (!activeAttemptId) return;
    const lifecycle = lifecycleRef.current;
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await browserApi.feishuSetupAttempt(activeAttemptId);
        if (!active || lifecycleRef.current !== lifecycle) return;
        attemptRef.current = next;
        setAttempt(next);
        if (next.state === "succeeded") {
          onSuccessRef.current();
          return;
        }
        if (ACTIVE_STATES.includes(next.state)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (!active || lifecycleRef.current !== lifecycle) return;
        setError(normalizeError(cause, "Unable to refresh setup"));
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
        {attempt ? <FeishuSetupFeedback attempt={attempt} onRetry={start} /> : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </>
    ),
  });
}

function FeishuSetupFeedback({
  attempt,
  onRetry,
}: {
  attempt: FeishuSetupAttempt;
  onRetry: (intent: FeishuSetupIntent) => Promise<boolean>;
}) {
  const recovery = setupRecovery(attempt);
  return (
    <div className="notice">
      <strong>Feishu setup started</strong>
      <br />
      {attempt.intent === "reauthorize"
        ? "Confirm the updated permissions for the current Feishu Bot."
        : "Choose an existing Feishu Bot or create a new one, then confirm the requested permissions."}
      <br />
      State: {attempt.state}. Expires {formatSetupDate(attempt.expiresAt)}.
      {recovery ? (
        <>
          <br />
          {recovery}
        </>
      ) : null}
      {attempt.qrUrl ? (
        <>
          <br />
          <FeishuQrCode value={attempt.qrUrl} />
          <a href={attempt.qrUrl} rel="noreferrer" target="_blank">
            Open Feishu authorization
          </a>
        </>
      ) : null}
      {RETRYABLE_STATES.includes(attempt.state) ? (
        <>
          <br />
          <button className="button" type="button" onClick={() => void onRetry(attempt.intent)}>
            Retry Feishu setup
          </button>
        </>
      ) : null}
    </div>
  );
}

function FeishuQrCode({ value }: { value: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    void qrToString(value, { margin: 1, type: "svg", width: 240 }).then(
      (svg) => active && setSource(`data:image/svg+xml,${encodeURIComponent(svg)}`),
    );
    return () => {
      active = false;
    };
  }, [value]);
  return source ? <img alt="Scan this QR code in Feishu" className="setup-qr" src={source} /> : null;
}

function setupRecovery(attempt: FeishuSetupAttempt): string | undefined {
  const messages: Record<string, string> = {
    FEISHU_APP_ALREADY_BOUND:
      "This Feishu Bot is already connected to another Agent. Choose a different Bot or disable its current binding first.",
    FEISHU_SCOPE_REAUTH_REQUIRED:
      "Feishu did not grant every required permission. Retry and approve all requested permissions.",
    IM_BINDING_SCOPE_REAUTH_REQUIRED:
      "Feishu did not grant every required permission. Retry and approve all requested permissions.",
    FEISHU_SETUP_DENIED: "Feishu authorization was declined. Retry and approve the requested permissions.",
    FEISHU_SETUP_EXPIRED: "This Feishu authorization expired. Retry to scan a new QR code.",
    FEISHU_SETUP_CANCELED: "Feishu setup was canceled. Retry when you are ready.",
    FEISHU_SETUP_OWNER_RESTARTED: "The server restarted during Feishu setup. Retry to generate a new QR code.",
    FEISHU_BINDING_IDENTITY_MISMATCH:
      "The authorized Feishu Bot identity does not match the current binding. Retry with the current Bot or use Replace.",
  };
  if (attempt.errorCode && messages[attempt.errorCode]) return messages[attempt.errorCode];
  if (attempt.state === "expired") return messages.FEISHU_SETUP_EXPIRED;
  if (attempt.state === "canceled") return messages.FEISHU_SETUP_CANCELED;
  if (attempt.state === "failed") return "Feishu setup failed. Retry or contact a Team admin for help.";
  return undefined;
}

function normalizeError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formatSetupDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
