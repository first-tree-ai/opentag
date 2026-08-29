import feishuMark from "../assets/feishu.svg";

/**
 * The marks shown beside a runtime or a messaging app.
 *
 * Two are real: OpenTag's own, and the official Feishu mark already carried in `assets/`. The
 * others are lettered tiles standing in for assets we do not have. They are deliberately *not*
 * hand-drawn imitations of the real logos — a redrawn trademark is both inaccurate and a licensing
 * problem, and Slack in particular requires its published files unmodified — so each stays a
 * placeholder until its brand kit lands in `assets/`, at which point only this file changes.
 */
export type BrandId = "opentag" | "feishu" | "slack" | "claude-code" | "codex";

/**
 * Stand-ins carry the vendor's initial, which is also the subtitle on the card, so Claude Code and
 * Codex do not both show a "C".
 */
const PENDING_ASSET: Record<Exclude<BrandId, "opentag" | "feishu">, string> = {
  slack: "S",
  "claude-code": "A",
  codex: "O",
};

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

  if (brand === "feishu") {
    return (
      <span aria-hidden="true" className="otv2-mark otv2-mark--art" data-brand={brand}>
        <img alt="" className="otv2-mark__svg" src={feishuMark} />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className="otv2-mark" data-brand={brand}>
      {PENDING_ASSET[brand]}
    </span>
  );
}
