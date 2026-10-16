import type { SlackAgentProvisionCodeResponse } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Button, Field, KumoInputControl, Text } from "../../ui/design-system.js";

export function SlackAgentProvisionCode() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<SlackAgentProvisionCodeResponse>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function generate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setIssued(undefined);
    setCopied(false);
    try {
      const result = await browserApi.issueSlackAgentProvisionCode();
      setIssued(result);
      try {
        await navigator.clipboard.writeText(result.code);
        setCopied(true);
      } catch {
        // Clipboard access can be unavailable on the user's device; the visible code remains usable.
      }
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Text>{m.account_slack_provision_description()}</Text>
      <div>
        <Button disabled={busy} onClick={() => void generate()}>
          {busy ? m.account_slack_provision_generating() : m.account_slack_provision_generate()}
        </Button>
      </div>
      {issued ? (
        <>
          <Field htmlFor="slack-provision-code" label={m.account_slack_provision_code()}>
            <KumoInputControl
              id="slack-provision-code"
              readOnly
              value={issued.code}
              onFocus={(event) => event.target.select()}
            />
          </Field>
          <p role="status">
            {copied
              ? m.account_slack_provision_copied({ minutes: Math.ceil(issued.expiresIn / 60) })
              : m.account_slack_provision_manual({ minutes: Math.ceil(issued.expiresIn / 60) })}
          </p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-kumo-danger">
          {m.account_slack_provision_error()}
        </p>
      ) : null}
    </div>
  );
}
