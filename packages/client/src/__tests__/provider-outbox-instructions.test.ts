import { describe, expect, it } from "vitest";
import {
  buildProviderOutboxInstructions,
  SLACK_NATIVE_CLI_GUIDANCE,
  SLACK_NATIVE_CLI_GUIDANCE_MAX_BYTES,
} from "../runtime/provider-outbox-instructions.js";

describe("provider outbox instructions", () => {
  it("keeps Slack native CLI guidance under the managed prompt bound", () => {
    const guidance = SLACK_NATIVE_CLI_GUIDANCE.join("\n");
    expect(Buffer.byteLength(guidance, "utf8")).toBeLessThan(SLACK_NATIVE_CLI_GUIDANCE_MAX_BYTES);
    expect(guidance).toContain("slack api chat.postMessage --json");
    expect(guidance).toContain("never key=value pairs");
    expect(guidance).toContain("Do not pass --token, --app, --team, -w, --workspace, --config-dir, --skip-update");
    expect(guidance).toContain("team.info");
    expect(guidance).toContain("users.list");
    expect(guidance).toContain("conversations.list");
    expect(guidance).toContain("conversations.history");
    expect(guidance).toContain("conversations.replies");
    expect(guidance).toContain("chat.update");
    expect(guidance).toContain("chat.delete");
    expect(guidance).toContain("chat.scheduleMessage");
    expect(guidance).toContain("chat.deleteScheduledMessage");
    expect(guidance).toContain("chat.scheduledMessages.list");
    expect(guidance).toContain("conversations.open");
    expect(guidance).toContain("conversations.join");
    expect(guidance).toContain("exactly one user ID");
    expect(guidance).toContain("Do not use it to create an MPIM");
    expect(guidance).toContain("even if the user did not name it");
    expect(guidance).toContain("Do not roam through, bulk-join, or inspect task-unrelated conversations");
    expect(guidance).toContain("public channel and relevant to the current task");
    expect(guidance).toContain("conversations.join `{channel}` once and retry the original action once");
    expect(guidance).toContain("persisted, then mention_only or all_message controls delivery");
    expect(guidance).toContain("private channels, MPIMs, channel_not_found, or an unknown type");
    expect(guidance).toContain("reactions.add");
    expect(guidance).toContain("reactions.get");
    expect(guidance).toContain("reactions.remove");
    expect(guidance).toContain("files.getUploadURLExternal");
    expect(guidance).toContain("files.completeUploadExternal");
    expect(guidance).toContain("deprecated files.upload");
    expect(guidance).toContain("response_metadata.next_cursor");
    expect(guidance).toContain("Retry-After");
    expect(guidance).not.toMatch(/xox[bpa]-/);
  });

  it("preserves safe JSON invocation on the Slack outbox path", () => {
    const instructions = buildProviderOutboxInstructions({
      actionInstruction: "If you choose to reply, run the provider CLI command before ending this Turn.",
      provider: "slack",
      target: { provider: "slack", channelId: "C1" },
      targetLabel: "Current provider reference",
    });
    const text = instructions.join("\n");
    expect(text).toContain("slack api chat.postMessage --json");
    expect(text).toContain("Pass exactly one JSON object");
    expect(text).toContain("never key=value pairs");
    expect(text).not.toContain("OPENTAG_LARK_BODY");
  });
});
