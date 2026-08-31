import { type FormEvent, useEffect, useId, useState } from "react";
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
import type { PlanSignIn } from "./backend.js";
import { ADD_TO_SLACK_URL, BrandMark } from "./brand-mark.js";
import {
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
    <nav aria-label="Setup progress" className="w-full" data-ui="onboarding-v2-rail">
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
            <span data-ui="onboarding-v2-rail-label">{STEP_LABELS[step.id]}</span>
            {step.status === "complete" ? <span className="sr-only">Completed</span> : null}
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
  const labelId = `${nameId}-label`;
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
      <label className="font-medium text-kumo-strong" data-ui="onboarding-v2-field-label" htmlFor={nameId} id={labelId}>
        {COPY.agent.nameLabel}
      </label>
      <p className={HINT} data-ui="onboarding-v2-field-hint" id={hintId}>
        {COPY.agent.nameHint}
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
      ? COPY.messaging.computerOffline
      : cliState === "failed" && provider
        ? COPY.messaging.cliMissing(COPY.messaging[provider].title)
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
          <span>{COPY.messaging.cliMissing(COPY.messaging[provider].title)}</span>
        </p>
      ) : null}
      {provider === "feishu" ? (
        <div className={PANEL}>
          <p className="text-kumo-subtle m-0">
            {messaging.kind === "waiting" ? COPY.messaging.feishuIntro : COPY.messaging.feishuPreparing}
          </p>
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
                {COPY.messaging.confirming}
              </p>
            )
          ) : messaging.kind === "failed" ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-kumo-danger m-0">{COPY.messaging.failed}</p>
              <Button onClick={() => onRetry(provider)} variant="secondary">
                {COPY.messaging.retry}
              </Button>
            </div>
          ) : messaging.kind === "idle" || messaging.kind === "issuing" ? (
            <p className={WAITING_LINE} role="status">
              <span aria-hidden="true" className="ots-pulse shrink-0" />
              {COPY.messaging.generating}
            </p>
          ) : (
            <p className={WAITING_LINE} role="status">
              <span aria-hidden="true" className="ots-pulse shrink-0" />
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
                  {COPY.messaging.confirming}
                </p>
              )
            ) : messaging.kind === "away" ? (
              <p className={WAITING_LINE} role="status">
                <span aria-hidden="true" className="ots-pulse shrink-0" />
                {COPY.messaging.slackWaiting}
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
      <div className="otv2-slot--signin flex items-start">
        {signIn === "signed-in" ? (
          <StatusIndicator label={COPY.cloud.signInDone(runtimeLabel)} tone="success" />
        ) : signIn === "pending" ? (
          <p className={WAITING_LINE} role="status">
            <span aria-hidden="true" className="ots-pulse shrink-0" />
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
  const checks = deriveChecks(readiness?.runtime);
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
            className="otv2-command-lead flex items-center justify-between gap-3"
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

      <ConnectStatus connected={connected} dataUi="onboarding-v2-connect-status" expired={connect.kind === "expired"} />

      {connected ? (
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
      <div aria-hidden="true" className="ots-command-pending">
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
          {COPY.messaging.title}
        </Text>
        <p className="text-kumo-subtle m-0">{COPY.messaging.description}</p>
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

export function DoneStep({ name, provider }: { name: string; provider?: MessagingProvider }) {
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
        <p className="text-kumo-subtle m-0">{COPY.done.description(name, provider)}</p>
      </header>
    </section>
  );
}
