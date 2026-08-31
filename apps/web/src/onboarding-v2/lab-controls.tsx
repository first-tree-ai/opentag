import { useId, useState } from "react";
import * as m from "../paraglide/messages.js";
import { Button, KumoSelectControl } from "../ui/design-system.js";
import type { MockBackend, MockInventory, MockScenario, MockSpeed } from "./mock-backend.js";
import { INVENTORIES, INVENTORY_TITLES, MOCK_SPEEDS, SCENARIOS } from "./mock-backend.js";

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
  inventory,
  onCloudAvailableChange,
  onInventoryChange,
  onScenarioChange,
  onSpeedChange,
  scenario,
  speed,
}: {
  backend: MockBackend;
  cloudAvailable: boolean;
  inventory: MockInventory;
  onCloudAvailableChange: (available: boolean) => void;
  onInventoryChange: (inventory: MockInventory) => void;
  onScenarioChange: (scenario: MockScenario) => void;
  onSpeedChange: (speed: MockSpeed) => void;
  scenario: MockScenario;
  speed: MockSpeed;
}) {
  const [open, setOpen] = useState(false);
  const scenarioId = useId();
  const inventoryId = useId();
  const panelId = useId();

  const pending = backend.pending;

  return (
    <div
      className="fixed right-3 bottom-3 z-30 flex max-w-[calc(100vw-1.5rem)] items-end gap-2 sm:right-6 sm:bottom-6"
      data-open={open ? "true" : undefined}
      data-ui="onboarding-v2-lab"
    >
      {/*
        The one thing the outside world would do next — the Computer arriving, the check coming
        back, the QR being scanned. In manual mode nothing happens until this is pressed, so any
        state can be looked at for as long as it takes.
      */}
      <Button disabled={!pending} onClick={pending?.run}>
        {pending?.label ?? m.onboarding_v2_lab_nothing_waiting()}
      </Button>
      <div className="flex flex-col items-end gap-2">
        <Button
          aria-controls={panelId}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          variant="secondary"
        >
          {m.onboarding_v2_lab_mock_controls()}
        </Button>
        <div
          className="flex w-72 flex-col gap-3 rounded-xl bg-kumo-base p-4 ring ring-kumo-line"
          hidden={!open}
          id={panelId}
        >
          <label className="text-xs font-medium text-kumo-strong" htmlFor={scenarioId}>
            {m.onboarding_v2_lab_readiness_outcome()}
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
          <p className="text-xs text-kumo-subtle m-0">{scenario.description}</p>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-kumo-strong">{m.onboarding_v2_lab_speed()}</span>
            <div className="flex gap-1">
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

          <div className="grid gap-1">
            <label className="text-xs font-medium uppercase text-kumo-subtle" htmlFor={inventoryId}>
              {m.onboarding_v2_lab_computers_on_account()}
            </label>
            <KumoSelectControl
              id={inventoryId}
              onChange={(event) => onInventoryChange(event.target.value as MockInventory)}
              value={inventory}
            >
              {INVENTORIES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {INVENTORY_TITLES[candidate]}
                </option>
              ))}
            </KumoSelectControl>
          </div>

          {/* A toggle rather than a checkbox, so it reads and behaves like the speed control above it. */}
          <Button
            aria-pressed={cloudAvailable}
            className="justify-start"
            onClick={() => onCloudAvailableChange(!cloudAvailable)}
            size="compact"
            variant="outline"
          >
            {m.onboarding_v2_lab_offer_cloud_computer()}
          </Button>

          <div className="flex flex-wrap gap-2">
            <Button onClick={backend.expireNow} size="compact" variant="outline">
              {m.onboarding_v2_lab_expire_code()}
            </Button>
            <Button onClick={backend.repairNow} size="compact" variant="outline">
              {m.onboarding_v2_lab_ran_doctor_fix()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
