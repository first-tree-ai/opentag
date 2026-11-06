import type { CloudAvailability, ImProvider } from "@opentag/shared/browser";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon, KumoInputControl, StatusIndicator, Text } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
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
    <nav
      aria-label={m.onboarding_v2_setup_progress()}
      className="otv2-rail w-full"
      data-complete={steps.length > 0 && steps.every((step) => step.status === "complete")}
      data-ui="onboarding-v2-rail"
    >
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

/*
 * Steps move forward only. Leaving setup is the header's job (the Agent list, or the logo), so the
 * flow carries no second, step-by-step way back.
 */
function StepNav({
  label = m.onboarding_v2_nav_next(),
  nextDisabled = false,
  onNext,
  submit = false,
}: {
  label?: string;
  nextDisabled?: boolean;
  onNext?: () => void;
  submit?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-3" data-ui="onboarding-v2-nav">
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
  description?: string;
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
      {description ? <span className="text-sm text-kumo-subtle">{description}</span> : null}
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
  description?: string;
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
 * is checking; the failed read says the check failed and offers the retry; an answered "no" keeps
 * the disabled card with its "unavailable" badge alone, because the reason is the deployment's and
 * the reader can do nothing about it.
 */
function cloudDestinationCopy(cloud: CloudDestinationRead): { badge?: string; description?: string } {
  if (cloud.kind === "failed") {
    return {
      badge: m.onboarding_v2_destination_cloud_check_failed_badge(),
      description: m.onboarding_v2_destination_cloud_check_failed_description(),
    };
  }
  if (cloud.kind === "ready" && !cloud.available) {
    return {
      badge: m.onboarding_v2_destination_cloud_unavailable_badge(),
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
  disabled,
  draft,
  onBlur,
  onChange,
  showError,
}: {
  disabled: boolean;
  draft: AgentDraft;
  onBlur: () => void;
  onChange: (draft: AgentDraft) => void;
  showError: boolean;
}) {
  const nameId = useId();
  const hintId = `${nameId}-hint`;
  const errorId = `${nameId}-error`;
  const problem = validateAgentName(draft.name);
  // A name past the limit can't become valid by typing more, so say so while typing. Other
  // problems wait for blur or Create, so an empty field isn't flagged before anyone types.
  const error = showError || problem === "too-long" ? problem : undefined;
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
        disabled={disabled}
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

function RuntimePicker({
  disabled,
  draft,
  onChange,
}: {
  disabled: boolean;
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
}) {
  if (draft.destination === "cloud") return null;
  return (
    <fieldset className={FIELDSET}>
      <legend className="mb-2 font-medium text-kumo-strong">{m.onboarding_v2_agent_runtime_label()}</legend>
      <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
        {RUNTIMES.map((runtime) => (
          <li key={runtime}>
            <Button
              aria-pressed={draft.runtime === runtime}
              className={CARD}
              disabled={disabled}
              onClick={() => onChange({ ...draft, runtime })}
              variant="ghost"
            >
              <RuntimeMark runtime={runtime} />
              <CardCopy description={runtimeDescription(runtime)} title={runtimeTitle(runtime)} />
            </Button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function AgentStep({
  draft,
  onChange,
  onSubmit,
  submitLabel,
  submitting = false,
}: {
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
  onSubmit: () => void;
  submitLabel?: string;
  submitting?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  function change(next: AgentDraft) {
    if (!submitting) onChange(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!submitting && draftIsSubmittable(draft)) onSubmit();
  }
  return (
    <section className={STEP} data-ui="onboarding-v2-step-agent">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_agent_title()}
        </Text>
      </header>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <AgentNameField
          disabled={submitting}
          draft={draft}
          onBlur={() => setTouched(true)}
          onChange={change}
          showError={touched}
        />
        <RuntimePicker disabled={submitting} draft={draft} onChange={change} />
        <StepNav
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
  handoff,
  name,
  provider,
}: {
  action?: { label: string; onClick: () => void };
  completion?: { onFinish: () => void; state: "failed" | "pending" | "ready" };
  handoff?: (managementAction: ReactNode) => ReactNode;
  name: string;
  provider?: ImProvider;
}) {
  const finishAction =
    completion || action ? (
      <CompletionAction completion={completion} action={action} secondary={Boolean(handoff)} />
    ) : null;

  return (
    <section className="otv2-completion" data-ui="onboarding-v2-step-done">
      <header className={HEADER}>
        <Text as="h1" headingSize="page" variant="heading">
          {m.onboarding_v2_done_title({ name })}
        </Text>
      </header>
      {handoff ? (
        handoff(finishAction)
      ) : (
        <div className="otv2-completion__body">
          <div className="otv2-completion__identity">
            <span className="otv2-completion__mark" aria-hidden="true">
              {provider ? <ProviderIcon className="size-6" provider={provider} /> : <Icon name="check" />}
            </span>
            <strong className="otv2-completion__name">{provider ? messagingProviderLabel(provider) : name}</strong>
            <StatusIndicator label={m.im_connected()} tone="success" />
          </div>
          {finishAction ? (
            <fieldset className="otv2-completion__actions" aria-label={m.onboarding_v2_completion_actions()}>
              {finishAction}
            </fieldset>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CompletionAction({
  completion,
  action,
  secondary,
}: {
  completion?: { onFinish: () => void; state: "failed" | "pending" | "ready" };
  action?: { label: string; onClick: () => void };
  secondary: boolean;
}) {
  if (!completion)
    return action ? (
      <Button variant={secondary ? "ghost" : "primary"} onClick={action.onClick}>
        {action.label}
      </Button>
    ) : null;
  return (
    <Button disabled={completion.state === "pending"} onClick={completion.onFinish}>
      {completion.state === "ready"
        ? m.onboarding_v2_done_finish_reboard()
        : completion.state === "pending"
          ? m.onboarding_v2_done_finishing()
          : m.onboarding_v2_done_retry_finish()}
    </Button>
  );
}
