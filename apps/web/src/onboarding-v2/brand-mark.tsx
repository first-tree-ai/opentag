import claudeMark from "../assets/claude.svg";
import feishuMark from "../assets/feishu.svg";
import openAIBlossomBlack from "../assets/openai-blossom-black.svg";
import openAIBlossomWhite from "../assets/openai-blossom-white.svg";
import slackMark from "../assets/slack.svg";

/**
 * The marks shown beside a runtime or a messaging app. Each is the vendor's own published file,
 * carried in `assets/` with a comment recording where and when it came from. None is redrawn: an
 * imitation of a trademark is both inaccurate and the worse licensing position. Ownership and the
 * conditions each publisher sets are recorded in TRADEMARKS.md at the repository root. Anything we
 * have no redistribution grant for is not carried here at all.
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
        <svg className="size-8" focusable="false" viewBox="0 0 48 48">
          <title>{label}</title>
          <path
            d="M23.8 4.4c7.1-.8 14.3 2.6 17.6 8.2 3.5 5.9 3.1 15.3-.8 22-4.2 7.1-12.5 9.6-21.2 9.1-8.3-.5-14.1-4.2-15.2-11.3C2.9 24.6 4.9 15.2 11 9.9c3.3-2.9 7.8-4.9 12.8-5.5Z"
            fill="var(--otv2-mark-tint)"
            stroke="var(--otv2-mark-ink)"
            strokeWidth="1.5"
          />
          <path
            d="M31.3 42.7c.1-6.3 3.8-10.6 11.8-12.7-1.4 6.7-5.7 11-11.8 12.7Z"
            fill="var(--otv2-mark-surface)"
            stroke="var(--otv2-mark-ink)"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
          <circle cx="17.4" cy="23" fill="var(--otv2-mark-ink)" r="1.8" />
          <circle cx="29.4" cy="23" fill="var(--otv2-mark-ink)" r="1.8" />
        </svg>
      </span>
    );
  }

  if (brand === "codex") {
    return (
      <span aria-hidden="true" className="otv2-mark otv2-mark--art" data-brand={brand}>
        <picture className="otv2-mark__picture">
          <source media="(prefers-color-scheme: dark)" srcSet={openAIBlossomWhite} />
          <img alt="" className="otv2-mark__svg" src={openAIBlossomBlack} />
        </picture>
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
