import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { browserApi } from "./api.js";

const PENDING_STATES: readonly FeishuSetupAttempt["state"][] = ["awaiting_user", "validating"];
const RETRYABLE_STATES: readonly FeishuSetupAttempt["state"][] = ["expired", "failed", "canceled"];
const POLL_INTERVAL_MS = 1_500;

export interface FeishuSetupController {
  attempt: FeishuSetupAttempt | undefined;
  error: string | undefined;
  /** Resolves to the started attempt, or undefined when it could not be started. */
  start: (intent?: FeishuSetupIntent) => Promise<FeishuSetupAttempt | undefined>;
}

/**
 * Owns one Feishu setup attempt for an Agent: creation, polling, and the
 * succeeded hand-off. Shared by the Agent IM tab and onboarding so a single
 * attempt lifecycle exists, and neither surface can start a second bot.
 */
export function useFeishuSetup(agentId: string, onSucceeded: () => void): FeishuSetupController {
  const [attempt, setAttempt] = useState<FeishuSetupAttempt>();
  const [error, setError] = useState<string>();
  const start = useCallback(
    async (intent: FeishuSetupIntent = "create") => {
      try {
        setError(undefined);
        const started = await browserApi.createFeishuSetupAttempt(agentId, intent);
        setAttempt(started);
        return started;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to start setup");
        return undefined;
      }
    },
    [agentId],
  );
  useEffect(() => {
    if (!attempt || !PENDING_STATES.includes(attempt.state)) return;
    const timer = window.setInterval(() => {
      void browserApi.feishuSetupAttempt(attempt.id).then(
        (next) => {
          setAttempt(next);
          if (next.state === "succeeded") onSucceeded();
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh setup"),
      );
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [attempt, onSucceeded]);
  return { attempt, error, start };
}

export function FeishuSetupAttemptPanel({
  attempt,
  onRetry,
}: {
  attempt: FeishuSetupAttempt;
  onRetry: (intent: FeishuSetupIntent) => void;
}) {
  return (
    <div className="notice">
      <strong>Feishu setup started</strong>
      <br />
      State: {attempt.state}. Expires {formatSetupDate(attempt.expiresAt)}.
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
          <button
            className="button"
            type="button"
            onClick={() => onRetry(attempt.intent === "reauthorize" ? "reauthorize" : "create")}
          >
            Retry Feishu setup
          </button>
        </>
      ) : null}
    </div>
  );
}

export function FeishuQrCode({ value }: { value: string }) {
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

function formatSetupDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
