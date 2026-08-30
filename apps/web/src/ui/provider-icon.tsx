import type { ImProvider } from "@opentag/shared/browser";
import feishuIconUrl from "../assets/feishu.svg";
import slackIconUrl from "../assets/slack.svg";

export function providerIconUrl(provider: ImProvider): string {
  return provider === "feishu" ? feishuIconUrl : slackIconUrl;
}

/** Decorative provider mark. Every caller states the provider in its own accessible name. */
export function ProviderIcon({ className, provider }: { className?: string; provider: ImProvider }) {
  return <img alt="" aria-hidden="true" className={className} src={providerIconUrl(provider)} />;
}
