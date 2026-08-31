import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { formatDateTime } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, Loader } from "../ui/design-system.js";

const ACTIVE_STATES: readonly FeishuSetupAttempt["state"][] = ["awaiting_user", "validating"];
const RETRYABLE_STATES: readonly FeishuSetupAttempt["state"][] = ["expired", "failed", "canceled"];
/*
 * This stays outside the query cache on purpose, for the same reason the Computer setup beside it
 * does: it drives one authorization to completion rather than reading a resource. Nothing else reads
 * an attempt, so there is no sharing to gain, and the lifecycle it does keep — which error came from
 * starting versus from polling, and which attempt a late response belongs to — is the substance of
 * the flow rather than incidental bookkeeping.
 */
const POLL_INTERVAL_MS = 1_500;
const FEISHU_SETUP_MESSAGES: Record<string, () => string> = {
  FEISHU_APP_ALREADY_BOUND: () => m.im_feishu_app_already_bound(),
  FEISHU_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_scope_reauth_required(),
  IM_BINDING_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_scope_reauth_required(),
  FEISHU_SETUP_DENIED: () => m.im_feishu_setup_denied(),
  FEISHU_SETUP_EXPIRED: () => m.im_feishu_setup_expired(),
  FEISHU_SETUP_CANCELED: () => m.im_feishu_setup_canceled(),
  FEISHU_SETUP_OWNER_RESTARTED: () => m.im_feishu_setup_owner_restarted(),
  FEISHU_BINDING_IDENTITY_MISMATCH: () => m.im_feishu_binding_identity_mismatch(),
  FEISHU_UPSTREAM_UNAVAILABLE: () => m.im_feishu_upstream_unavailable(),
};

export interface FeishuSetupControl {
  /** Starts one setup intent. False means no new attempt was started. */
  start: (intent?: FeishuSetupIntent) => Promise<boolean>;
  loading: boolean;
  /** Opaque lifecycle feedback for the caller to place in its existing layout. */
  feedback: ReactNode;
}

interface FeishuSetupProps {
  agentId: string;
  children: (control: FeishuSetupControl) => ReactNode;
  onSuccess: () => void;
}

interface FeishuSetupError {
  message: string;
  source: "poll" | "start";
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
  const [error, setError] = useState<FeishuSetupError>();
  const [loading, setLoading] = useState(false);
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

      const lifecycle = lifecycleRef.current;
      creatingRef.current = true;
      setLoading(true);
      setError(undefined);
      try {
        const started = await browserApi.createFeishuSetupAttempt(agentId, intent);
        if (lifecycleRef.current !== lifecycle) return false;
        creatingRef.current = false;
        if (current && attemptRef.current !== current && started.id === current.id) return true;
        setError(undefined);
        if (attemptRef.current?.id !== started.id || !ACTIVE_STATES.includes(started.state)) {
          lifecycleRef.current = lifecycle + 1;
        }
        attemptRef.current = started;
        setAttempt(started);
        if (started.state === "succeeded") onSuccessRef.current();
        return true;
      } catch (cause) {
        if (lifecycleRef.current !== lifecycle) return false;
        setError({ message: normalizeError(cause, m.im_feishu_unable_to_start_setup()), source: "start" });
        return false;
      } finally {
        if (lifecycleRef.current === lifecycle) {
          creatingRef.current = false;
          setLoading(false);
        }
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
        setError((currentError) => (currentError?.source === "poll" ? undefined : currentError));
        if (next.state === "succeeded") {
          onSuccessRef.current();
          return;
        }
        if (ACTIVE_STATES.includes(next.state)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (!active || lifecycleRef.current !== lifecycle) return;
        setError((currentError) =>
          currentError?.source === "start"
            ? currentError
            : { message: normalizeError(cause, m.im_feishu_unable_to_refresh_setup()), source: "poll" },
        );
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
    loading,
    start,
    feedback: (
      <>
        {attempt ? <FeishuSetupFeedback attempt={attempt} onRetry={start} /> : null}
        {error ? <Banner variant="error" role="alert" description={error.message} /> : null}
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
  const active = ACTIVE_STATES.includes(attempt.state);
  return (
    <Banner data-ui="feishu-setup-feedback">
      {active ? (
        <span aria-hidden="true">
          <Loader aria-label={m.im_feishu_waiting_for_authorization()} size="sm" />
        </span>
      ) : null}
      <strong>{m.im_feishu_setup_started()}</strong>
      <br />
      {attempt.intent === "reauthorize" ? m.im_feishu_reauthorize_instructions() : m.im_feishu_create_instructions()}
      <br />
      {m.im_feishu_state_expires({ state: attempt.state, expires: formatDateTime(attempt.expiresAt) })}
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
            {m.im_feishu_open_authorization()}
          </a>
        </>
      ) : null}
      {RETRYABLE_STATES.includes(attempt.state) ? (
        <>
          <br />
          <Button onClick={() => void onRetry(attempt.intent)}>{m.im_feishu_retry_setup()}</Button>
        </>
      ) : null}
    </Banner>
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
  return source ? (
    <img
      alt={m.im_feishu_scan_qr_code()}
      className="my-3 size-60 max-w-full rounded-md bg-kumo-base p-2 ring ring-kumo-line"
      src={source}
    />
  ) : null;
}

function setupRecovery(attempt: FeishuSetupAttempt): string | undefined {
  if (attempt.errorCode && FEISHU_SETUP_MESSAGES[attempt.errorCode])
    return FEISHU_SETUP_MESSAGES[attempt.errorCode]?.();
  if (attempt.state === "expired") return m.im_feishu_setup_expired();
  if (attempt.state === "canceled") return m.im_feishu_setup_canceled();
  if (attempt.state === "failed") return m.im_feishu_setup_failed();
  return undefined;
}

/**
 * One recovery message per Server-reported code, whether it arrives as a failed
 * attempt or as the error of a request that never produced one.
 */
function normalizeError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && FEISHU_SETUP_MESSAGES[code]) return FEISHU_SETUP_MESSAGES[code]?.();
  return cause instanceof Error ? cause.message : fallback;
}
