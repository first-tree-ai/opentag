import type { FeishuBrand, FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { formatDateTime } from "../i18n/format.js";
import { SETUP_COPY } from "../setup/copy.js";
import { Banner, Button, Loader } from "../ui/design-system.js";
import { defaultFeishuBrand, otherFeishuBrand } from "./brand.js";
import { messagingProviderLabel } from "./provider-label.js";

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
const FEISHU_SETUP_MESSAGES: Record<string, string> = {
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
  FEISHU_UPSTREAM_UNAVAILABLE:
    "The Feishu open platform did not return a usable authorization. Check the Server's network access to Feishu, then retry.",
};

export interface FeishuSetupControl {
  /** Starts one setup intent. False means no new attempt was started. */
  start: (intent?: FeishuSetupIntent) => Promise<boolean>;
  /**
   * Reissues the current attempt's code against the other regional brand. The domain is fixed when
   * a code is minted, so this releases the attempt on screen before asking for a new one.
   */
  switchBrand: (brand: FeishuBrand) => Promise<boolean>;
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
  /** Held for the whole of one switch, which spans two requests the reader can press through. */
  const switchingRef = useRef(false);
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
    async (intent: FeishuSetupIntent = "create", brand?: FeishuBrand) => {
      const current = attemptRef.current;
      if (creatingRef.current || (current?.intent === intent && ACTIVE_STATES.includes(current.state))) return false;

      const lifecycle = lifecycleRef.current;
      creatingRef.current = true;
      setLoading(true);
      setError(undefined);
      try {
        /*
         * Only a first connect chooses a brand: a re-authorization or a replacement belongs to a
         * binding that already knows its own, and the Server keeps that one whatever is asked for.
         */
        const started = await browserApi.createFeishuSetupAttempt(
          agentId,
          intent,
          intent === "create" ? (brand ?? defaultFeishuBrand()) : undefined,
        );
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
        setError({ message: normalizeError(cause, "Unable to start setup"), source: "start" });
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
            : { message: normalizeError(cause, "Unable to refresh setup"), source: "poll" },
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

  const switchBrand = useCallback(
    async (brand: FeishuBrand) => {
      /*
       * One switch at a time, claimed before anything is awaited. The code and its button stay on
       * screen for the whole release round-trip — they have to, because a release that fails leaves
       * that code the live one — so a second press arrives while the first is still in flight. It
       * would retire the first switch's own creation mid-air, and the cleanup that clears `loading`
       * is guarded by the same lifecycle it just retired: the panel would be left with no code, no
       * error, and every later start refused.
       */
      if (switchingRef.current) return false;
      switchingRef.current = true;
      try {
        const current = attemptRef.current;
        /*
         * Released before the replacement is asked for: the Server hands back an attempt that is
         * still awaiting a scan, so creating first would return the very code the reader is
         * leaving. A release that fails therefore stops the switch — minting after it would show
         * the same code again and call it the other brand.
         */
        if (current && ACTIVE_STATES.includes(current.state)) {
          try {
            await browserApi.cancelFeishuSetupAttempt(current.id);
          } catch (cause) {
            setError({ message: normalizeError(cause, "Unable to switch"), source: "start" });
            return false;
          }
          attemptRef.current = undefined;
          setAttempt(undefined);
          lifecycleRef.current += 1;
        }
        return await start(current?.intent ?? "create", brand);
      } finally {
        switchingRef.current = false;
      }
    },
    [start],
  );

  return children({
    loading,
    start,
    switchBrand,
    feedback: (
      <>
        {attempt ? <FeishuSetupFeedback attempt={attempt} onRetry={start} onSwitchBrand={switchBrand} /> : null}
        {error ? <Banner variant="error" role="alert" description={error.message} /> : null}
      </>
    ),
  });
}

function FeishuSetupFeedback({
  attempt,
  onRetry,
  onSwitchBrand,
}: {
  attempt: FeishuSetupAttempt;
  onRetry: (intent: FeishuSetupIntent) => Promise<boolean>;
  onSwitchBrand: (brand: FeishuBrand) => Promise<boolean>;
}) {
  const recovery = setupRecovery(attempt);
  const active = ACTIVE_STATES.includes(attempt.state);
  return (
    <Banner data-ui="feishu-setup-feedback">
      {active ? (
        <span aria-hidden="true">
          <Loader aria-label="Waiting for Feishu authorization" size="sm" />
        </span>
      ) : null}
      <strong>Feishu setup started</strong>
      <br />
      {attempt.intent === "reauthorize"
        ? "Confirm the updated permissions for the current Feishu Bot."
        : "Choose an existing Feishu Bot or create a new one, then confirm the requested permissions."}
      <br />
      State: {attempt.state}. Expires {formatDateTime(attempt.expiresAt)}.
      {recovery ? (
        <>
          <br />
          {recovery}
        </>
      ) : null}
      {attempt.qrUrl ? (
        <>
          <br />
          <FeishuQrCode brand={attempt.brand} value={attempt.qrUrl} />
          <a href={attempt.qrUrl} rel="noreferrer" target="_blank">
            Open {messagingProviderLabel("feishu", attempt.brand)} authorization
          </a>
          {/*
            A code is minted against one brand's domain and cannot be authorized from the other, so
            the reader whose company is on the one we did not guess needs the way out here, beside
            the code that will not work for them.

            Only on a first connect. A re-authorization or a replacement belongs to a binding whose
            brand is already settled, and the Server returns to that domain whatever is asked for —
            so the button would cancel a working code and mint the same one again.
          */}
          {attempt.intent === "create" ? (
            <Button onClick={() => void onSwitchBrand(otherFeishuBrand(attempt.brand))} variant="secondary">
              {SETUP_COPY.messaging.feishuBrandSwitch(
                messagingProviderLabel("feishu", otherFeishuBrand(attempt.brand)),
              )}
            </Button>
          ) : null}
        </>
      ) : null}
      {RETRYABLE_STATES.includes(attempt.state) ? (
        <>
          <br />
          <Button onClick={() => void onRetry(attempt.intent)}>Retry Feishu setup</Button>
        </>
      ) : null}
    </Banner>
  );
}

function FeishuQrCode({ brand, value }: { brand: FeishuBrand; value: string }) {
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
      alt={SETUP_COPY.messaging.qrAlt(messagingProviderLabel("feishu", brand))}
      className="my-3 size-60 max-w-full rounded-md bg-kumo-base p-2 ring ring-kumo-line"
      src={source}
    />
  ) : null;
}

function setupRecovery(attempt: FeishuSetupAttempt): string | undefined {
  if (attempt.errorCode && FEISHU_SETUP_MESSAGES[attempt.errorCode]) return FEISHU_SETUP_MESSAGES[attempt.errorCode];
  if (attempt.state === "expired") return FEISHU_SETUP_MESSAGES.FEISHU_SETUP_EXPIRED;
  if (attempt.state === "canceled") return FEISHU_SETUP_MESSAGES.FEISHU_SETUP_CANCELED;
  if (attempt.state === "failed") return "Feishu setup failed. Retry or contact the Account owner for help.";
  return undefined;
}

/**
 * One recovery message per Server-reported code, whether it arrives as a failed
 * attempt or as the error of a request that never produced one.
 */
function normalizeError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && FEISHU_SETUP_MESSAGES[code]) return FEISHU_SETUP_MESSAGES[code];
  return cause instanceof Error ? cause.message : fallback;
}
