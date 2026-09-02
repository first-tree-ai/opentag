import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import * as m from "../paraglide/messages.js";
import { Banner, Button, Loader, Text } from "../ui/design-system.js";
import {
  type CreationIntentRecord,
  type CreationIntentRequest,
  checkCreationIntentResult,
  clearCreationIntent,
} from "./creation-intent-store.js";

/** The answer a Check produced and the section narrates: still absent, ambiguous, or the read failed closed. */
export type CreationCheckOutcome =
  | { readonly kind: "ambiguous" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "not-found" };

export interface CreationRecovery {
  readonly busy: boolean;
  readonly check: () => Promise<void>;
  readonly checkInFlightRef: RefObject<boolean>;
  readonly checking: boolean;
  readonly discard: () => Promise<void>;
  readonly intent: CreationIntentRecord | undefined;
  readonly outcome: CreationCheckOutcome | undefined;
  readonly retry: () => void;
  readonly retryRouteSelected: boolean;
  readonly retrying: boolean;
}

interface CreationRecoveryInput {
  readonly accountId: string;
  readonly create: (request: CreationIntentRequest, intent?: CreationIntentRecord) => Promise<void>;
  readonly createInFlightRef: RefObject<boolean>;
  readonly dismissedIntentId: string | undefined;
  readonly onSubmittingChange?: (submitting: boolean) => void;
  readonly onDiscarded?: () => void;
  readonly pendingIntent: CreationIntentRecord | undefined;
  readonly preview: boolean;
  readonly selectedRequest: CreationIntentRequest | undefined;
  readonly setDismissedIntentId: (creationIntentId: string) => void;
  readonly submitting: boolean;
}

/*
 * A persisted intent is a prior visit's unfinished business, never this visit's instruction:
 * mounting must neither send it nor rewrite or drop it. The intent is surfaced as an explicit
 * choice — Check the result, Retry the same attempt, or Discard it — and only the reader's press
 * runs one of those.
 */
export function useCreationRecovery({
  accountId,
  create,
  createInFlightRef,
  dismissedIntentId,
  onSubmittingChange,
  onDiscarded,
  pendingIntent,
  preview,
  selectedRequest,
  setDismissedIntentId,
  submitting,
}: CreationRecoveryInput): CreationRecovery {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<CreationCheckOutcome>();
  const [retrying, setRetrying] = useState(false);
  const checkInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const intent = pendingIntent && pendingIntent.creationIntentId !== dismissedIntentId ? pendingIntent : undefined;
  /**
   * Retry fires the saved request verbatim, so it is offered only while that exact route is the one
   * on screen and ready — the same visibility rule the form applies to a fresh submission.
   */
  const retryRouteSelected =
    intent !== undefined && selectedRequest !== undefined && requestsMatch(selectedRequest, intent.request);

  /**
   * Reconciles the saved attempt against the Server without mutating anything there. The only local
   * writes happen once the exact Agent answers — the intent is retired and the reader lands on that
   * Agent's canonical setup. Zero or several matches, and a failed read, all fail closed: the
   * attempt stays saved and nothing navigates.
   */
  const check = useCallback(async () => {
    const record = intent;
    if (preview || !record || checkInFlightRef.current || createInFlightRef.current) return;
    checkInFlightRef.current = true;
    setChecking(true);
    setOutcome(undefined);
    onSubmittingChange?.(true);
    await runCreationCheck(accountId, record, {
      finish: () => {
        checkInFlightRef.current = false;
        if (!mountedRef.current) return;
        setChecking(false);
        onSubmittingChange?.(false);
      },
      report: (next) => {
        if (mountedRef.current) setOutcome(next);
      },
      settle: async (agentId) => {
        if (!mountedRef.current) return;
        setDismissedIntentId(record.creationIntentId);
        await navigate({ to: "/agents/setup", search: { agentId } });
      },
    });
  }, [accountId, createInFlightRef, intent, navigate, onSubmittingChange, preview, setDismissedIntentId]);

  /** Retry continues the saved attempt, so it keeps the original idempotency identity verbatim. */
  const retry = useCallback(() => {
    if (!intent || !retryRouteSelected || checkInFlightRef.current) return;
    setRetrying(true);
    setOutcome(undefined);
    void create(intent.request, intent).finally(() => {
      if (mountedRef.current) setRetrying(false);
    });
  }, [create, intent, retryRouteSelected]);

  /**
   * Discard ends the saved identity locally and sends nothing. The form keeps the values it already
   * shows, so creating afterwards is a new attempt under a fresh idempotency identity.
   */
  const discard = useCallback(async () => {
    const record = intent;
    if (preview || !record || checkInFlightRef.current || createInFlightRef.current) return;
    await clearCreationIntent(accountId, record.creationIntentId);
    if (!mountedRef.current) return;
    setOutcome(undefined);
    setDismissedIntentId(record.creationIntentId);
    onDiscarded?.();
  }, [accountId, createInFlightRef, intent, onDiscarded, preview, setDismissedIntentId]);

  return {
    busy: checking || submitting,
    check,
    checkInFlightRef,
    checking,
    discard,
    intent,
    outcome,
    retry,
    retryRouteSelected,
    retrying,
  };
}

