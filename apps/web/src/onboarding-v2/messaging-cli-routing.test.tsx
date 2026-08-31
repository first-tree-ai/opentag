/**
 * The messaging step asks about the CLI of the provider that was actually chosen.
 *
 * `messagingCliCheck` takes a bare status, so picking the right entry out of `ReadinessFacts`
 * happens at this call site rather than inside the check. Nothing else asserts that: a hard-coded
 * provider would warn a Slack user about a CLI they do not need, or stay silent about one they do,
 * and every other test feeds the two providers the same status.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SETUP_COPY } from "../setup/copy.js";
import type { MessagingProvider, ReadinessFacts } from "./flow.js";
import { MessagingStep } from "./steps.js";

/** One set of facts that answers differently per provider: Lark's CLI is missing, Slack's is not. */
const readiness: ReadinessFacts = { runtime: "ready", messagingCli: { feishu: "install", slack: "ready" } };

const warningFor = (provider: MessagingProvider): string =>
  SETUP_COPY.messaging.cliMissing(SETUP_COPY.messaging[provider].title);

function renderStep(provider: MessagingProvider) {
  render(
    <MessagingStep
      computerOnline
      messaging={{ kind: "idle" }}
      onChoose={() => undefined}
      onSlackInstall={() => undefined}
      onStart={() => undefined}
      provider={provider}
      readiness={readiness}
    />,
  );
}

describe("the messaging step's CLI check", () => {
  it("warns about the chosen provider's missing CLI", () => {
    renderStep("feishu");
    expect(screen.getByText(warningFor("feishu"))).toBeTruthy();
  });

  it("stays silent for a provider whose CLI is present, on the same facts", () => {
    renderStep("slack");
    // Neither its own warning nor the other provider's: reading position 0 would show one here.
    expect(screen.queryByText(warningFor("slack"))).toBeNull();
    expect(screen.queryByText(warningFor("feishu"))).toBeNull();
  });
});
