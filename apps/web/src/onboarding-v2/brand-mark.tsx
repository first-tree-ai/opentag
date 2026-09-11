import claudeMark from "../assets/claude.svg";
import feishuMark from "../assets/feishu.svg";
import openAIBlossomBlack from "../assets/openai-blossom-black.svg";
import openAIBlossomWhite from "../assets/openai-blossom-white.svg";
import slackMark from "../assets/slack.svg";
import { OpenTagLogo } from "../ui/opentag-logo.js";

/**
 * Vendor marks shown beside a runtime or messaging app.
 */
export type BrandId = "opentag" | "feishu" | "slack" | "claude-code" | "codex";

const ART: Partial<Record<BrandId, string>> = {
  feishu: feishuMark,
  slack: slackMark,
  "claude-code": claudeMark,
};

/** Slack documents embedding this button from their own URL, so it is referenced, not copied. */
export const ADD_TO_SLACK_URL = "https://platform.slack-edge.com/img/add_to_slack@2x.png";

export function BrandMark({ brand, label }: { brand: BrandId; label: string }) {
  if (brand === "opentag") {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed text-sm font-medium text-kumo-subtle overflow-hidden"
        data-brand={brand}
      >
        <OpenTagLogo label="" variant="mark" />
      </span>
    );
  }

  if (brand === "codex") {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed text-sm font-medium text-kumo-subtle overflow-hidden"
        data-brand={brand}
      >
        <img alt="" className="otv2-codex-mark--light size-8" src={openAIBlossomBlack} />
        <img alt="" className="otv2-codex-mark--dark size-8" src={openAIBlossomWhite} />
      </span>
    );
  }

  const art = ART[brand];
  if (art) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed text-sm font-medium text-kumo-subtle overflow-hidden"
        data-brand={brand}
      >
        <img alt="" className="size-8" src={art} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-kumo-recessed text-sm font-medium text-kumo-subtle overflow-hidden"
      data-brand={brand}
    >
      {label.slice(0, 1)}
    </span>
  );
}
