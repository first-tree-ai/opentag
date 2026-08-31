import {
  AGENT_RUNTIME_TEST_FAILURE_CODES,
  type AgentRuntimeTestFailureCode,
  type AgentRuntimeTestResponse,
} from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, SettingsRow } from "../../../ui/design-system.js";

type RuntimeTestFailure = AgentRuntimeTestFailureCode | "request";
type RuntimeTestView =
  | Extract<AgentRuntimeTestResponse, { status: "passed" }>
  | { status: "failed"; code: RuntimeTestFailure };

export function RuntimeTestAction({
  agentId,
  disabledReason,
  expectedRevision,
  expectedRuntimeConfigRevision,
  providerName,
}: {
  readonly agentId: string;
  readonly disabledReason?: string;
  readonly expectedRevision: number;
  readonly expectedRuntimeConfigRevision: number;
  readonly providerName?: string;
}) {
  // A new saved configuration identity remounts the session so an in-flight test is aborted and a
  // previous result cannot outlive the revisions it described.
  return (
    <RuntimeTestActionSession
      key={`${agentId}:${expectedRevision}:${expectedRuntimeConfigRevision}`}
      agentId={agentId}
      disabledReason={disabledReason}
      expectedRevision={expectedRevision}
      expectedRuntimeConfigRevision={expectedRuntimeConfigRevision}
      providerName={providerName ?? "Provider"}
    />
  );
}

function RuntimeTestActionSession({
  agentId,
  disabledReason,
  expectedRevision,
  expectedRuntimeConfigRevision,
  providerName,
}: {
  readonly agentId: string;
  readonly disabledReason?: string;
  readonly expectedRevision: number;
  readonly expectedRuntimeConfigRevision: number;
  readonly providerName: string;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RuntimeTestView>();
  const abortRef = useRef<AbortController>(undefined);
  const descriptionId = `runtime-test-description-${agentId}`;
  const disabledReasonId = `runtime-test-disabled-${agentId}`;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, []);

  async function run() {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setResult(undefined);
    setPending(true);
    try {
      const response = await browserApi.testAgentRuntime(
        agentId,
        { expectedRevision, expectedRuntimeConfigRevision },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(response);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setResult({ status: "failed", code: "request" });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <SettingsRow
      description={<span id={descriptionId}>{m.agent_settings_runtime_test_description()}</span>}
      label={m.agent_settings_runtime_test_heading()}
      supportingContent={
        <>
          {disabledReason ? (
            <p className="text-sm text-kumo-subtle" id={disabledReasonId}>
              {disabledReason}
            </p>
          ) : null}
          {result ? <RuntimeTestResultMessage providerName={providerName} result={result} /> : null}
        </>
      }
    >
      <div className="flex justify-start @min-[44rem]/workspace:justify-end">
        <Button
          aria-describedby={`${descriptionId}${disabledReason ? ` ${disabledReasonId}` : ""}`}
          disabled={pending || Boolean(disabledReason)}
          variant="secondary"
          onClick={() => void run()}
        >
          {pending ? m.agent_settings_runtime_test_pending() : m.agent_settings_runtime_test_action()}
        </Button>
      </div>
    </SettingsRow>
  );
}

function RuntimeTestResultMessage({
  providerName,
  result,
}: {
  readonly providerName: string;
  readonly result: RuntimeTestView;
}) {
  if (result.status === "passed") {
    return (
      <p className="text-sm text-kumo-success" role="status">
        {m.agent_settings_runtime_test_passed()}
      </p>
    );
  }
  return (
    <p className="text-sm text-kumo-danger" role="alert">
      {runtimeTestFailureMessage(result.code, providerName)}
    </p>
  );
}

export function runtimeTestFailureMessage(code: RuntimeTestFailure, providerName = "Provider"): string {
  switch (code) {
    case "busy":
      return m.agent_settings_runtime_test_failed_busy();
    case "cancelled":
      return m.agent_settings_runtime_test_failed_cancelled();
    case "capability_missing":
      return m.agent_settings_runtime_test_failed_capability_missing();
    case "computer_unavailable":
      return m.agent_settings_runtime_test_failed_computer_unavailable();
    case "interaction_or_tool":
      return m.agent_settings_runtime_test_failed_interaction_or_tool();
    case "provider_failed":
      return m.agent_settings_runtime_test_failed_provider_failed();
    case "provider_start_failed":
      return m.agent_settings_runtime_test_failed_provider_start_failed({ providerName });
    case "stale_configuration":
      return m.agent_settings_runtime_test_failed_stale_configuration();
    case "timeout":
      return m.agent_settings_runtime_test_failed_timeout();
    case "request":
      return m.agent_settings_runtime_test_failed_request();
  }
  return m.agent_settings_runtime_test_failed_request();
}

export const RUNTIME_TEST_FAILURE_CODES = [...AGENT_RUNTIME_TEST_FAILURE_CODES, "request"] as const;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
