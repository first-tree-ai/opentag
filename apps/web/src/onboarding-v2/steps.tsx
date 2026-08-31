import { type FormEvent, useEffect, useId, useState } from "react";
import * as m from "../paraglide/messages.js";
import {
  CheckLine,
  CommandBlock,
  ConnectStatus,
  Countdown,
  deriveChecks,
  messagingCliCheck,
  QrCode,
  WAITING_LINE,
} from "../setup/index.js";
import { Button, Icon, KumoInputControl, StatusIndicator, Text } from "../ui/design-system.js";
import type { KnownComputer, PlanSignIn } from "./backend.js";
import { ADD_TO_SLACK_URL, BrandMark } from "./brand-mark.js";
import {
  type AgentDraft,
  CLOUD_RUNTIMES,
  type CloudComputerState,
  type ConnectState,
  type CreationState,
  DEFAULT_AGENT_NAME,
  type Destination,
  draftIsSubmittable,
  type FlowState,
  MESSAGING_PROVIDERS,
  type MessagingProvider,
  type MessagingState,
  needsPlanSignIn,
  type ReadinessFacts,
  RUNTIMES,
  type Runtime,
  readinessIsResolving,
  readinessPassed,
  TOKEN_SOURCES,
  tokenChoiceApplies,
  validateAgentName,
} from "./flow.js";
import { PLACEHOLDER_CONNECT_COMMAND } from "./mock-backend.js";

/** One step's worth of vertical rhythm. Every gap on every step is one of 4, 12 or 24px. */
const STEP = "flex flex-col gap-6";
const HEADER = "flex flex-col gap-1";
const FIELDSET = "flex flex-col gap-1 m-0 p-0 border-0";
const HINT = "text-sm text-kumo-subtle m-0";
const CHOICES = "flex flex-col gap-3 m-0 p-0 list-none";
const CHOICE_GRID = "otv2-choices--grid grid gap-3 m-0 p-0 list-none";
const CARD =
  "otv2-choice flex w-full items-center gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";
const PANEL = "flex flex-col items-center gap-3 text-sm text-center";

