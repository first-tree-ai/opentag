import type { AgentDetail, FeishuSetupAttempt } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { ApiError, browserApi } from "../../../api.js";
import { formatDate } from "../../../lib/format.js";
import { useResource } from "../../../lib/resource.js";
import { AsyncState } from "../../../ui/async-state.js";
import { DefinitionList } from "../../../ui/data-display.js";
import { EmptyState } from "../../../ui/empty-state.js";
import { Notice } from "../../../ui/feedback.js";

export function ImTab({ agent }: { agent: AgentDetail }) {
  const [reload, setReload] = useState(0);
  const [attempt, setAttempt] = useState<FeishuSetupAttempt>();
  const [error, setError] = useState<string>();
  const [reauthorizationNeeded, setReauthorizationNeeded] = useState(false);
  const state = useResource(() => browserApi.agents.imBinding(agent.id), `${agent.id}:${reload}`);
  const connect = useCallback(
    async (intent: "create" | "reauthorize" = "create") => {
      try {
        setError(undefined);
        setAttempt(await browserApi.agents.createFeishuSetupAttempt(agent.id, intent));
        setReauthorizationNeeded(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to start setup");
      }
    },
    [agent.id],
  );
  useEffect(() => {
    if (!attempt || !["awaiting_user", "validating"].includes(attempt.state)) return;
    const timer = window.setInterval(() => {
      void browserApi.agents.feishuSetupAttempt(attempt.id).then(
        (next) => {
          setAttempt(next);
          if (next.state === "succeeded") setReload((value) => value + 1);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh setup"),
      );
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [attempt]);
  async function changeReceiveMode(receiveMode: "mention_only" | "all_message") {
    if (
      receiveMode === "all_message" &&
      !window.confirm(
        "All-message mode may expose more conversation content and increase token usage and cost. Continue?",
      )
    )
      return;
    try {
      const config = await browserApi.agents.config(agent.id);
      await browserApi.agents.update(agent.id, { expectedRevision: config.revision, receiveMode });
      setReload((value) => value + 1);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
        setReauthorizationNeeded(true);
      }
      setError(cause instanceof Error ? cause.message : "Unable to change receive mode");
    }
  }
  return (
    <AsyncState state={state}>
      {(binding) => (
        <>
          {binding ? (
            <DefinitionList
              rows={[
                ["Provider", binding.provider],
                ["Binding state", binding.bindingState],
                ["Receive mode", binding.receiveMode],
                ["Last confirmed", binding.lastConfirmedAt ? formatDate(binding.lastConfirmedAt) : "Unable to confirm"],
              ]}
            />
          ) : (
            <EmptyState title="No IM binding">Connect a supported IM bot when the Agent is ready.</EmptyState>
          )}
          {agent.viewerCapabilities.canManage ? (
            <div className="actions">
              {!binding ? (
                <button className="button" type="button" onClick={() => void connect()}>
                  Connect Feishu
                </button>
              ) : null}
              {(binding?.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
              binding?.provider === "feishu" ? (
                <button className="button" type="button" onClick={() => void connect("reauthorize")}>
                  Reauthorize Feishu
                </button>
              ) : null}
              {(binding?.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
              binding?.provider === "slack" ? (
                <Notice inline>Slack reauthorization is not available in this release.</Notice>
              ) : null}
              {binding?.receiveMode === "mention_only" ? (
                <button type="button" onClick={() => void changeReceiveMode("all_message")}>
                  Enable all messages
                </button>
              ) : binding ? (
                <button type="button" onClick={() => void changeReceiveMode("mention_only")}>
                  Use mentions only
                </button>
              ) : null}
              {binding ? (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Disable this IM binding? New IM work will stop until another binding is connected.",
                      )
                    )
                      return;
                    void browserApi.agents.disableImBinding(binding.id).then(
                      () => setReload((value) => value + 1),
                      (cause: unknown) =>
                        setError(cause instanceof Error ? cause.message : "Unable to disable IM binding"),
                    );
                  }}
                >
                  Disable IM binding
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted">IM setup is managed by Team Admins.</p>
          )}
          {attempt ? (
            <Notice>
              <strong>Feishu setup started</strong>
              <br />
              State: {attempt.state}. Expires {formatDate(attempt.expiresAt)}.
              {attempt.qrUrl ? (
                <>
                  <br />
                  <FeishuQrCode value={attempt.qrUrl} />
                  <a href={attempt.qrUrl} rel="noreferrer" target="_blank">
                    Open Feishu authorization
                  </a>
                </>
              ) : null}
              {["expired", "failed", "canceled"].includes(attempt.state) ? (
                <>
                  <br />
                  <button
                    className="button"
                    type="button"
                    onClick={() => void connect(attempt.intent === "reauthorize" ? "reauthorize" : "create")}
                  >
                    Retry Feishu setup
                  </button>
                </>
              ) : null}
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
        </>
      )}
    </AsyncState>
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
