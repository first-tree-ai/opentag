import claudeMark from "../assets/claude.svg";
import feishuMark from "../assets/feishu.svg";
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
      <span aria-hidden="true" className="otv2-mark otv2-mark--art" data-brand={brand}>
        <svg className="otv2-mark__svg" focusable="false" viewBox="0 0 48 48">
          <title>{label}</title>
          <path
            d="M23.8 4.4c7.1-.8 14.3 2.6 17.6 8.2 3.5 5.9 3.1 15.3-.8 22-4.2 7.1-12.5 9.6-21.2 9.1-8.3-.5-14.1-4.2-15.2-11.3C2.9 24.6 4.9 15.2 11 9.9c3.3-2.9 7.8-4.9 12.8-5.5Z"
            fill="var(--brand-light)"
            stroke="var(--foreground)"
            strokeWidth="1.5"
          />
          <path
            d="M31.3 42.7c.1-6.3 3.8-10.6 11.8-12.7-1.4 6.7-5.7 11-11.8 12.7Z"
            fill="var(--surface)"
            stroke="var(--foreground)"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
          <circle cx="17.4" cy="23" fill="var(--foreground)" r="1.8" />
          <circle cx="29.4" cy="23" fill="var(--foreground)" r="1.8" />
        </svg>
      </span>
    );
  }

  const art = ART[brand];
  if (art) {
    return (
      <span aria-hidden="true" className="otv2-mark otv2-mark--art" data-brand={brand}>
        <img alt="" className="otv2-mark__svg" src={art} />
      </span>
    );
  }

  /*
   * Codex has no asset here. Taking one out of an installed application establishes where the bytes
   * came from and nothing about redistributing them from this repository, and openai.com serves 403
   * to direct asset requests. So it keeps a neutral mark rather than a file we have no grant for.
   */
  return (
    <span aria-hidden="true" className="otv2-mark" data-brand={brand}>
      {label.slice(0, 1)}
    </span>
  );
}
