import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { formatDateTime } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, buttonClassName, Dialog, Loader } from "../ui/design-system.js";

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
  presentation?: "dialog" | "inline";
  returnFocusRef?: RefObject<HTMLElement | null>;
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
export function FeishuSetup({
  agentId,
  children,
  onSuccess,
  presentation = "inline",
  returnFocusRef,
}: FeishuSetupProps) {
  return (
    <FeishuSetupLifecycle
      agentId={agentId}
      key={agentId}
      onSuccess={onSuccess}
      presentation={presentation}
      returnFocusRef={returnFocusRef}
    >
      {children}
    </FeishuSetupLifecycle>
  );
}

function FeishuSetupLifecycle({
  agentId,
  children,
  onSuccess,
  presentation = "inline",
  returnFocusRef,
}: FeishuSetupProps) {
  const [attempt, setAttempt] = useState<FeishuSetupAttempt>();
  const [error, setError] = useState<FeishuSetupError>();
  const [loading, setLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeIntent, setActiveIntent] = useState<FeishuSetupIntent>("create");
  const attemptRef = useRef<FeishuSetupAttempt>(undefined);
  const creatingRef = useRef(false);
  const cancelAfterStartRef = useRef(false);
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
      setActiveIntent(intent);
      if (presentation === "dialog") setDialogOpen(true);
      creatingRef.current = true;
      setLoading(true);
      setError(undefined);
      try {
        const started = await browserApi.createFeishuSetupAttempt(agentId, intent);
        if (lifecycleRef.current !== lifecycle) return false;
        creatingRef.current = false;
        if (cancelAfterStartRef.current) {
          cancelAfterStartRef.current = false;
          if (started.state === "awaiting_user") {
            try {
              await browserApi.cancelFeishuSetupAttempt(started.id);
            } catch {
              attemptRef.current = started;
              setAttempt(started);
              setError({ message: m.im_feishu_cancel_failed(), source: "start" });
              setDialogOpen(true);
              return false;
            }
          }
          return true;
        }
        if (current && attemptRef.current !== current && started.id === current.id) return true;
        setError(undefined);
        // Advancing the lifecycle retires the old poll, so clear the request state before the
        // guarded `finally` intentionally stops observing that retired lifecycle.
        setLoading(false);
        if (attemptRef.current?.id !== started.id || !ACTIVE_STATES.includes(started.state)) {
          lifecycleRef.current = lifecycle + 1;
        }
        attemptRef.current = started;
        setAttempt(started);
        if (started.state === "succeeded") {
          if (presentation === "dialog") {
            attemptRef.current = undefined;
            setAttempt(undefined);
            setDialogOpen(false);
          }
          onSuccessRef.current();
        }
        return true;
      } catch (cause) {
        if (lifecycleRef.current !== lifecycle) return false;
        setError({ message: normalizeError(cause, m.im_feishu_authorization_failed()), source: "start" });
        return false;
      } finally {
        if (lifecycleRef.current === lifecycle) {
          creatingRef.current = false;
          setLoading(false);
        }
      }
    },
    [agentId, presentation],
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
          if (presentation === "dialog") {
            attemptRef.current = undefined;
            setAttempt(undefined);
            setDialogOpen(false);
          }
          onSuccessRef.current();
          return;
        }
        if (ACTIVE_STATES.includes(next.state)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (!active || lifecycleRef.current !== lifecycle) return;
        setError((currentError) =>
          currentError?.source === "start"
            ? currentError
            : { message: normalizeError(cause, m.im_feishu_authorization_failed()), source: "poll" },
        );
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeAttemptId, presentation]);

  async function cancelActiveAttempt() {
    const current = attemptRef.current;
    if (!current && creatingRef.current) {
      cancelAfterStartRef.current = true;
      setDialogOpen(false);
      return;
    }
    if (current?.state !== "awaiting_user" || canceling) return;
    setCanceling(true);
    setError(undefined);
    lifecycleRef.current += 1;
    try {
      await browserApi.cancelFeishuSetupAttempt(current.id);
      attemptRef.current = undefined;
      setAttempt(undefined);
      setDialogOpen(false);
    } catch {
      setError({ message: m.im_feishu_cancel_failed(), source: "start" });
    } finally {
      setCanceling(false);
    }
  }

  function closeDialog() {
    const current = attemptRef.current;
    if ((!current && creatingRef.current) || current?.state === "awaiting_user") {
      void cancelActiveAttempt();
      return;
    }
    if (current?.state === "validating") return;
    attemptRef.current = undefined;
    setAttempt(undefined);
    setError(undefined);
    setDialogOpen(false);
  }

  const feedback =
    presentation === "dialog" ? (
      <FeishuSetupDialog
        attempt={attempt}
        busy={canceling || attempt?.state === "validating"}
        error={error?.message}
        intent={attempt?.intent ?? activeIntent}
        loading={loading}
        open={dialogOpen}
        returnFocusRef={returnFocusRef}
        onClose={closeDialog}
        onRetry={start}
      />
    ) : (
      <>
        {attempt ? <FeishuSetupFeedback attempt={attempt} onRetry={start} /> : null}
        {error ? <Banner variant="error" role="alert" description={error.message} /> : null}
      </>
    );

  return children({
    loading,
    start,
    feedback,
  });
}

