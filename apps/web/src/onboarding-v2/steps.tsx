import type { CloudAvailability, ImProvider } from "@opentag/shared/browser";
import { type FormEvent, useId, useState } from "react";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon, KumoInputControl, Text } from "../ui/design-system.js";
import { BrandMark } from "./brand-mark.js";
import {
  type AgentDraft,
  DEFAULT_AGENT_NAME,
  type Destination,
  draftIsSubmittable,
  type FlowState,
  RUNTIMES,
  type Runtime,
  validateAgentName,
} from "./flow.js";

const STEP = "flex flex-col gap-6";
const HEADER = "flex flex-col gap-1";
const FIELDSET = "flex flex-col gap-1 m-0 p-0 border-0";
const HINT = "text-sm text-kumo-subtle m-0";
const CHOICES = "flex flex-col gap-3 m-0 p-0 list-none";
const CHOICE_GRID = "otv2-choices--grid grid gap-3 m-0 p-0 list-none";
const CARD =
  "otv2-choice flex w-full items-center justify-start gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";

export function StepRail({ steps }: { steps: FlowState["steps"] }) {
  return (
    <nav aria-label={m.onboarding_v2_setup_progress()} className="w-full" data-ui="onboarding-v2-rail">
      <ol className="flex gap-2 m-0 p-0 list-none">
        {steps.map((step, index) => (
          <li
            aria-current={step.status === "current" ? "step" : undefined}
            className="otv2-rail__step flex flex-1 items-center gap-2 min-w-0 pt-3 text-xs text-kumo-subtle"
            data-status={step.status}
            key={step.id}
          >
            <span
              aria-hidden="true"
              className="otv2-rail__marker inline-flex shrink-0 items-center justify-center rounded-full bg-kumo-recessed text-xs"
            >
              {step.status === "complete" ? <Icon name="check" /> : index + 1}
            </span>
            <span data-ui="onboarding-v2-rail-label">
              {step.id === "agent"
                ? m.onboarding_v2_step_agent_label()
                : step.id === "computer"
                  ? m.onboarding_v2_step_computer_label()
                  : m.onboarding_v2_step_messaging_label()}
            </span>
            {step.status === "complete" ? <span className="sr-only">{m.onboarding_v2_completed()}</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StepNav({
  back,
  backDisabled = false,
  label = m.onboarding_v2_nav_next(),
  nextDisabled = false,
  onNext,
  submit = false,
}: {
  back?: () => void;
  backDisabled?: boolean;
  label?: string;
  nextDisabled?: boolean;
  onNext?: () => void;
  submit?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3" data-ui="onboarding-v2-nav">
      <div data-ui="onboarding-v2-nav-back">
        {back ? (
          <Button disabled={backDisabled} onClick={back} variant="ghost">
            <Icon name="arrow-left" />
            <span>{m.onboarding_v2_nav_back()}</span>
          </Button>
        ) : null}
      </div>
      <div data-ui="onboarding-v2-nav-next">
        <Button disabled={nextDisabled} onClick={onNext} type={submit ? "submit" : "button"}>
          {label}
        </Button>
      </div>
    </div>
  );
}

export function CardCopy({
  badge,
  description,
  disabled = false,
  title,
}: {
  badge?: string;
  description: string;
  disabled?: boolean;
  title: string;
}) {
  return (
    <span className="flex flex-col gap-1 min-w-0">
      <span
        className={`flex items-center gap-2 font-medium ${disabled ? "text-kumo-subtle" : "text-kumo-strong"}`}
        data-ui="onboarding-v2-card-title"
      >
        {title}
        {badge ? (
          <em className="rounded bg-kumo-recessed px-2 py-1 text-xs uppercase text-kumo-subtle">{badge}</em>
        ) : null}
      </span>
      <span className="text-sm text-kumo-subtle">{description}</span>
    </span>
  );
}

/**
 * The deployment's Cloud availability as far as this page has confirmed it. Until the read
 * answers — and when it has failed — the Cloud choice stays disabled rather than guessing either
 * way, and the copy says which of the three the reader is looking at.
 */
export type CloudDestinationRead =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly available: boolean; readonly reason: CloudAvailability["reason"] };

function DestinationCard({
  badge,
  description,
  disabled = false,
  icon,
  onChoose,
  selected,
  title,
}: {
  badge?: string;
  description: string;
  disabled?: boolean;
  icon: "laptop" | "model";
  onChoose: () => void;
  selected: boolean;
  title: string;
}) {
  return (
    <Button aria-pressed={selected} className={CARD} disabled={disabled} onClick={onChoose} variant="ghost">
      <Icon className={`size-10 shrink-0 ${disabled ? "text-kumo-subtle" : "text-kumo-brand"}`} name={icon} />
      <CardCopy badge={badge} description={description} disabled={disabled} title={title} />
    </Button>
  );
}

/*
 * Three Cloud cards, one per read state: the unanswered read describes the destination and says it
 * is checking; the failed read says the check failed and offers the retry; only an answered "no"
 * claims the deployment cannot offer Cloud.
 */
function cloudDestinationCopy(cloud: CloudDestinationRead): { badge?: string; description: string } {
  if (cloud.kind === "failed") {
    return {
      badge: m.onboarding_v2_destination_cloud_check_failed_badge(),
      description: m.onboarding_v2_destination_cloud_check_failed_description(),
    };
  }
  if (cloud.kind === "ready" && !cloud.available) {
    return {
      badge: m.onboarding_v2_destination_cloud_unavailable_badge(),
      description: m.onboarding_v2_destination_cloud_unavailable_description(),
    };
  }
  return {
    badge: cloud.kind === "loading" ? m.onboarding_v2_destination_cloud_checking() : undefined,
    description: m.onboarding_v2_destination_cloud_description(),
  };
}

export function DestinationStep({
  cloud,
  draft,
  onChoose,
  onCloudRetry,
  onSubmit,
}: {
  cloud: CloudDestinationRead;
  draft: AgentDraft;
  onChoose: (destination: Destination) => void;
  onCloudRetry?: () => void;
  onSubmit: () => void;
}) {
  const cloudEnabled = cloud.kind === "ready" && cloud.available;
  const cloudCopy = cloudDestinationCopy(cloud);
  return (
    <section className={STEP} data-ui="onboarding-v2-step-destination">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_destination_title()}
        </Text>
      </header>
      <ul className={CHOICES}>
        <li>
          <DestinationCard
            description={m.onboarding_v2_destination_local_description()}
            icon="laptop"
            selected={draft.destination === "local"}
            title={m.onboarding_v2_destination_local_title()}
            onChoose={() => onChoose("local")}
          />
        </li>
        <li>
          <DestinationCard
            badge={cloudCopy.badge}
            description={cloudCopy.description}
            disabled={!cloudEnabled}
            icon="model"
            selected={draft.destination === "cloud"}
            title={m.onboarding_v2_destination_cloud_title()}
            onChoose={() => onChoose("cloud")}
          />
          {cloud.kind === "failed" && onCloudRetry ? (
            <div className="mt-2 flex justify-end">
              <Button size="compact" type="button" variant="secondary" onClick={onCloudRetry}>
                {m.common_try_again()}
              </Button>
            </div>
          ) : null}
        </li>
      </ul>
      <StepNav nextDisabled={!draft.destination} onNext={onSubmit} />
    </section>
  );
}

function AgentNameField({
  draft,
  onBlur,
  onChange,
  showError,
}: {
  draft: AgentDraft;
  onBlur: () => void;
  onChange: (draft: AgentDraft) => void;
  showError: boolean;
}) {
  const nameId = useId();
  const hintId = `${nameId}-hint`;
  const errorId = `${nameId}-error`;
  const error = showError ? validateAgentName(draft.name) : undefined;
  const errorText =
    error === "empty"
      ? m.onboarding_v2_agent_name_empty_error()
      : error === "too-long"
        ? m.onboarding_v2_agent_name_too_long_error()
        : error === "charset"
          ? m.onboarding_v2_agent_name_charset_error()
          : undefined;
  return (
    <div className={FIELDSET} data-ui="onboarding-v2-field">
      <label className="font-medium text-kumo-strong" htmlFor={nameId}>
        {m.onboarding_v2_agent_name_label()}
      </label>
      <p className={HINT} id={hintId}>
        {m.onboarding_v2_agent_name_hint()}
      </p>
      <KumoInputControl
        aria-label={m.onboarding_v2_agent_name_label()}
        aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
        aria-invalid={errorText ? true : undefined}
        autoComplete="off"
        id={nameId}
        onBlur={onBlur}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        placeholder={DEFAULT_AGENT_NAME}
        spellCheck={false}
        value={draft.name}
      />
      <p
        aria-live="polite"
        className={`otv2-field-error text-sm m-0 ${errorText ? "text-kumo-danger" : "text-kumo-subtle"}`}
        data-empty={errorText ? undefined : "true"}
        id={errorId}
      >
        {errorText ?? " "}
      </p>
    </div>
  );
}

function runtimeTitle(runtime: Runtime): string {
  if (runtime === "codex") return m.onboarding_v2_runtime_codex_title();
  if (runtime === "claude-code") return m.onboarding_v2_runtime_claude_code_title();
  return m.onboarding_v2_runtime_pi_title();
}

function runtimeDescription(runtime: Runtime): string {
  if (runtime === "codex") return m.onboarding_v2_runtime_codex_description();
  if (runtime === "claude-code") return m.onboarding_v2_runtime_claude_code_description();
  return m.onboarding_v2_runtime_pi_description();
}

function RuntimeMark({ runtime }: { runtime: Runtime }) {
  return <BrandMark brand={runtime} label={runtimeTitle(runtime)} />;
}

function RuntimePicker({ draft, onChange }: { draft: AgentDraft; onChange: (draft: AgentDraft) => void }) {
  if (draft.destination === "cloud") return null;
  return (
    <fieldset className={FIELDSET}>
      <legend className="font-medium text-kumo-strong">{m.onboarding_v2_agent_runtime_label()}</legend>
      <p className={HINT}>{m.onboarding_v2_agent_runtime_hint()}</p>
      <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
        {RUNTIMES.map((runtime) => (
          <li key={runtime}>
            <Button
              aria-pressed={draft.runtime === runtime}
              className={CARD}
              onClick={() => onChange({ ...draft, runtime })}
              variant="ghost"
            >
              <RuntimeMark runtime={runtime} />
              <CardCopy description={runtimeDescription(runtime)} title={runtimeTitle(runtime)} />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-kumo-subtle m-0">{m.onboarding_v2_agent_runtime_footnote()}</p>
    </fieldset>
  );
}

export function AgentStep({
  draft,
  onBack,
  onChange,
  onSubmit,
  submitLabel,
  submitting = false,
}: {
  draft: AgentDraft;
  onBack?: () => void;
  onChange: (draft: AgentDraft) => void;
  onSubmit: () => void;
  submitLabel?: string;
  submitting?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (draftIsSubmittable(draft)) onSubmit();
  }
  return (
    <section className={STEP} data-ui="onboarding-v2-step-agent">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_agent_title()}
        </Text>
      </header>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <AgentNameField draft={draft} onBlur={() => setTouched(true)} onChange={onChange} showError={touched} />
        <RuntimePicker draft={draft} onChange={onChange} />
        <StepNav
          back={onBack}
          backDisabled={submitting}
          label={submitLabel}
          nextDisabled={submitting || (draft.destination !== "cloud" && draft.runtime === undefined)}
          submit
        />
      </form>
    </section>
  );
}

export function DoneStep({
  action,
  completion,
  name,
  provider,
}: {
  action?: { label: string; onClick: () => void };
  completion?: { onFinish: () => void; state: "failed" | "pending" | "ready" };
  name: string;
  provider?: ImProvider;
}) {
  const providerMention = provider === "slack" ? "OpenTag" : name;
  return (
    <section className="flex flex-col items-center gap-6 text-center" data-ui="onboarding-v2-step-done">
      <span
        aria-hidden="true"
        className="inline-flex size-10 items-center justify-center rounded-full bg-kumo-tint text-kumo-brand"
      >
        <Icon name="check" />
      </span>
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_done_title({ name })}
        </Text>
        <p className="text-kumo-subtle m-0">
          {provider
            ? spaceScriptBoundary(
                m.onboarding_v2_done_description({
                  mention: providerMention,
                  provider: messagingProviderLabel(provider),
                }),
              )
            : m.onboarding_v2_done_description_any_app({ name })}
        </p>
      </header>
      {completion ? (
        <Button disabled={completion.state === "pending"} onClick={completion.onFinish}>
          {completion.state === "ready"
            ? m.onboarding_v2_done_finish_reboard()
            : completion.state === "pending"
              ? m.onboarding_v2_done_finishing()
              : m.onboarding_v2_done_retry_finish()}
        </Button>
      ) : action ? (
        <Button onClick={action.onClick}>{action.label}</Button>
      ) : null}
    </section>
  );
}
