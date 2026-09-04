import { toString as qrToString } from "qrcode";
import { useEffect, useState } from "react";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import "./setup.css";

/**
 * A line that says something is still being waited on. Shared because every wait on these surfaces
 * has to read as the same kind of thing — one dot, one sentence, one height.
 */
export const WAITING_LINE = "flex items-center gap-2 text-sm text-kumo-subtle m-0";

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

export function QrCode({ value }: { value: string }) {
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
  return (
    <div className="ots-qr" data-ui="setup-qr">
      {source ? (
        <img
          alt={m.im_qr_scan_alt({ provider: messagingProviderLabel("feishu") })}
          className="ots-qr__image"
          src={source}
        />
      ) : null}
    </div>
  );
}
