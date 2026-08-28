import { toString as qrToString } from "qrcode";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button, Field, Icon, StatusIndicator } from "../ui/design-system.js";
import { CommandBlock } from "./command-block.js";
import { CHECK_COPY, COPY, DESTINATION_COPY, RUNTIME_COPY, STEP_LABELS } from "./copy.js";
import {
  type AgentDraft,
  type CheckRow,
  type ConnectState,
  type CreationState,
  DEFAULT_AGENT_NAME,
  type Destination,
  deriveChecks,
  type FlowState,
  formatRemaining,
  type MessagingState,
  type ReadinessFacts,
  RUNTIMES,
  type Runtime,
  readinessIsResolving,
  readinessPassed,
  validateAgentName,
} from "./flow.js";

export function StepRail({ steps }: { steps: FlowState["steps"] }) {
  return (
    <nav aria-label="Setup progress" className="otv2-rail">
      <ol>
        {steps.map((step, index) => (
          <li className="otv2-rail__step" data-status={step.status} key={step.id}>
            <span className="otv2-rail__marker" aria-hidden="true">
              {step.status === "complete" ? <Icon name="check" /> : index + 1}
            </span>
            <span className="otv2-rail__label">{STEP_LABELS[step.id]}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function DestinationStep({ onChoose }: { onChoose: (destination: Destination) => void }) {
  const destinations: readonly { id: Destination; icon: "laptop" | "model"; enabled: boolean }[] = [
    { id: "local", icon: "laptop", enabled: true },
    { id: "cloud", icon: "model", enabled: false },
  ];
  return (
    <section className="otv2-step">
      <header className="otv2-step__header">
        <h1>{COPY.destination.title}</h1>
        <p>{COPY.destination.description}</p>
      </header>
      <ul className="otv2-choices">
        {destinations.map((destination) => {
          const copy = DESTINATION_COPY[destination.id];
          return (
            <li key={destination.id}>
              <button
                className="otv2-choice otv2-choice--wide"
                disabled={!destination.enabled}
                onClick={() => onChoose(destination.id)}
                type="button"
              >
                <Icon className="otv2-choice__icon" name={destination.icon} />
                <span className="otv2-choice__copy">
                  <strong>
                    {copy.title}
                    {copy.badge ? <em className="otv2-badge">{copy.badge}</em> : null}
                  </strong>
                  <span>{copy.description}</span>
                </span>
                {destination.enabled ? <Icon className="otv2-choice__go" name="arrow-right" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AgentStep({
  draft,
  onChange,
  onSubmit,
}: {
  draft: AgentDraft;
  onChange: (draft: AgentDraft) => void;
  onSubmit: () => void;
}) {
  const nameId = useId();
  const hintId = `${nameId}-hint`;
  const errorId = `${nameId}-error`;
  // Errors are held back until the field is left, so a name is never called invalid mid-typing.
  const [touched, setTouched] = useState(false);
  const error = touched ? validateAgentName(draft.name) : undefined;
  const errorText =
    error === "empty"
      ? COPY.agent.nameEmptyError
      : error === "too-long"
        ? COPY.agent.nameTooLongError
        : error === "charset"
          ? COPY.agent.nameCharsetError
          : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (validateAgentName(draft.name) === undefined && draft.runtime) onSubmit();
  }

  return (
    <section className="otv2-step">
      <header className="otv2-step__header">
        <h1>{COPY.agent.title}</h1>
      </header>
      <form className="otv2-form" onSubmit={submit}>
        <Field
          error={errorText}
          errorId={errorId}
          hint={COPY.agent.nameHint}
          hintId={hintId}
          htmlFor={nameId}
          label={COPY.agent.nameLabel}
        >
          <input
            aria-describedby={errorText ? `${hintId} ${errorId}` : hintId}
            aria-invalid={errorText ? true : undefined}
            autoComplete="off"
            className="ds-control otv2-name"
            id={nameId}
            onBlur={() => setTouched(true)}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={DEFAULT_AGENT_NAME}
            spellCheck={false}
            value={draft.name}
          />
        </Field>

        <fieldset className="otv2-fieldset">
          <legend>{COPY.agent.runtimeLabel}</legend>
          <p className="otv2-fieldset__hint">{COPY.agent.runtimeHint}</p>
          <ul className="otv2-choices otv2-choices--grid">
            {RUNTIMES.map((runtime) => (
              <li key={runtime}>
                <button
                  aria-pressed={draft.runtime === runtime}
                  className="otv2-choice otv2-choice--runtime"
                  onClick={() => onChange({ ...draft, runtime })}
                  type="button"
                >
                  <RuntimeMark runtime={runtime} />
                  <span className="otv2-choice__copy">
                    <strong>{RUNTIME_COPY[runtime].title}</strong>
                    <span>{RUNTIME_COPY[runtime].description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="otv2-footnote">{COPY.agent.runtimeFootnote}</p>
          {draft.runtime ? <p className="otv2-footnote otv2-footnote--warn">{COPY.agent.runtimeLocked}</p> : null}
        </fieldset>

        <div className="otv2-actions">
          <Button disabled={!draft.runtime} type="submit">
            {COPY.agent.continue}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Placeholder runtime marks. Real vendor logos are licensed assets and are dropped in here once
 * their usage terms are cleared; the layout reserves the same square either way.
 */
function RuntimeMark({ runtime }: { runtime: Runtime }) {
  return (
    <span aria-hidden="true" className="otv2-mark" data-runtime={runtime}>
      {RUNTIME_COPY[runtime].title.slice(0, 1)}
    </span>
  );
}

export function SetupStep({
  connect,
  creation,
  draft,
  onCreate,
  onRefreshCommand,
  readiness,
}: {
  connect: ConnectState;
  creation: CreationState;
  draft: AgentDraft;
  onCreate: () => void;
  onRefreshCommand: () => void;
  readiness: ReadinessFacts | undefined;
}) {
  const connected = connect.kind === "connected";
  return (
    <section className="otv2-step">
      <header className="otv2-step__header">
        <h1>{COPY.setup.title}</h1>
        <p>{COPY.setup.description}</p>
        <p className="otv2-privacy">
          <Icon name="shield" />
          {COPY.setup.privacy}
        </p>
      </header>

      <ConnectPanel connect={connect} onRefreshCommand={onRefreshCommand} />

      {connected ? (
        <ReadinessPanel creation={creation} draft={draft} onCreate={onCreate} readiness={readiness} />
      ) : null}
    </section>
  );
}

function ConnectPanel({ connect, onRefreshCommand }: { connect: ConnectState; onRefreshCommand: () => void }) {
  if (connect.kind === "idle" || connect.kind === "issuing") {
    return (
      <div className="otv2-panel">
        <p className="otv2-muted">{COPY.setup.commandIntro}</p>
        <div aria-hidden="true" className="otv2-command otv2-command--placeholder" />
      </div>
    );
  }

  const expired = connect.kind === "expired";
  return (
    <div className="otv2-panel">
      <p className="otv2-muted">{COPY.setup.commandIntro}</p>
      <CommandBlock
        key={connect.command}
        command={connect.command}
        comment={COPY.setup.commandComment}
        copiedLabel={COPY.setup.copied}
        copyLabel={COPY.setup.copy}
        fallbackHint={COPY.setup.copyFallback}
        muted={expired}
        footer={
          connect.kind === "issued" ? (
            <Countdown expiresAt={connect.expiresAt} />
          ) : expired ? (
            <span className="otv2-command__expiry">
              <span>{COPY.setup.expired}</span>
              <Button onClick={onRefreshCommand} variant="inline">
                {COPY.setup.refresh}
              </Button>
            </span>
          ) : null
        }
      />
      <ConnectStatus connect={connect} />
    </div>
  );
}

function ConnectStatus({ connect }: { connect: ConnectState }) {
  if (connect.kind === "connected") {
    return (
      <StatusIndicator className="otv2-status" label={COPY.setup.connected(connect.computerName)} tone="success" />
    );
  }
  return (
    <p className="otv2-waiting" role="status">
      <span aria-hidden="true" className="otv2-pulse" />
      {COPY.setup.waiting}
    </p>
  );
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const remaining = useRemaining(expiresAt);
  return <span className="otv2-command__expiry">{COPY.setup.expiresIn(formatRemaining(remaining))}</span>;
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

function ReadinessPanel({
  creation,
  draft,
  onCreate,
  readiness,
}: {
  creation: CreationState;
  draft: AgentDraft;
  onCreate: () => void;
  readiness: ReadinessFacts | undefined;
}) {
  const checks = deriveChecks(readiness);
  const runtimeLabel = draft.runtime ? RUNTIME_COPY[draft.runtime].title : "";
  const resolving = readinessIsResolving(readiness);
  const passed = readinessPassed(readiness);
  const failures = checks.filter((check) => check.state === "failed");

  return (
    <div className="otv2-panel otv2-panel--checks">
      <h2>{resolving ? COPY.setup.checksTitle : COPY.setup.checksTitleResolved}</h2>
      {resolving ? <p className="otv2-muted">{COPY.setup.checksDescription}</p> : null}
      <ul className="otv2-checks">
        {checks.map((check) => (
          <CheckLine check={check} key={check.id} runtimeLabel={runtimeLabel} />
        ))}
      </ul>

      {!resolving && failures.length > 0 ? (
        <div className="otv2-repair">
          <p className="otv2-repair__intro">
            {failures.length > 1 ? COPY.setup.checksFailedIntro : COPY.setup.checksFailedIntroSingular}
          </p>
          <p className="otv2-muted">{COPY.setup.doctorIntro}</p>
          <CommandBlock
            command="opentag doctor --fix"
            comment={COPY.setup.doctorComment}
            copiedLabel={COPY.setup.copied}
            copyLabel={COPY.setup.copy}
            fallbackHint={COPY.setup.copyFallback}
            footer={
              <span className="otv2-waiting" role="status">
                <span aria-hidden="true" className="otv2-pulse" />
                {COPY.setup.doctorWaiting}
              </span>
            }
          />
        </div>
      ) : null}

      {passed ? (
        <div className="otv2-actions otv2-actions--split">
          <StatusIndicator label={COPY.setup.checksPassed} tone="success" />
          <Button disabled={creation === "creating"} onClick={onCreate}>
            {creation === "creating" ? COPY.setup.creating : COPY.setup.finish}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CheckLine({ check, runtimeLabel }: { check: CheckRow; runtimeLabel: string }) {
  const copy = CHECK_COPY[check.id];
  return (
    <li className="otv2-check" data-state={check.state}>
      <span aria-hidden="true" className="otv2-check__marker">
        {check.state === "passed" ? <Icon name="check" /> : check.state === "failed" ? <Icon name="close" /> : null}
      </span>
      <span className="otv2-check__copy">
        <strong>{copy.title(runtimeLabel)}</strong>
        {check.state === "failed" ? <span>{copy.failure(runtimeLabel)}</span> : null}
        {check.state === "blocked" ? <span>{COPY.setup.blockedNote}</span> : null}
      </span>
    </li>
  );
}

export function MessagingStep({ messaging, onStart }: { messaging: MessagingState; onStart: () => void }) {
  useEffect(() => {
    if (messaging.kind === "idle") onStart();
  }, [messaging.kind, onStart]);

  return (
    <section className="otv2-step">
      <header className="otv2-step__header">
        <h1>{COPY.messaging.title}</h1>
        <p>{COPY.messaging.description}</p>
      </header>
      <div className="otv2-panel otv2-panel--qr">
        <div className="otv2-qr">
          {messaging.kind === "waiting" ? (
            <QrCode value={messaging.qrValue} />
          ) : (
            <div className="otv2-qr__placeholder" />
          )}
        </div>
        <p className="otv2-waiting" role="status">
          <span aria-hidden="true" className="otv2-pulse" />
          {COPY.messaging.waiting}
        </p>
      </div>
      <p className="otv2-footnote">
        {COPY.messaging.slack} <em className="otv2-badge">{COPY.messaging.slackBadge}</em>
      </p>
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
  return source ? <img alt={COPY.messaging.qrAlt} className="otv2-qr__image" src={source} /> : null;
}

export function DoneStep({ name }: { name: string }) {
  return (
    <section className="otv2-step otv2-step--done">
      <span aria-hidden="true" className="otv2-done-mark">
        <Icon name="check" />
      </span>
      <header className="otv2-step__header">
        <h1>{COPY.done.title(name)}</h1>
        <p>{COPY.done.description(name)}</p>
      </header>
    </section>
  );
}
