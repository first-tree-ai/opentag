import { useId, useState } from "react";
import { Button, KumoSelectControl } from "../ui/design-system.js";
import type { MockBackend, MockScenario, MockSpeed } from "./mock-backend.js";
import { MOCK_SPEEDS, SCENARIOS } from "./mock-backend.js";

/**
 * The only thing on this page production would never show. It drives the mock so an interaction
 * can be judged without waiting for it: pick the outcome the readiness probe should return, run
 * the flow at real speed or quickly, and force the events a real Computer or phone would produce.
 *
 * Note what is *not* here as a page control: there is no "check again" button on the flow itself.
 * Repair happens in the terminal and the page is expected to notice on its own, so the equivalent
 * action lives in the lab where it belongs.
 */
export function LabControls({
  backend,
  cloudAvailable,
  onCloudAvailableChange,
  onScenarioChange,
  onSpeedChange,
  scenario,
  speed,
}: {
  backend: MockBackend;
  cloudAvailable: boolean;
  onCloudAvailableChange: (available: boolean) => void;
  onScenarioChange: (scenario: MockScenario) => void;
  onSpeedChange: (speed: MockSpeed) => void;
  scenario: MockScenario;
  speed: MockSpeed;
}) {
  const [open, setOpen] = useState(false);
  const scenarioId = useId();
  const panelId = useId();

  const pending = backend.pending;

  return (
    <div className="otv2-lab" data-open={open ? "true" : undefined}>
      {/*
        The one thing the outside world would do next — the Computer arriving, the check coming
        back, the QR being scanned. In manual mode nothing happens until this is pressed, so any
        state can be looked at for as long as it takes.
      */}
      <Button className="otv2-lab__advance" disabled={!pending} onClick={pending?.run}>
        {pending?.label ?? "Nothing waiting"}
      </Button>
      <div className="otv2-lab__stack">
        <Button
          variant="ghost"
          aria-controls={panelId}
          aria-expanded={open}
          className="otv2-lab__toggle"
          onClick={() => setOpen((value) => !value)}
        >
          Mock controls
        </Button>
        <div className="otv2-lab__panel" hidden={!open} id={panelId}>
          <label className="otv2-lab__label" htmlFor={scenarioId}>
            Readiness outcome
          </label>
          <KumoSelectControl
            id={scenarioId}
            onChange={(event) => {
              const next = SCENARIOS.find((candidate) => candidate.id === event.target.value);
              if (next) onScenarioChange(next);
            }}
            value={scenario.id}
          >
            {SCENARIOS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </KumoSelectControl>
          <p className="otv2-lab__hint">{scenario.description}</p>

          <div className="otv2-lab__row">
            <span className="otv2-lab__label">Speed</span>
            <div className="otv2-lab__segmented">
              {MOCK_SPEEDS.map((candidate) => (
                <Button
                  variant="ghost"
                  aria-pressed={speed === candidate}
                  key={candidate}
                  onClick={() => onSpeedChange(candidate)}
                >
                  {candidate}
                </Button>
              ))}
            </div>
          </div>

          {/* A toggle rather than a checkbox, so it reads and behaves like the speed control above it. */}
          <Button
            aria-pressed={cloudAvailable}
            className="otv2-lab__check"
            onClick={() => onCloudAvailableChange(!cloudAvailable)}
            size="compact"
            variant="outline"
          >
            Offer the cloud computer
          </Button>

          <div className="otv2-lab__actions">
            <Button onClick={backend.expireNow} size="compact" variant="outline">
              Expire code
            </Button>
            <Button onClick={backend.repairNow} size="compact" variant="outline">
              Ran doctor --fix
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
