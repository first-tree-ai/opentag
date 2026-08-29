import { useId, useState } from "react";
import { Button } from "../ui/design-system.js";
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
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className="otv2-lab__toggle"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          Mock controls
        </button>
        <div className="otv2-lab__panel" hidden={!open} id={panelId}>
          <label className="otv2-lab__label" htmlFor={scenarioId}>
            Readiness outcome
          </label>
          <select
            className="ds-control"
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
          </select>
          <p className="otv2-lab__hint">{scenario.description}</p>

          <div className="otv2-lab__row">
            <span className="otv2-lab__label">Speed</span>
            <div className="otv2-lab__segmented">
              {MOCK_SPEEDS.map((candidate) => (
                <button
                  aria-pressed={speed === candidate}
                  key={candidate}
                  onClick={() => onSpeedChange(candidate)}
                  type="button"
                >
                  {candidate}
                </button>
              ))}
            </div>
          </div>

          <label className="otv2-lab__check">
            <input
              checked={cloudAvailable}
              onChange={(event) => onCloudAvailableChange(event.target.checked)}
              type="checkbox"
            />
            <span>Offer the cloud computer</span>
          </label>

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