function requestsMatch(left: CreationIntentRequest, right: CreationIntentRequest): boolean {
  return (
    left.name === right.name &&
    left.displayName === right.displayName &&
    left.runtimeProvider === right.runtimeProvider &&
    left.computerId === right.computerId
  );
}

/**
 * The explicit decision a saved creation intent asks for. Renders nothing without one, so callers
 * mount it unconditionally; it owns the Check / Retry / Discard actions and their feedback.
 */
export function CreationRecoverySection({ recovery }: { readonly recovery: CreationRecovery }) {
  const intent = recovery.intent;
  if (!intent) return null;
  return (
    <section
      aria-labelledby="agent-creation-recovery-heading"
      className="grid gap-3 rounded-md bg-kumo-base p-3 ring ring-kumo-line"
    >
      <div className="grid gap-1">
        <Text as="h3" id="agent-creation-recovery-heading" variant="heading">
          {m.agent_create_recovery_title()}
        </Text>
        <Text as="p" variant="secondary">
          {m.agent_create_recovery_description({ displayName: intent.request.displayName })}
        </Text>
      </div>
      {recovery.outcome ? (
        <Banner
          description={checkOutcomeDescription(intent, recovery.outcome)}
          role={recovery.outcome.kind === "not-found" ? "status" : "alert"}
          variant={recovery.outcome.kind === "not-found" ? "secondary" : "error"}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button disabled={recovery.busy} onClick={() => void recovery.check()}>
          {recovery.checking ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">
                <Loader aria-label={m.agent_create_checking_result_label()} size="sm" />
              </span>
              {m.agent_create_checking_action()}
            </span>
          ) : (
            m.agent_create_check_result_action()
          )}
        </Button>
        <Button disabled={recovery.busy || !recovery.retryRouteSelected} variant="secondary" onClick={recovery.retry}>
          {recovery.retrying ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">
                <Loader aria-label={m.agent_create_creating_agent_label()} size="sm" />
              </span>
              {m.agent_create_creating_action()}
            </span>
          ) : (
            m.agent_create_retry_action()
          )}
        </Button>
        <Button disabled={recovery.busy} variant="ghost" onClick={() => void recovery.discard()}>
          {m.agent_create_discard_action()}
        </Button>
      </div>
      {recovery.retryRouteSelected ? null : (
        <Text as="p" variant="secondary">
          {m.agent_create_retry_route_unavailable()}
        </Text>
      )}
    </section>
  );
}

interface CreationCheckSink {
  readonly finish: () => void;
  readonly report: (outcome: CreationCheckOutcome) => void;
  readonly settle: (agentId: string) => Promise<void>;
}

/**
 * The Check operation itself, kept out of the component: reconcile the record read-only, then hand
 * the outcome to the sink. Retiring the intent and leaving for the exact Agent's canonical setup
 * happen only on a single exact match, through `settle`.
 */
async function runCreationCheck(
  accountId: string,
  record: CreationIntentRecord,
  sink: CreationCheckSink,
): Promise<void> {
  try {
    const result = await checkCreationIntentResult(record);
    if (result.kind !== "found") {
      sink.report(result);
      return;
    }
    await clearCreationIntent(accountId, record.creationIntentId);
    await sink.settle(result.agentId);
  } catch (cause) {
    sink.report({ kind: "error", message: checkErrorMessage(cause) });
  } finally {
    sink.finish();
  }
}

function checkOutcomeDescription(intent: CreationIntentRecord, outcome: CreationCheckOutcome): string {
  if (outcome.kind === "not-found") return m.agent_create_check_not_found({ name: intent.request.name });
  if (outcome.kind === "ambiguous") return m.agent_create_check_ambiguous({ name: intent.request.name });
  return outcome.message;
}

function checkErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : m.agent_create_check_failed();
}
