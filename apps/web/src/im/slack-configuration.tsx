import type { SlackAppConfiguration } from "@opentag/shared/browser";
import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { Button } from "../ui/design-system.js";

type SlackConfigurationIntent = "create" | "reauthorize" | "replace";

const SLACK_CONFIGURATION_MESSAGES: Record<string, string> = {
  IM_BINDING_FORBIDDEN: "Only the Account owner can manage this Slack configuration.",
  IM_BINDING_PROVIDER_IMMUTABLE:
    "This Agent is connected to a different IM provider. Disable that binding before connecting Slack.",
  SLACK_APP_TEAM_ALREADY_BOUND:
    "This Slack App installation is already connected to another Agent. Create a separate App for this Agent.",
  SLACK_AUTH_IDENTITY_INCOMPLETE:
    "Slack accepted this token but did not identify an installed Bot. Copy the Bot User OAuth Token, not a User Token.",
  SLACK_AUTH_INVALID: "Slack rejected the Bot User OAuth Token. Copy the Bot Token from OAuth & Permissions.",
  SLACK_BINDING_IDENTITY_MISMATCH:
    "The Slack App, Team, or Bot identity does not match this operation. Reauthorize the current App or explicitly choose Change App.",
  SLACK_CONFIGURATION_CONFLICT: "The Slack binding changed while this form was open. Reopen it and try again.",
  SLACK_SCOPE_REAUTH_REQUIRED:
    "The installed App is missing required bot scopes. Apply the complete manifest, reinstall the App, and retry.",
  SLACK_TOKEN_REVOKED: "Slack revoked the Bot Token. Reauthorize to install fresh credentials.",
  SLACK_UPSTREAM_UNAVAILABLE: "Slack did not return installation details. Check Slack availability and retry.",
};

export interface SlackConfigurationControl {
  /** Opens the stateless Slack configuration form. */
  open: (intent?: SlackConfigurationIntent) => Promise<boolean>;
  feedback: ReactNode;
}

interface SlackConfigurationProps {
  agentId: string;
  children: (control: SlackConfigurationControl) => ReactNode;
  onSuccess: () => void;
}

