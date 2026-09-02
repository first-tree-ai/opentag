import type { ImProvider } from "@opentag/shared/browser";
import { type FormEvent, useId, useState } from "react";
import { messagingProviderLabel, spaceBrandInSentence } from "../im/provider-label.js";
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
  "otv2-choice flex w-full items-center gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";

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
  disabled = false,
  label = m.onboarding_v2_nav_next(),
  onNext,
  submit = false,
}: {
  back?: () => void;
  disabled?: boolean;
  label?: string;
  onNext?: () => void;
  submit?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3" data-ui="onboarding-v2-nav">
      <div data-ui="onboarding-v2-nav-back">
        {back ? (
          <Button onClick={back} variant="ghost">
            <Icon name="arrow-left" />
            <span>{m.onboarding_v2_nav_back()}</span>
          </Button>
        ) : null}
      </div>
      <div data-ui="onboarding-v2-nav-next">
        <Button disabled={disabled} onClick={onNext} type={submit ? "submit" : "button"}>
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

export function DestinationStep({
  cloudAvailable,
  draft,
  onChoose,
  onSubmit,
}: {
  cloudAvailable: boolean;
  draft: AgentDraft;
  onChoose: (destination: Destination) => void;
  onSubmit: () => void;
}) {
  const destinations: readonly { id: Destination; icon: "laptop" | "model"; enabled: boolean }[] = [
    { id: "local", icon: "laptop", enabled: true },
    { id: "cloud", icon: "model", enabled: cloudAvailable },
  ];
  return (
    <section className={STEP} data-ui="onboarding-v2-step-destination">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_destination_title()}
        </Text>
      </header>
      <ul className={CHOICES}>
        {destinations.map((destination) => {
          const copy =
            destination.id === "local"
              ? {
                  title: m.onboarding_v2_destination_local_title(),
                  description: m.onboarding_v2_destination_local_description(),
                }
              : {
                  title: m.onboarding_v2_destination_cloud_title(),
                  description: m.onboarding_v2_destination_cloud_description(),
                };
          return (
            <li key={destination.id}>
              <Button
                aria-pressed={draft.destination === destination.id}
                className={CARD}
                disabled={!destination.enabled}
                onClick={() => onChoose(destination.id)}
                variant="ghost"
              >
                <Icon
                  className={`size-10 shrink-0 ${destination.enabled ? "text-kumo-brand" : "text-kumo-subtle"}`}
                  name={destination.icon}
                />
                <CardCopy
                  badge={destination.enabled ? undefined : m.onboarding_v2_coming_soon()}
                  description={copy.description}
                  disabled={!destination.enabled}
                  title={copy.title}
                />
              </Button>
            </li>
          );
        })}
      </ul>
      <StepNav disabled={!draft.destination} onNext={onSubmit} />
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

function RuntimeMark({ runtime }: { runtime: Runtime }) {
  return (
    <BrandMark
      brand={runtime}
      label={runtime === "codex" ? m.onboarding_v2_runtime_codex_title() : m.onboarding_v2_runtime_claude_code_title()}
    />
  );
}

function RuntimePicker({ draft, onChange }: { draft: AgentDraft; onChange: (draft: AgentDraft) => void }) {
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
              <CardCopy
                description={
                  runtime === "codex"
                    ? m.onboarding_v2_runtime_codex_description()
                    : m.onboarding_v2_runtime_claude_code_description()
                }
                title={
                  runtime === "codex"
                    ? m.onboarding_v2_runtime_codex_title()
                    : m.onboarding_v2_runtime_claude_code_title()
                }
              />
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
        <StepNav back={onBack} disabled={submitting || draft.runtime === undefined} label={submitLabel} submit />
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
  completion?: { onFinish: () => void };
  name: string;
  provider?: ImProvider;
}) {
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
            ? spaceBrandInSentence(
                m.onboarding_v2_done_description({ name, provider: messagingProviderLabel(provider) }),
              )
            : m.onboarding_v2_done_description_any_app({ name })}
        </p>
      </header>
      {completion ? (
        <Button onClick={completion.onFinish}>{m.onboarding_v2_done_retry_finish()}</Button>
      ) : action ? (
        <Button onClick={action.onClick}>{action.label}</Button>
      ) : null}
    </section>
  );
}