function FeishuSetupDialog({
  attempt,
  busy,
  error,
  intent,
  loading,
  onClose,
  onRetry,
  open,
  returnFocusRef,
}: {
  attempt?: FeishuSetupAttempt;
  busy: boolean;
  error?: string;
  intent: FeishuSetupIntent;
  loading: boolean;
  onClose: () => void;
  onRetry: (intent: FeishuSetupIntent) => Promise<boolean>;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const title = feishuDialogTitle(intent);
  return (
    <Dialog
      busy={busy}
      description={feishuDialogDescription(intent)}
      open={open}
      returnFocusRef={returnFocusRef}
      title={title}
      onClose={onClose}
    >
      <FeishuSetupDialogContent
        attempt={attempt}
        error={error}
        intent={intent}
        loading={loading}
        onClose={onClose}
        onRetry={onRetry}
      />
    </Dialog>
  );
}

function FeishuSetupDialogContent({
  attempt,
  error,
  intent,
  loading,
  onClose,
  onRetry,
}: {
  attempt?: FeishuSetupAttempt;
  error?: string;
  intent: FeishuSetupIntent;
  loading: boolean;
  onClose: () => void;
  onRetry: (intent: FeishuSetupIntent) => Promise<boolean>;
}) {
  const recovery = attempt ? setupRecovery(attempt) : undefined;
  const terminal = attempt ? RETRYABLE_STATES.includes(attempt.state) : Boolean(error && !loading);
  return (
    <div className="grid gap-4" data-ui="feishu-setup-dialog">
      {loading && !attempt ? (
        <div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
          <Loader aria-label={m.im_feishu_preparing()} size="sm" />
          <span>{m.im_feishu_preparing()}</span>
        </div>
      ) : null}
      {attempt?.state === "awaiting_user" ? <FeishuAwaitingUser attempt={attempt} onClose={onClose} /> : null}
      {attempt?.state === "validating" ? (
        <div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
          <Loader aria-label={m.im_feishu_finishing()} size="sm" />
          <span>{m.im_feishu_finishing()}</span>
        </div>
      ) : null}
      {recovery ? <Banner variant="error" role="alert" description={recovery} /> : null}
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      {terminal ? (
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            {m.common_close()}
          </Button>
          <Button onClick={() => void onRetry(intent)}>
            {attempt?.state === "expired" ? m.im_feishu_generate_new_code() : m.im_feishu_retry()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FeishuAwaitingUser({ attempt, onClose }: { attempt: FeishuSetupAttempt; onClose: () => void }) {
  return (
    <>
      {attempt.qrUrl ? (
        <div className="hidden sm:block">
          <FeishuQrCode value={attempt.qrUrl} />
          <FeishuQrExpiry expiresAt={attempt.expiresAt} />
        </div>
      ) : null}
      <div className="grid gap-3 sm:flex sm:flex-wrap sm:justify-end">
        <Button className="w-full sm:w-auto" variant="ghost" onClick={onClose}>
          {m.common_cancel()}
        </Button>
        {attempt.qrUrl ? (
          <a
            className={buttonClassName({ className: "w-full sm:w-auto" })}
            href={attempt.qrUrl}
            rel="noreferrer"
            target="_blank"
          >
            {m.im_feishu_open()}
          </a>
        ) : null}
      </div>
    </>
  );
}

function feishuDialogTitle(intent: FeishuSetupIntent): string {
  if (intent === "replace") return m.im_feishu_dialog_change_title();
  if (intent === "reauthorize") return m.im_feishu_dialog_permissions_title();
  return m.im_feishu_dialog_connect_title();
}

function feishuDialogDescription(intent: FeishuSetupIntent): string {
  if (intent === "replace") return m.im_feishu_dialog_change_description();
  if (intent === "reauthorize") return m.im_feishu_dialog_permissions_description();
  return m.im_feishu_dialog_connect_description();
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
      alt={m.im_feishu_qr_alt()}
      className="mx-auto my-3 size-60 max-w-full rounded-md bg-kumo-base p-2 ring ring-kumo-line"
      src={source}
    />
  ) : null;
}

function FeishuQrExpiry({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Date.parse(expiresAt) - now;
  if (remaining <= 0) {
    return <p className="text-center text-sm text-kumo-warning">{m.im_feishu_qr_expired()}</p>;
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return <p className="text-center text-sm text-kumo-subtle">{m.im_feishu_qr_expires_in({ minutes })}</p>;
}

function setupRecovery(attempt: FeishuSetupAttempt): string | undefined {
  if (attempt.errorCode) return feishuSetupMessage(attempt.errorCode);
  if (attempt.state === "expired") return m.im_feishu_authorization_expired();
  if (attempt.state === "canceled") return m.im_feishu_setup_canceled();
  if (attempt.state === "failed") return m.im_feishu_authorization_failed();
  return undefined;
}

/**
 * One recovery message per Server-reported code, whether it arrives as a failed
 * attempt or as the error of a request that never produced one.
 */
function normalizeError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code) return feishuSetupMessage(code);
  if (cause instanceof Error && cause.message) return m.im_feishu_authorization_failed();
  return fallback;
}

function feishuSetupMessage(code: string): string {
  if (code === "FEISHU_APP_ALREADY_BOUND") return m.im_feishu_app_already_connected();
  if (code === "FEISHU_SCOPE_REAUTH_REQUIRED" || code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
    return m.im_feishu_permissions_missing();
  }
  if (code === "FEISHU_SETUP_DENIED") return m.im_feishu_authorization_declined();
  if (code === "FEISHU_SETUP_EXPIRED") return m.im_feishu_authorization_expired();
  if (code === "FEISHU_SETUP_CANCELED") return m.im_feishu_setup_canceled();
  if (code === "FEISHU_SETUP_OWNER_RESTARTED") return m.im_feishu_setup_interrupted();
  if (code === "FEISHU_BINDING_IDENTITY_MISMATCH") return m.im_feishu_authorization_mismatch();
  if (code === "FEISHU_UPSTREAM_UNAVAILABLE") return m.im_feishu_unavailable();
  return m.im_feishu_authorization_failed();
}
