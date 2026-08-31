import {
  AGENT_RUNTIME_TEST_FAILURE_CODES,
  type AgentRuntimeTestFailureCode,
  type AgentRuntimeTestResponse,
} from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button } from "../../../ui/design-system.js";

type RuntimeTestFailure = AgentRuntimeTestFailureCode | "request";
type RuntimeTestView =
  | Extract<AgentRuntimeTestResponse, { status: "passed" }>
  | { status: "failed"; code: RuntimeTestFailure };

export function RuntimeTestAction({
  agentId,
  expectedRevision,
  expectedRuntimeConfigRevision,
}: {
  readonly agentId: string;
  readonly expectedRevision: number;
  readonly expectedRuntimeConfigRevision: number;
}) {
  // A new saved configuration identity remounts the session so an in-flight test is aborted and a
  // previous result cannot outlive the revisions it described.
  return (
    <RuntimeTestActionSession
      key={`${agentId}:${expectedRevision}:${expectedRuntimeConfigRevision}`}
      agentId={agentId}
      expectedRevision={expectedRevision}
      expectedRuntimeConfigRevision={expectedRuntimeConfigRevision}
    />
  );
}

function RuntimeTestActionSession({
  agentId,
  expectedRevision,
  expectedRuntimeConfigRevision,
}: {
  readonly agentId: string;
  readonly expectedRevision: number;
  readonly expectedRuntimeConfigRevision: number;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RuntimeTestView>();
  const abortRef = useRef<AbortController>(undefined);
  const warningId = `runtime-test-warning-${agentId}`;

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
    <div className="grid gap-3 border-t border-kumo-line pt-3" data-ui="runtime-test">
      <p className="text-sm text-kumo-subtle" id={warningId}>
        {m.agent_settings_runtime_test_warning()}
      </p>
      <div>
        <Button aria-describedby={warningId} disabled={pending} variant="secondary" onClick={() => void run()}>
          {pending ? m.agent_settings_runtime_test_pending() : m.agent_settings_runtime_test_action()}
        </Button>
      </div>
      {result ? <RuntimeTestResultMessage result={result} /> : null}
    </div>
  );
}

function RuntimeTestResultMessage({ result }: { readonly result: RuntimeTestView }) {
  if (result.status === "passed") {
    return (
      <p className="text-sm text-kumo-success" role="status">
        {m.agent_settings_runtime_test_passed()}
      </p>
    );
  }
  return (
    <p className="text-sm text-kumo-danger" role="alert">
      {runtimeTestFailureMessage(result.code)}
    </p>
  );
}

export function runtimeTestFailureMessage(code: RuntimeTestFailure): string {
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
      return m.agent_settings_runtime_test_failed_provider_start_failed();
    case "stale_configuration":
      return m.agent_settings_runtime_test_failed_stale_configuration();
    case "timeout":
      return m.agent_settings_runtime_test_failed_timeout();
    case "request":
      return m.agent_settings_runtime_test_failed_request();
  }
}

export const RUNTIME_TEST_FAILURE_CODES = [...AGENT_RUNTIME_TEST_FAILURE_CODES, "request"] as const;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
