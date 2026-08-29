import { toString as qrToString } from "qrcode";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button, Icon, KumoInputControl, StatusIndicator, Text } from "../ui/design-system.js";
import type { PlanSignIn } from "./backend.js";
import { ADD_TO_SLACK_URL, BrandMark } from "./brand-mark.js";
import { CommandBlock } from "./command-block.js";
import {
  CHECK_COPY,
  CLOUD_RUNTIME_COPY,
  COMING_SOON,
  COPY,
  DESTINATION_COPY,
  RUNTIME_COPY,
  STEP_LABELS,
  TOKEN_COPY,
} from "./copy.js";
import {
  type AgentDraft,
  type CheckRow,
  CLOUD_RUNTIMES,
  type CloudComputerState,
  type ConnectState,
  type CreationState,
  DEFAULT_AGENT_NAME,
  type Destination,
  deriveChecks,
  draftIsSubmittable,
  type FlowState,
  formatRemaining,
  MESSAGING_PROVIDERS,
  type MessagingProvider,
  type MessagingState,
  messagingCliCheck,
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
const CHOICE_GRID = "grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 m-0 p-0 list-none";
const CARD =
  "otv2-choice flex w-full items-center gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";
const WAITING = "flex items-center gap-2 text-sm text-kumo-subtle m-0";
const PANEL = "flex flex-col items-center gap-3 text-sm text-center";

export function StepRail({ steps }: { steps: FlowState["steps"] }) {
  return (
    <nav aria-label="Setup progress" className="w-full" data-ui="onboarding-v2-rail">
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
            <span data-ui="onboarding-v2-rail-label">{STEP_LABELS[step.id]}</span>
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
  label = COPY.nav.next,
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
            <span>{COPY.nav.back}</span>
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
          {COPY.destination.title}
        </Text>
      </header>
      <ul className={CHOICES}>
        {destinations.map((destination) => {
          const copy = DESTINATION_COPY[destination.id];
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
                  badge={destination.enabled ? undefined : COMING_SOON}
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
  const hintId = `${nameId}-hint`;
  const errorId = `${nameId}-error`;
  const error = showError ? validateAgentName(draft.name) : undefined;
  const errorText =
    error === "empty"
      ? COPY.agent.nameEmptyError
      : error === "too-long"
        ? COPY.agent.nameTooLongError
        : error === "charset"
          ? COPY.agent.nameCharsetError
          : undefined;

  return (
    <div className={FIELDSET} data-ui="onboarding-v2-field">
      <label className="font-medium text-kumo-strong" data-ui="onboarding-v2-field-label" htmlFor={nameId}>
        {COPY.agent.nameLabel}
      </label>
      <p className={HINT} data-ui="onboarding-v2-field-hint" id={hintId}>
        {COPY.agent.nameHint}
      </p>
      <KumoInputControl
        aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
        aria-label={COPY.agent.nameLabel}
        aria-invalid={errorText ? true : undefined}
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
        className={`text-sm m-0 min-h-[20px] max-[640px]:min-h-[34px] ${errorText ? "text-kumo-danger" : "text-kumo-subtle"}`}
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
  return <BrandMark brand={runtime} label={RUNTIME_COPY[runtime].title} />;
}

function RuntimePicker({ draft, onChange }: { draft: AgentDraft; onChange: (draft: AgentDraft) => void }) {
  return (
    <fieldset className={FIELDSET}>
      <legend className="font-medium text-kumo-strong">{COPY.agent.runtimeLabel}</legend>
      <p className={HINT} data-ui="onboarding-v2-field-hint">
        {COPY.agent.runtimeHint}
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
              <CardCopy description={RUNTIME_COPY[runtime].description} title={RUNTIME_COPY[runtime].title} />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-kumo-subtle m-0">{COPY.agent.runtimeFootnote}</p>
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
            <BrandMark brand={candidate} label={COPY.messaging[candidate].title} />
            <CardCopy description={COPY.messaging[candidate].description} title={COPY.messaging[candidate].title} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function MessagingConnection({
  messaging,
  onRetry,
  onSlackInstall,
  provider,
  readiness,
}: {
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
  const cliState = provider ? messagingCliCheck(readiness, provider) : "pending";
  return (
    <div className="flex flex-col items-center gap-3">
      {provider && cliState === "failed" ? (
        <p className="flex items-start gap-2 text-sm text-kumo-warning m-0">
          <Icon className="shrink-0 mt-1" name="close" />
          <span>{COPY.messaging.cliMissing(COPY.messaging[provider].title)}</span>
        </p>
      ) : null}
      {provider === "feishu" ? (
        <div className={PANEL}>
          <p className="text-kumo-subtle m-0">{COPY.messaging.feishuIntro}</p>
          <div className="flex size-[208px] items-center justify-center rounded-xl bg-kumo-base ring ring-kumo-line">
            {messaging.kind === "waiting" ? <QrCode value={messaging.qrValue} /> : null}
          </div>
          {/*
            A refused code is not retried on sight, so this is the only way back to one. Saying
            "Waiting for you to scan…" over an empty box would be untrue: nothing is waiting.
          */}
          {messaging.kind === "failed" ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-kumo-danger m-0">{COPY.messaging.failed}</p>
              <Button onClick={() => onRetry(provider)} variant="secondary">
                {COPY.messaging.retry}
              </Button>
            </div>
          ) : (
            <p className={WAITING} role="status">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-brand animate-pulse" />
              {COPY.messaging.waiting}
            </p>
          )}
        </div>
      ) : provider === "slack" ? (
        <div className={PANEL}>
          <p className="text-kumo-subtle m-0">{COPY.messaging.slackIntro}</p>
          {/*
            Installing is a link out: the user finishes in Slack and comes back. So the waiting
            state here is about a page they are not on, not something to watch on this one.
          */}
          <div className="flex items-center justify-center min-h-[40px]">
            {messaging.kind === "away" ? (
              <p className={WAITING} role="status">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-brand animate-pulse" />
                {COPY.messaging.slackWaiting}
              </p>
            ) : (
              /*
               * Slack's published install button, referenced from the URL Slack's own documentation
               * embeds rather than copied into this repository. Used unmodified, as their brand
               * guidelines require, and nothing of theirs is redistributed here.
               */
              <Button className="h-10 bg-transparent p-0 cursor-pointer" onClick={onSlackInstall} variant="ghost">
                <img alt={COPY.messaging.slackAction} src={ADD_TO_SLACK_URL} />
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
          {COPY.agent.title}
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
  const runtimeLabel = draft.cloudRuntime ? CLOUD_RUNTIME_COPY[draft.cloudRuntime].title : "";
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
          {COPY.cloud.title}
        </Text>
      </header>
      <form className="flex flex-col gap-6" onSubmit={submit}>
        <AgentNameField draft={draft} onBlur={() => setTouched(true)} onChange={onChange} showError={touched} />

        <fieldset className={FIELDSET}>
          <legend className="font-medium text-kumo-strong">{COPY.cloud.runtimeLabel}</legend>
          <p className={HINT} data-ui="onboarding-v2-field-hint">
            {COPY.cloud.runtimeHint}
          </p>
          {/* OpenTag's own agent leads on its own row; the coding agents follow beside each other. */}
          <ul className={CHOICE_GRID} data-ui="onboarding-v2-choices">
            {CLOUD_RUNTIMES.map((runtime, index) => (
              <li
                className={index === 0 ? "col-span-full" : undefined}
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
                  <BrandMark brand={runtime} label={CLOUD_RUNTIME_COPY[runtime].title} />
                  <CardCopy
                    description={CLOUD_RUNTIME_COPY[runtime].description}
                    title={CLOUD_RUNTIME_COPY[runtime].title}
                  />
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-kumo-subtle m-0">{COPY.cloud.runtimeFootnote}</p>
        </fieldset>

        {draft.cloudRuntime === undefined ? null : (
          <fieldset className={FIELDSET}>
            <legend className="font-medium text-kumo-strong">{COPY.cloud.tokenLabel}</legend>
            <p className={HINT} data-ui="onboarding-v2-field-hint">
              {COPY.cloud.tokenHint}
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
                      <CardCopy description={TOKEN_COPY[source].description} title={TOKEN_COPY[source].title} />
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
              ? COPY.cloud.allocating
              : creation === "creating"
                ? COPY.check.creating
                : COPY.nav.next
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
        {COPY.cloud.signInTitle(runtimeLabel)}
      </Text>
      <p className="text-sm text-kumo-subtle m-0">{COPY.cloud.signInHint(runtimeLabel)}</p>
      <div className="flex items-start min-h-[40px]">
        {signIn === "signed-in" ? (
          <StatusIndicator label={COPY.cloud.signInDone(runtimeLabel)} tone="success" />
        ) : signIn === "pending" ? (
          <p className={WAITING} role="status">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-brand animate-pulse" />
            {COPY.cloud.signInPending}
          </p>
        ) : (
          <Button onClick={onSignIn}>{COPY.cloud.signInAction(runtimeLabel)}</Button>
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
  connect,
  creation,
  draft,
  onBack,
  onCreate,
  onRefreshCommand,
  readiness,
}: {
  connect: ConnectState;
  creation: CreationState;
  draft: AgentDraft;
  onBack?: () => void;
  onCreate: () => void;
  onRefreshCommand: () => void;
  readiness: ReadinessFacts | undefined;
}) {
  const connected = connect.kind === "connected";
  const checks = deriveChecks(readiness);
  const runtimeLabel = draft.runtime ? RUNTIME_COPY[draft.runtime].title : "";
  const resolving = readinessIsResolving(readiness);
  // Asked about the runtime this draft chose, so a verdict left over from a different one
  // cannot open the gate while the next poll is still in flight.
  const passed = readinessPassed(readiness, draft.runtime);
  const failures = checks.filter((check) => check.state === "failed");

  return (
    <section className={STEP} data-ui="onboarding-v2-step-computer">
      <header className={HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {COPY.connect.title}
        </Text>
        <p className="text-kumo-subtle m-0">{COPY.connect.lead}</p>
        <p className="flex items-start gap-2 text-sm text-kumo-subtle m-0">
          <Icon className="shrink-0 mt-1 text-kumo-brand" name="shield" />
          {COPY.connect.privacy}
        </p>
      </header>

      {connected ? null : (
        <div className="flex flex-col gap-3">
          {/*
            The instruction and the validity read as one line: the command is what the reader is
            about to run, and how long it lasts belongs to it rather than to a note underneath.
          */}
          <div
            className="flex items-center justify-between gap-3 max-[640px]:flex-col max-[640px]:items-start max-[640px]:min-h-[68px]"
            data-ui="onboarding-v2-command-lead"
          >
            <p className="text-sm text-kumo-subtle m-0">{COPY.connect.commandIntro}</p>
            <span className="text-sm text-kumo-subtle shrink-0" data-ui="onboarding-v2-expiry">
              {connect.kind === "issued" ? <Countdown expiresAt={connect.expiresAt} /> : null}
            </span>
          </div>
          <ConnectCommand connect={connect} onRefreshCommand={onRefreshCommand} />
        </div>
      )}

      <ConnectStatus connect={connect} />

      {connected ? (
        <>
          <ol className="flex flex-col m-0 p-0 list-none rounded-xl bg-kumo-base ring ring-kumo-line overflow-hidden">
            {checks.map((check, index) => (
              <CheckLine check={check} key={check.id} position={index + 1} runtimeLabel={runtimeLabel} />
            ))}
          </ol>
          <div
            className="flex flex-col justify-start min-h-[50px] max-[640px]:min-h-[71px] max-[359px]:min-h-[114px]"
            data-ui="onboarding-v2-check-outcome"
          >
            {resolving ? (
              <p className={WAITING} role="status">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-brand animate-pulse" />
                {COPY.check.waiting}
              </p>
            ) : failures.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-kumo-strong m-0">{COPY.check.failedIntro(failures.length)}</p>
                <p className="text-sm text-kumo-subtle m-0">
                  {COPY.check.repairHint} <code>{COPY.check.repairCommand}</code> {COPY.check.repairHintSuffix}
                </p>
              </div>
            ) : (
              <StatusIndicator label={COPY.check.passed} tone="success" />
            )}
          </div>
        </>
      ) : null}

      <StepNav
        back={onBack}
        disabled={!connected || !passed || creation !== "idle"}
        label={creation === "creating" ? COPY.check.creating : COPY.nav.next}
        onNext={onCreate}
      />
    </section>
  );
}

function ConnectCommand({ connect, onRefreshCommand }: { connect: ConnectState; onRefreshCommand: () => void }) {
  // Before a command exists, the block still renders — same structure, same length, so nothing
  // moves when the real one lands. It is inert: nothing to copy and nothing to announce.
  if (connect.kind === "idle" || connect.kind === "issuing") {
    return (
      <div aria-hidden="true" className="otv2-command-pending">
        <CommandBlock
          command={PLACEHOLDER_CONNECT_COMMAND}
          comment={COPY.connect.commandComment}
          copiedLabel={COPY.connect.copied}
          copyLabel={COPY.connect.copy}
          fallbackHint={COPY.connect.copyFallback}
          inert
        />
      </div>
    );
  }
  return (
    <CommandBlock
      command={connect.command}
      comment={COPY.connect.commandComment}
      copiedLabel={COPY.connect.copied}
      copyLabel={COPY.connect.copy}
      expiredNotice={
        connect.kind === "expired" ? (
          <>
            <span>{COPY.connect.expired}</span>
            <Button onClick={onRefreshCommand} variant="inline">
              {COPY.connect.refresh}
            </Button>
          </>
        ) : undefined
      }
      fallbackHint={COPY.connect.copyFallback}
      key={connect.command}
    />
  );
}

function ConnectStatus({ connect }: { connect: ConnectState }) {
  return (
    <div className="flex flex-col justify-center min-h-[28px]" data-ui="onboarding-v2-connect-status">
      {connect.kind === "connected" ? (
        <StatusIndicator label={COPY.connect.connected} tone="success" />
      ) : (
        <p className={WAITING} role="status">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-brand animate-pulse" />
          {COPY.connect.waiting}
        </p>
      )}
    </div>
  );
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  return <span>{COPY.connect.expiresIn(formatRemaining(useRemaining(expiresAt)))}</span>;
}

/** Ticks once a second and settles at zero, so an expired code never shows a negative duration. */
function useRemaining(expiresAt: number): number {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    setRemaining(Math.max(0, expiresAt - Date.now()));
    const id = window.setInterval(() => {
      const next = Math.max(0, expiresAt - Date.now());
      setRemaining(next);
      if (next === 0) window.clearInterval(id);
    }, 1_000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return remaining;
}

function CheckLine({ check, position, runtimeLabel }: { check: CheckRow; position: number; runtimeLabel: string }) {
  const copy = CHECK_COPY[check.id];
  // Always rendered, even when empty, so a resolving check never changes the row's height.
  const detail = copy.detail[check.state](runtimeLabel);
  const dim = check.state === "blocked" || check.state === "pending";
  return (
    <li
      className="otv2-check flex items-center gap-3 p-4 border-t border-kumo-line first:border-t-0 min-h-[73px] max-[399px]:min-h-[90px]"
      data-state={check.state}
    >
      <span
        aria-hidden="true"
        className="otv2-check__marker inline-flex shrink-0 items-center justify-center rounded-full text-xs text-kumo-subtle"
      >
        {position}
      </span>
      <span className="flex flex-col gap-1 min-w-0">
        <span className={dim ? "text-kumo-subtle" : "font-medium text-kumo-strong"}>{copy.title(runtimeLabel)}</span>
        <span className="text-xs text-kumo-subtle">{detail || " "}</span>
      </span>
    </li>
  );
}

export function MessagingStep({
  messaging,
  onChoose,
  onSlackInstall,
  onStart,
  provider,
  readiness,
}: {
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
          {COPY.messaging.title}
        </Text>
        <p className="text-kumo-subtle m-0">{COPY.messaging.description}</p>
      </header>

      <MessagingPicker onChoose={onChoose} provider={provider} />
      <MessagingConnection
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

function QrCode({ value }: { value: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let active = true;
    void qrToString(value, { margin: 1, type: "svg", width: 208 }).then(
      (svg) => {
        if (active) setSource(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [value]);
  return source ? <img alt={COPY.messaging.qrAlt} className="size-full" src={source} /> : null;
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
          {COPY.done.title(name)}
        </Text>
        <p className="text-kumo-subtle m-0">{COPY.done.description(name)}</p>
      </header>
    </section>
  );
}
