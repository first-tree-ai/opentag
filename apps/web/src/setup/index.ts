/**
 * The setup pieces onboarding and Agent settings both use.
 *
 * Connecting a computer and connecting a messaging app are the same work whether they are met while
 * setting an Agent up for the first time or reopened later from its settings. What differs is the
 * frame around them — a numbered flow with a Continue button, or a dialog over a settings page — so
 * what lives here is the inside of that frame and nothing of either frame itself.
 *
 * Each visual piece imports its own stylesheet, so nothing that uses one has to know which sheet it
 * came from.
 */

export {
  type CheckRow,
  type CheckState,
  deriveChecks,
  formatRemaining,
  type MessagingCliStatus,
  messagingCliCheck,
  type RuntimeStatus,
} from "./checks.js";
export { CommandBlock } from "./command-block.js";
export { CheckLine, ConnectStatus, Countdown, QrCode, useRemaining, WAITING_LINE } from "./components.js";
export { CHECK_COPY, SETUP_COPY } from "./copy.js";