export function StepRail({ steps }: { steps: FlowState["steps"] }) {
  return (
    <nav aria-label={m.onboarding_v2_setup_progress()} className="w-full" data-ui="onboarding-v2-rail">
      <ol className="flex gap-2 m-0 p-0 list-none">
        {steps.map((step, index) => (
          <li
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
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The footer every step shares: Go back on the left, Continue on the right, in the same place on
 * every page. Continue is always rendered and simply disabled until the step's condition is met,
 * so the way forward never appears or disappears under the reader. Steps the system advances by
 * itself keep it too: it enables the moment they could move on, which lets an impatient reader
 * skip the pause rather than wait it out.
 */
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

/** A card's copy: the title it is chosen by, and the line that explains it. */
function CardCopy({ badge, description, title }: { badge?: string; description: string; title: string }) {
  return (
    <span className="flex flex-col gap-1 min-w-0">
      <span className="flex items-center gap-2 font-medium text-kumo-strong" data-ui="onboarding-v2-card-title">
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
                <Icon className="size-10 shrink-0 text-kumo-brand" name={destination.icon} />
                <CardCopy
                  badge={destination.enabled ? undefined : m.onboarding_v2_coming_soon()}
                  description={copy.description}
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

/** The name field: label, the line explaining it, the input, and an error line that always exists. */
function AgentNameField({
  draft,
  locked = false,
  lockedNote,
  onBlur,
  onChange,
  showError,
}: {
  draft: AgentDraft;
  locked?: boolean;
  lockedNote?: string;
  onBlur: () => void;
  onChange: (draft: AgentDraft) => void;
  showError: boolean;
}) {
  const nameId = useId();
  const labelId = `${nameId}-label`;
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
      <label className="font-medium text-kumo-strong" data-ui="onboarding-v2-field-label" htmlFor={nameId} id={labelId}>
        {m.onboarding_v2_agent_name_label()}
      </label>
      <p className={HINT} data-ui="onboarding-v2-field-hint" id={hintId}>
        {m.onboarding_v2_agent_name_hint()}
      </p>
      <KumoInputControl
        aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
        aria-invalid={errorText ? true : undefined}
        aria-labelledby={labelId}
        autoComplete="off"
        data-ui="onboarding-v2-field-control"
        id={nameId}
        onBlur={onBlur}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        placeholder={DEFAULT_AGENT_NAME}
        readOnly={locked}
        spellCheck={false}
        value={draft.name}
      />
      {/*
        The line is always here, whether or not it says anything: an error that appears would
        otherwise push the runtime choice below it down as someone types.
      */}
      <p
        aria-live="polite"
        className={`otv2-field-error text-sm m-0 ${errorText ? "text-kumo-danger" : "text-kumo-subtle"}`}
        data-ui="onboarding-v2-field-error"
        data-empty={errorText || locked ? undefined : "true"}
        data-note={!errorText && locked ? "true" : undefined}
        id={errorId}
      >
        {errorText ?? (locked ? lockedNote : undefined) ?? " "}
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
      <p className={HINT} data-ui="onboarding-v2-field-hint">
        {m.onboarding_v2_agent_runtime_hint()}
      </p>
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

function MessagingPicker({
  onChoose,
  provider,
}: {
  onChoose: (provider: MessagingProvider) => void;
  provider: MessagingProvider | undefined;
}) {
  return (
    <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
      {MESSAGING_PROVIDERS.map((candidate) => (
        <li key={candidate}>
          <Button
            aria-pressed={provider === candidate}
            className={CARD}
            onClick={() => onChoose(candidate)}
            variant="ghost"
          >
            <BrandMark
              brand={candidate}
              label={
                candidate === "feishu"
                  ? m.onboarding_v2_messaging_lark_title()
                  : m.onboarding_v2_messaging_slack_title()
              }
            />
            <CardCopy
              description={
                candidate === "feishu"
                  ? m.onboarding_v2_messaging_lark_description()
                  : m.onboarding_v2_messaging_slack_description()
              }
              title={
                candidate === "feishu"
                  ? m.onboarding_v2_messaging_lark_title()
                  : m.onboarding_v2_messaging_slack_title()
              }
            />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function MessagingConnection({
  computerOnline,
  messaging,
  onRetry,
  onSlackInstall,
  provider,
  readiness,
}: {
  computerOnline: boolean | undefined;
  messaging: MessagingState;
  onRetry: (provider: MessagingProvider) => void;
  onSlackInstall: () => void;
  provider: MessagingProvider | undefined;
  readiness: ReadinessFacts | undefined;
}) {
  /*
   * The CLI that delivers messages is checked here, not on the computer step: which one is needed
   * depends on the provider, and until this point there was no provider. A missing one used to
   * block creating the Agent at all, which stopped a Slack user over a Lark dependency.
   */
  const cliState = provider ? messagingCliCheck(readiness?.messagingCli[provider]) : "pending";
  /*
   * Reachability needs more than the binding, and the Server's handoff status carries no reason —
   * so a wait on one of its other conditions would otherwise be an unexplained spinner.
   *
   * Two of them can be named here. The third, an unready runtime, cannot: losing it fails the
   * check this step was reached through, so the flow returns to the connect step, where the check
   * rows say which line failed. That is a better answer than a sentence, and it is why there is no
   * copy for it.
   */
  const waitingReason =
    computerOnline === false
      ? m.onboarding_v2_messaging_computer_offline()
      : cliState === "failed" && provider
        ? m.onboarding_v2_messaging_cli_missing({
            provider:
              provider === "feishu" ? m.onboarding_v2_messaging_lark_title() : m.onboarding_v2_messaging_slack_title(),
          })
        : undefined;
  return (
    <div className="flex flex-col items-center gap-3">
      {/*
        Said once. While reachability is being waited on, the wait itself carries this reason, and
        the same sentence standing twice on one screen reads as two different problems.
      */}
      {provider && cliState === "failed" && messaging.kind !== "waiting-handoff" ? (
        <p className="flex items-start gap-2 text-sm text-kumo-warning m-0">
          <Icon className="shrink-0 mt-1" name="close" />
          <span>
            {m.onboarding_v2_messaging_cli_missing({
              provider:
                provider === "feishu"
                  ? m.onboarding_v2_messaging_lark_title()
                  : m.onboarding_v2_messaging_slack_title(),
            })}
          </span>
        </p>
      ) : null}
      {provider === "feishu" ? (
        <div className={PANEL}>
          <p className="text-kumo-subtle m-0">{m.onboarding_v2_messaging_lark_intro()}</p>
          <div className="ots-qr flex items-center justify-center rounded-xl bg-kumo-base ring ring-kumo-line">
            {messaging.kind === "waiting" ? <QrCode value={messaging.qrValue} /> : null}
          </div>
          {/*
            A refused code is not retried on sight, so this is the only way back to one. Saying
            "Waiting for you to scan…" over an empty box would be untrue: nothing is waiting.
          */}
          {messaging.kind === "waiting-handoff" ? (
            waitingReason ? (
              <p className="flex items-start gap-2 text-sm text-kumo-warning m-0" role="status">
                <Icon className="shrink-0 mt-1" name="close" />
                <span>{waitingReason}</span>
              </p>
            ) : (
              <p className={WAITING_LINE} role="status">
                <span aria-hidden="true" className="ots-pulse shrink-0" />
                {m.onboarding_v2_messaging_confirming()}
              </p>
            )
          ) : messaging.kind === "failed" ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-kumo-danger m-0">{m.onboarding_v2_messaging_failed()}</p>
              <Button onClick={() => onRetry(provider)} variant="secondary">
                {m.onboarding_v2_messaging_retry()}
              </Button>
            </div>
          ) : (
            <p className={WAITING_LINE} role="status">
              <span aria-hidden="true" className="ots-pulse shrink-0" />
              {m.onboarding_v2_messaging_waiting()}
            </p>
          )}
        </div>
      ) : provider === "slack" ? (
        <div className={PANEL}>
          <p className="text-kumo-subtle m-0">{m.onboarding_v2_messaging_slack_intro()}</p>
          {/*
            Installing is a link out: the user finishes in Slack and comes back. So the waiting
            state here is about a page they are not on, not something to watch on this one.
          */}
          <div className="otv2-slot--signin flex items-center justify-center">
            {messaging.kind === "waiting-handoff" ? (
              waitingReason ? (
                <p className="flex items-start gap-2 text-sm text-kumo-warning m-0" role="status">
                  <Icon className="shrink-0 mt-1" name="close" />
                  <span>{waitingReason}</span>
                </p>
              ) : (
                <p className={WAITING_LINE} role="status">
                  <span aria-hidden="true" className="ots-pulse shrink-0" />
                  {m.onboarding_v2_messaging_confirming()}
                </p>
              )
            ) : messaging.kind === "away" ? (
              <p className={WAITING_LINE} role="status">
                <span aria-hidden="true" className="ots-pulse shrink-0" />
                {m.onboarding_v2_messaging_slack_waiting()}
              </p>
            ) : (
              /*
               * Slack's published install button, referenced from the URL Slack's own documentation
               * embeds rather than copied into this repository. Used unmodified, as their brand
               * guidelines require, and nothing of theirs is redistributed here.
               */
              <Button
                className="otv2-slack-install bg-transparent p-0 cursor-pointer"
                onClick={onSlackInstall}
                variant="ghost"
              >
                <img alt={m.onboarding_v2_messaging_slack_action()} src={ADD_TO_SLACK_URL} />
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentStep({
  draft,
  onBack,
  onChange,
  onSubmit,
}: {
  draft: AgentDraft;
  onBack?: () => void;
  onChange: (draft: AgentDraft) => void;
  onSubmit: () => void;
}) {
  // Errors are held back until the field is left, so a name is never called invalid mid-typing.
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
        {/*
          Continue is held only while a *choice* is outstanding. An invalid name leaves it
          pressable on purpose: pressing it is how the reason gets explained, and a dead button
          that says nothing is worse than one that answers.
        */}
        <StepNav back={onBack} disabled={draft.runtime === undefined} submit />
      </form>
    </section>
  );
}

/**
 * The cloud route's first step: who the agent is, what it runs on, and who pays for it. Connecting
 * a messaging app follows on its own step, as it does for a local agent.
 */
export function CloudStep({
  cloudComputer,
  creation,
  draft,
  onBack,
  onChange,
  onSignIn,
  onSubmit,
  signIn,
}: {
  cloudComputer: CloudComputerState;
  creation: CreationState;
  draft: AgentDraft;
  onBack?: () => void;
  onChange: (draft: AgentDraft) => void;
  onSignIn: () => void;
  onSubmit: () => void;
  signIn: PlanSignIn;
}) {
  const [touched, setTouched] = useState(false);
  const runtimeLabel = draft.cloudRuntime
    ? draft.cloudRuntime === "opentag"
      ? m.onboarding_v2_cloud_runtime_opentag_title()
      : draft.cloudRuntime === "codex"
        ? m.onboarding_v2_runtime_codex_title()
        : m.onboarding_v2_runtime_claude_code_title()
    : "";
  const signedIn = signIn === "signed-in";
  const submittable = draftIsSubmittable(draft, signedIn);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (submittable) onSubmit();
  }

  return (
    <section className={STEP} data-ui="onboarding-v2-step-cloud">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_cloud_title()}
        </Text>
      </header>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <AgentNameField draft={draft} onBlur={() => setTouched(true)} onChange={onChange} showError={touched} />

        <fieldset className={FIELDSET}>
          <legend className="font-medium text-kumo-strong">{m.onboarding_v2_cloud_runtime_label()}</legend>
          <p className={HINT} data-ui="onboarding-v2-field-hint">
            {m.onboarding_v2_cloud_runtime_hint()}
          </p>
          {/* OpenTag's own agent leads on its own row; the coding agents follow beside each other. */}
          <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
            {CLOUD_RUNTIMES.map((runtime, index) => (
              <li
                className={index === 0 ? "otv2-lead" : undefined}
                data-lead={index === 0 ? "true" : undefined}
                key={runtime}
              >
                <Button
                  aria-pressed={draft.cloudRuntime === runtime}
                  className={CARD}
                  onClick={() =>
                    onChange({
                      ...draft,
                      cloudRuntime: runtime,
                      // The OpenTag agent can only spend OpenTag's tokens, so that answer comes
                      // with the choice; any other runtime starts the question over.
                      tokenSource: runtime === "opentag" ? "opentag" : undefined,
                    })
                  }
                  variant="ghost"
                >
                  <BrandMark
                    brand={runtime}
                    label={
                      runtime === "opentag"
                        ? m.onboarding_v2_cloud_runtime_opentag_title()
                        : runtime === "codex"
                          ? m.onboarding_v2_runtime_codex_title()
                          : m.onboarding_v2_runtime_claude_code_title()
                    }
                  />
                  <CardCopy
                    description={
                      runtime === "opentag"
                        ? m.onboarding_v2_cloud_runtime_opentag_description()
                        : runtime === "codex"
                          ? m.onboarding_v2_runtime_codex_description()
                          : m.onboarding_v2_runtime_claude_code_description()
                    }
                    title={
                      runtime === "opentag"
                        ? m.onboarding_v2_cloud_runtime_opentag_title()
                        : runtime === "codex"
                          ? m.onboarding_v2_runtime_codex_title()
                          : m.onboarding_v2_runtime_claude_code_title()
                    }
                  />
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-kumo-subtle m-0">{m.onboarding_v2_cloud_runtime_footnote()}</p>
        </fieldset>

        {draft.cloudRuntime === undefined ? null : (
          <fieldset className={FIELDSET}>
            <legend className="font-medium text-kumo-strong">{m.onboarding_v2_cloud_token_label()}</legend>
            <p className={HINT} data-ui="onboarding-v2-field-hint">
              {m.onboarding_v2_cloud_token_hint()}
            </p>
            <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
              {TOKEN_SOURCES.map((source) => {
                /*
                 * Both options are always listed, so the choice that exists elsewhere is visible
                 * here too. Against the OpenTag agent there is no subscription of the user's to
                 * attach, so its own tokens are already chosen and the other cannot be picked.
                 */
                const available = source === "opentag" || tokenChoiceApplies(draft.cloudRuntime);
                return (
                  <li key={source}>
                    <Button
                      aria-pressed={draft.tokenSource === source}
                      className={CARD}
                      disabled={!available}
                      onClick={() => onChange({ ...draft, tokenSource: source })}
                      variant="ghost"
                    >
                      <CardCopy
                        description={
                          source === "opentag"
                            ? m.onboarding_v2_token_opentag_description()
                            : m.onboarding_v2_token_own_plan_description()
                        }
                        title={
                          source === "opentag"
                            ? m.onboarding_v2_token_opentag_title()
                            : m.onboarding_v2_token_own_plan_title()
                        }
                      />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {needsPlanSignIn(draft) ? (
          <PlanSignInPanel onSignIn={onSignIn} runtimeLabel={runtimeLabel} signIn={signIn} />
        ) : null}

        <StepNav
          back={onBack}
          disabled={!submittable || cloudComputer !== "idle"}
          label={
            cloudComputer === "allocating"
              ? m.onboarding_v2_cloud_allocating()
              : creation === "creating"
                ? m.onboarding_v2_check_creating()
                : m.onboarding_v2_nav_next()
          }
          submit
        />
      </form>
    </section>
  );
}

/** The user's own plan has to be signed into before an agent can spend it. */
function PlanSignInPanel({
  onSignIn,
  runtimeLabel,
  signIn,
}: {
  onSignIn: () => void;
  runtimeLabel: string;
  signIn: PlanSignIn;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-kumo-base p-4 ring ring-kumo-line">
      <Text as="h2" variant="heading">
        {m.onboarding_v2_cloud_sign_in_title({ runtime: runtimeLabel })}
      </Text>
      <p className="text-sm text-kumo-subtle m-0">{m.onboarding_v2_cloud_sign_in_hint({ runtime: runtimeLabel })}</p>
      <div className="otv2-slot--signin flex items-start">
        {signIn === "signed-in" ? (
          <StatusIndicator label={m.onboarding_v2_cloud_sign_in_done({ runtime: runtimeLabel })} tone="success" />
        ) : signIn === "pending" ? (
          <p className={WAITING_LINE} role="status">
            <span aria-hidden="true" className="ots-pulse shrink-0" />
            {m.onboarding_v2_cloud_sign_in_pending()}
          </p>
        ) : (
          <Button onClick={onSignIn}>{m.onboarding_v2_cloud_sign_in_action({ runtime: runtimeLabel })}</Button>
        )}
      </div>
    </div>
  );
}

/**
 * Connecting the Computer and reporting what is on it, on one page. The check settles within about
 * a hundred milliseconds of the Computer arriving, so splitting them would put a screen change in
 * front of a result that is already there.
 */
export function ComputerStep({
  computer,
  connect,
  creation,
  draft,
  onBack,
  onCreate,
  onRefreshCommand,
  readiness,
}: {
  /** The Computer the Account has, when it has one. An Account has one machine, never a list. */
  computer?: KnownComputer | undefined;
  connect: ConnectState;
  creation: CreationState;
  draft: AgentDraft;
  onBack?: () => void;
  onCreate: () => void;
  onRefreshCommand: () => void;
  readiness: ReadinessFacts | undefined;
}) {
  const connected = connect.kind === "connected";
  /*
   * The Computer this step is preparing, and so the one the check below answers for: the machine
   * the Account already has once it is reachable, or a new arrival. The backend probes this same
   * subject, so what is on screen is never a verdict about some other machine.
   */
  const ready = computer ? computer.online : connected;
  /*
   * The command enrols a machine, so it belongs to a run that has none. Beside a machine the
   * Account already has — an offline one most of all — it would offer a second Computer as the way
   * to repair the first, which is the duplicate this step exists to avoid.
   */
  const connectingNew = computer === undefined;
  const checks = deriveChecks(readiness?.runtime);
  const runtimeLabel = draft.runtime
    ? draft.runtime === "codex"
      ? m.onboarding_v2_runtime_codex_title()
      : m.onboarding_v2_runtime_claude_code_title()
    : "";
  const resolving = readinessIsResolving(readiness);
  // Asked about the runtime this draft chose, so a verdict left over from a different one
  // cannot open the gate while the next poll is still in flight.
  const passed = readinessPassed(readiness, draft.runtime);
  const failures = checks.filter((check) => check.state === "failed");

  return (
    <section className={STEP} data-ui="onboarding-v2-step-computer">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {computer ? m.onboarding_v2_connect_yours_title() : m.onboarding_v2_connect_title()}
        </Text>
        <p className="text-kumo-subtle m-0">
          {computer ? m.onboarding_v2_connect_yours_lead() : m.onboarding_v2_connect_lead()}
        </p>
        <p className="flex items-start gap-2 text-sm text-kumo-subtle m-0">
          <Icon className="shrink-0 mt-1 text-kumo-brand" name="shield" />
          {m.onboarding_v2_connect_privacy()}
        </p>
      </header>

      {/* Which machine this is, said once. There is nothing here to operate: it is not a choice. */}
      {computer ? (
        <p className="flex items-center gap-2 m-0" data-ui="onboarding-v2-computer">
          <Icon className="shrink-0 text-kumo-brand" name="laptop" />
          <span className="font-medium text-kumo-strong">{computer.displayName}</span>
          <span className="text-sm text-kumo-subtle">{computerStatus(computer)}</span>
        </p>
      ) : null}

      {computer && !computer.online ? (
        <p className="flex items-start gap-2 text-sm text-kumo-strong m-0" role="status">
          <Icon className="shrink-0 mt-1 text-kumo-warning" name="laptop" />
          {m.onboarding_v2_connect_offline_lead()}
        </p>
      ) : null}

      {connectingNew && !connected ? (
        <div className="flex flex-col gap-3">
          {/*
            The instruction and the validity read as one line: the command is what the reader is
            about to run, and how long it lasts belongs to it rather than to a note underneath.
          */}
          <div
            className="otv2-command-lead flex items-center justify-between gap-3"
            data-ui="onboarding-v2-command-lead"
          >
            <p className="text-sm text-kumo-subtle m-0">{m.onboarding_v2_connect_command_intro()}</p>
            <span className="text-sm text-kumo-subtle shrink-0" data-ui="onboarding-v2-expiry">
              {connect.kind === "issued" ? <Countdown expiresAt={connect.expiresAt} /> : null}
            </span>
          </div>
          <ConnectCommand connect={connect} onRefreshCommand={onRefreshCommand} />
        </div>
      ) : null}

      {/* The Account's machine reports through the check below; the arrival line is for a new one. */}
      {computer ? null : <ConnectStatus connected={connected} dataUi="onboarding-v2-connect-status" />}

      {ready ? (
        <>
          <ol className="flex flex-col m-0 p-0 list-none rounded-xl bg-kumo-base ring ring-kumo-line overflow-hidden">
            {checks.map((check, index) => (
              <CheckLine check={check} key={check.id} position={index + 1} runtimeLabel={runtimeLabel} />
            ))}
          </ol>
          <div className="otv2-slot--outcome flex flex-col justify-start" data-ui="onboarding-v2-check-outcome">
            {resolving ? (
              <p className={WAITING_LINE} role="status">
                <span aria-hidden="true" className="ots-pulse shrink-0" />
                {m.onboarding_v2_check_waiting()}
              </p>
            ) : failures.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-kumo-strong m-0">
                  {failures.length > 1
                    ? m.onboarding_v2_check_failed_many({ count: failures.length })
                    : m.onboarding_v2_check_failed_one()}
                </p>
                <p className="text-sm text-kumo-subtle m-0">
                  {m.onboarding_v2_check_repair_hint()} <code>opentag doctor --fix</code>{" "}
                  {m.onboarding_v2_check_repair_hint_suffix()}
                </p>
              </div>
            ) : (
              <StatusIndicator label={m.onboarding_v2_check_passed()} tone="success" />
            )}
          </div>
        </>
      ) : null}

      <StepNav
        back={onBack}
        disabled={!ready || !passed || creation !== "idle"}
        label={creation === "creating" ? m.onboarding_v2_check_creating() : m.onboarding_v2_nav_next()}
        onNext={onCreate}
      />
    </section>
  );
}

/** Whether the Account's machine can be reached, and when it was last seen if it cannot. */
function computerStatus(computer: KnownComputer): string {
  if (computer.online) return m.onboarding_v2_connect_online();
  if (computer.lastSeen) return m.onboarding_v2_connect_offline_last_seen({ when: computer.lastSeen });
  return m.onboarding_v2_connect_offline();
}

function ConnectCommand({ connect, onRefreshCommand }: { connect: ConnectState; onRefreshCommand: () => void }) {
  // Before a command exists, the block still renders — same structure, same length, so nothing
  // moves when the real one lands. It is inert: nothing to copy and nothing to announce.
  if (connect.kind === "idle" || connect.kind === "issuing") {
    return (
      <div aria-hidden="true" className="ots-command-pending">
        <CommandBlock
          command={PLACEHOLDER_CONNECT_COMMAND}
          comment={m.onboarding_v2_connect_command_comment()}
          copiedLabel={m.onboarding_v2_connect_copied()}
          copyLabel={m.onboarding_v2_connect_copy()}
          fallbackHint={m.onboarding_v2_connect_copy_fallback()}
          inert
        />
      </div>
    );
  }
  return (
    <CommandBlock
      command={connect.command}
      comment={m.onboarding_v2_connect_command_comment()}
      copiedLabel={m.onboarding_v2_connect_copied()}
      copyLabel={m.onboarding_v2_connect_copy()}
      expiredNotice={
        connect.kind === "expired" ? (
          <>
            <span>{m.onboarding_v2_connect_expired()}</span>
            <Button onClick={onRefreshCommand} variant="inline">
              {m.onboarding_v2_connect_refresh()}
            </Button>
          </>
        ) : undefined
      }
      fallbackHint={m.onboarding_v2_connect_copy_fallback()}
      key={connect.command}
    />
  );
}

export function MessagingStep({
  computerOnline,
  messaging,
  onChoose,
  onSlackInstall,
  onStart,
  provider,
  readiness,
}: {
  computerOnline: boolean | undefined;
  messaging: MessagingState;
  onChoose: (provider: MessagingProvider) => void;
  onSlackInstall: () => void;
  onStart: (provider: MessagingProvider) => void;
  provider: MessagingProvider | undefined;
  readiness: ReadinessFacts | undefined;
}) {
  // Lark's code is issued as soon as it is picked; Slack waits for its install to be started.
  useEffect(() => {
    if (provider && messaging.kind === "idle") onStart(provider);
  }, [messaging.kind, onStart, provider]);

  return (
    <section className={STEP} data-ui="onboarding-v2-step-messaging">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_messaging_title()}
        </Text>
        <p className="text-kumo-subtle m-0">{m.onboarding_v2_messaging_description()}</p>
      </header>

      <MessagingPicker onChoose={onChoose} provider={provider} />
      <MessagingConnection
        computerOnline={computerOnline}
        messaging={messaging}
        onRetry={onStart}
        onSlackInstall={onSlackInstall}
        provider={provider}
        readiness={readiness}
      />
      {/*
        No footer here. The Agent already exists, so there is nothing to go back to, and this step
        is finished by scanning a code or installing an App rather than by pressing anything on
        this page — a Continue that can never be pressed is just something in the way.
      */}
    </section>
  );
}

export function DoneStep({ name }: { name: string }) {
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
        <p className="text-kumo-subtle m-0">{m.onboarding_v2_done_description({ name })}</p>
      </header>
    </section>
  );
}
