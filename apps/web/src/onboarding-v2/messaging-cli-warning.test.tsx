/**
 * A missing messaging CLI is named as a sentence on this step, not as a numbered check row.
 *
 * `messagingCliCheck` picks the chosen provider's status out of `ReadinessFacts`. A hard-coded
 * provider would warn a Slack user about a CLI they do not need, or stay silent about one they do.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MessagingProvider, ReadinessFacts } from "./flow.js";
import { messagingCliMissingCopy } from "./messaging-readiness-copy.js";
import { MessagingStep } from "./steps.js";

/** Lark's CLI is missing; Slack's is not. */
const readiness: ReadinessFacts = { runtime: "ready", messagingCli: { feishu: "unavailable", slack: "ready" } };

const warningFor = (provider: MessagingProvider): string => messagingCliMissingCopy(provider);

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

describe("the messaging step's CLI warning", () => {
  it("names the chosen provider's missing CLI as a sentence, not a check row", () => {
    renderStep("feishu");
    expect(screen.getByText(warningFor("feishu"))).toBeTruthy();
    expect(document.querySelectorAll(".ots-check")).toHaveLength(0);
  });

  it("stays silent for a provider whose CLI is present, on the same facts", () => {
    renderStep("slack");
    expect(screen.queryByText(warningFor("slack"))).toBeNull();
    expect(screen.queryByText(warningFor("feishu"))).toBeNull();
    expect(document.querySelectorAll(".ots-check")).toHaveLength(0);
  });
});