export function SlackConfiguration({ agentId, children, onSuccess }: SlackConfigurationProps) {
  const [configuration, setConfiguration] = useState<SlackAppConfiguration>();
  const [intent, setIntent] = useState<SlackConfigurationIntent>("create");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function open(nextIntent: SlackConfigurationIntent = "create"): Promise<boolean> {
    if (loading) return false;
    setLoading(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await browserApi.slackAppConfiguration(agentId);
      setIntent(nextIntent);
      setConfiguration(next);
      return true;
    } catch (cause) {
      setError(normalizeSlackConfigurationError(cause, "Unable to open Slack configuration"));
      return false;
    } finally {
      setLoading(false);
    }
  }

  return children({
    open,
    feedback: (
      <>
        {configuration ? (
          <SlackConfigurationForm
            configuration={configuration}
            intent={intent}
            onCancel={() => setConfiguration(undefined)}
            onError={setError}
            onSuccess={() => {
              setConfiguration(undefined);
              setError(undefined);
              setSaved(true);
              onSuccess();
            }}
          />
        ) : null}
        {saved ? (
          <div className="notice success" role="status">
            Slack configuration is active. A future signed event will verify the App-to-Bot identity before runtime
            access becomes ready; Request URL verification remains observation-only, and no test message is required to
            save this generation.
          </div>
        ) : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </>
    ),
  });
}

function SlackConfigurationForm({
  configuration,
  intent,
  onCancel,
  onError,
  onSuccess,
}: {
  configuration: SlackAppConfiguration;
  intent: SlackConfigurationIntent;
  onCancel: () => void;
  onError: (message: string | undefined) => void;
  onSuccess: () => void;
}) {
  const [appId, setAppId] = useState(intent === "reauthorize" ? (configuration.currentBinding?.appId ?? "") : "");
  const [botAccessToken, setBotAccessToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const manifestJson = JSON.stringify(configuration.manifest, null, 2);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    onError(undefined);
    try {
      await browserApi.configureSlackApp(configuration.agentId, {
        intent,
        expectedBinding: configuration.currentBinding
          ? {
              id: configuration.currentBinding.id,
              credentialGeneration: configuration.currentBinding.credentialGeneration,
            }
          : null,
        appId,
        botAccessToken,
        signingSecret,
      });
      setBotAccessToken("");
      setSigningSecret("");
      onSuccess();
    } catch (cause) {
      onError(normalizeSlackConfigurationError(cause, "Unable to save Slack configuration"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="notice">
      <strong>Slack App configuration</strong>
      <SlackManifestGuide configuration={configuration} intent={intent} manifestJson={manifestJson} />
      <p>Required bot scopes: {configuration.requiredBotScopes.join(", ")}.</p>
      <p>Subscribed bot events: {configuration.subscribedBotEvents.join(", ")}.</p>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label>
          Slack App ID
          <input
            autoComplete="off"
            name="slackAppId"
            onChange={(event) => setAppId(event.target.value)}
            readOnly={intent === "reauthorize"}
            required
            value={appId}
          />
        </label>
        <p className="muted">
          Slack auth.test may omit the App ID for a Bot Token. OpenTag stores this explicitly configured value and
          requires a signed real event to close the App, Team, and token-derived Bot identity before runtime access is
          ready; the value is not presented as Slack API-attested identity. Slack's identity-less URL challenge
          authenticates only the Signing Secret.
        </p>
        <label>
          Bot User OAuth Token
          <input
            autoComplete="off"
            name="slackBotAccessToken"
            onChange={(event) => setBotAccessToken(event.target.value)}
            required
            type="password"
            value={botAccessToken}
          />
        </label>
        <label>
          Signing Secret
          <input
            autoComplete="off"
            name="slackSigningSecret"
            onChange={(event) => setSigningSecret(event.target.value)}
            required
            type="password"
            value={signingSecret}
          />
        </label>
        <div className="im-actions">
          <Button disabled={submitting} type="submit">
            {submitting ? "Saving Slack configuration…" : "Save Slack configuration"}
          </Button>
          <Button disabled={submitting} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function SlackManifestGuide({
  configuration,
  intent,
  manifestJson,
}: {
  configuration: SlackAppConfiguration;
  intent: SlackConfigurationIntent;
  manifestJson: string;
}) {
  const existingAppUrl = configuration.currentBinding
    ? `https://api.slack.com/apps/${encodeURIComponent(configuration.currentBinding.appId)}/app-manifest`
    : "https://api.slack.com/apps";
  return (
    <ol>
      {intent === "reauthorize" ? (
        <li>
          <a href={existingAppUrl} rel="noreferrer" target="_blank">
            Open the current Slack App manifest
          </a>
          , replace it with the complete manifest below, save, and reinstall the App to the workspace.
          <SlackManifestJson value={manifestJson} />
        </li>
      ) : (
        <li>
          <a href={configuration.manifestUrl} rel="noreferrer" target="_blank">
            {intent === "replace"
              ? "Create a replacement Slack App from the complete manifest"
              : "Create a Slack App from the complete manifest"}
          </a>
          . If Slack does not prefill it, paste the JSON below.
          <SlackManifestJson value={manifestJson} />
        </li>
      )}
      <li>
        Copy the App ID from <strong>Basic Information</strong>, the Bot User OAuth Token from{" "}
        <strong>OAuth &amp; Permissions</strong>, and the Signing Secret from <strong>Basic Information</strong>.
      </li>
      <li>
        Save all three values below. OpenTag validates Team, Bot identity, and the complete scope grant atomically.
      </li>
      <li>
        After the save succeeds, retry this Request URL in <strong>Event Subscriptions</strong> if Slack has not already
        accepted it: <code>{configuration.eventsUrl}</code>
      </li>
    </ol>
  );
}

function SlackManifestJson({ value }: { value: string }) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="form-stack">
      <textarea aria-label="Slack App manifest JSON" readOnly rows={8} value={value} />
      <div className="im-actions">
        <Button variant="secondary" onClick={() => void copy()}>
          Copy manifest JSON
        </Button>
        {copied === "copied" ? <span role="status">Copied</span> : null}
        {copied === "failed" ? <span role="status">Copy failed; select the JSON above manually.</span> : null}
      </div>
    </div>
  );
}

function normalizeSlackConfigurationError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code && SLACK_CONFIGURATION_MESSAGES[code]) return SLACK_CONFIGURATION_MESSAGES[code];
  return cause instanceof Error ? cause.message : fallback;
}
