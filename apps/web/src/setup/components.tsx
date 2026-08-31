import type { FeishuBrand } from "@opentag/shared/browser";
import { toString as qrToString } from "qrcode";
import { useEffect, useState } from "react";
import { StatusIndicator } from "../ui/design-system.js";
import "./setup.css";
import { messagingProviderLabel } from "../im/provider-label.js";
import { type CheckRow, formatRemaining } from "./checks.js";
import { CHECK_COPY, SETUP_COPY } from "./copy.js";

/**
 * A line that says something is still being waited on. Shared because every wait on these surfaces
 * has to read as the same kind of thing — one dot, one sentence, one height.
 */
export const WAITING_LINE = "flex items-center gap-2 text-sm text-kumo-subtle m-0";

/**
 * Whether the computer has arrived, on a line that reserves its own height so nothing below it
 * moves when the answer lands.
 *
 * `dataUi` is the surface's own hook for its tests. The status itself is a boolean rather than a
 * connect state: onboarding is watching a connection being made, settings is reporting one that
 * already exists, and the row says the same thing either way.
 */
export function ConnectStatus({ connected, dataUi }: { connected: boolean; dataUi?: string }) {
  return (
    <div className="ots-slot--status flex flex-col justify-center" data-ui={dataUi}>
      {connected ? (
        <StatusIndicator label={SETUP_COPY.connect.connected} tone="success" />
      ) : (
        <p className={WAITING_LINE} role="status">
          <span aria-hidden="true" className="ots-pulse shrink-0" />
          {SETUP_COPY.connect.waiting}
        </p>
      )}
    </div>
  );
}

export function Countdown({ expiresAt }: { expiresAt: number }) {
  return <span>{SETUP_COPY.connect.expiresIn(formatRemaining(useRemaining(expiresAt)))}</span>;
}

/** Ticks once a second and settles at zero, so an expired code never shows a negative duration. */
export function useRemaining(expiresAt: number): number {
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

export function CheckLine({
  check,
  position,
  runtimeLabel,
}: {
  check: CheckRow;
  position: number;
  runtimeLabel: string;
}) {
  const copy = CHECK_COPY[check.id];
  // Always rendered, even when empty, so a resolving check never changes the row's height.
  const detail = copy.detail[check.state](runtimeLabel);
  const dim = check.state === "blocked" || check.state === "pending";
  return (
    <li
      className="ots-check flex items-center gap-3 p-4 border-t border-kumo-line first:border-t-0 "
      data-state={check.state}
    >
      <span
        aria-hidden="true"
        className="ots-check__marker inline-flex shrink-0 items-center justify-center rounded-full text-xs text-kumo-subtle"
      >
        {position}
      </span>
      <span className="flex flex-col gap-1 min-w-0">
        <span className={dim ? "text-kumo-subtle" : "font-medium text-kumo-strong"}>{copy.title(runtimeLabel)}</span>
        <span className="text-xs text-kumo-subtle">{detail || " "}</span>
      </span>
    </li>
  );
}

export function QrCode({ brand, value }: { brand: FeishuBrand; value: string }) {
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
  return source ? (
    <img
      alt={SETUP_COPY.messaging.qrAlt(messagingProviderLabel("feishu", brand))}
      className="ots-qr__image"
      src={source}
    />
  ) : null;
}
