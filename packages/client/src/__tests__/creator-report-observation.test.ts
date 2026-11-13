import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, JsonValue } from "../agent-runtime/types.js";
import { CreatorReportObservation } from "../runtime/creator-report-observation.js";

const creator = randomUUID();
const id = randomUUID();
const cli = "'/opt/homebrew/bin/node' '/opt/open tag/index.mjs'";
const send = `${cli} session send ${creator} --message "it worked" --message-id ${id}`;

function finished(
  command: JsonValue,
  aggregatedOutput: string,
  exitCode: number,
  status = exitCode === 0 ? "completed" : "failed",
): Extract<AgentRuntimeEvent, { type: "tool_completed" }> {
  return {
    runId: "run",
    toolCallId: randomUUID(),
    type: "tool_completed",
    name: "commandExecution",
    status: status === "declined" ? "declined" : exitCode === 0 ? "completed" : "failed",
    output: { type: "commandExecution", command, aggregatedOutput, exitCode, status },
  };
}

const rejected = `status=rejected messageId=${id} code=target_unavailable`;
const unknown = `status=unknown messageId=${id} code=SERVICE_UNAVAILABLE message="The openTag server is unavailable"`;
const accepted = `status=accepted messageId=${id} sessionId=${creator}`;

describe("CreatorReportObservation", () => {
  it("distinguishes confirmed acceptance from a definite failure and an unknown transport outcome", () => {
    const acceptedOnly = new CreatorReportObservation(cli, creator);
    acceptedOnly.observe(finished(send, accepted, 0));
    expect(acceptedOnly.unresolved()).toBeUndefined();

    const report = new CreatorReportObservation(cli, creator);
    report.observe(finished(send, rejected, 1));
    expect(report.unresolved()).toBe("failed");
    report.observe(finished(`/bin/zsh -c ${JSON.stringify(send)}`, unknown, 3));
    expect(report.unresolved()).toBe("unknown");
    report.observe(finished(send, rejected, 1));
    expect(report.unresolved()).toBe("unknown");
  });

  it("clears only a correlated retry and keeps acceptance when later responses fail", () => {
    const report = new CreatorReportObservation(cli, creator);
    report.observe(finished(send, unknown, 3));
    report.observe(finished(send.replace("it worked", "another report"), accepted, 0));
    expect(report.unresolved()).toBe("unknown");
    const otherId = randomUUID();
    report.observe(finished(send.replaceAll(id, otherId), accepted.replaceAll(id, otherId), 0));
    expect(report.unresolved()).toBe("unknown");

    const argv = [
      "/opt/homebrew/bin/node",
      "/opt/open tag/index.mjs",
      "session",
      "send",
      creator,
      "--message=it worked",
      "--message-id",
      id,
      "--json",
    ];
    report.observe(finished(["/bin/bash", "-lc", send], rejected, 1));
    expect(report.unresolved()).toBe("unknown");
    report.observe(finished(argv, JSON.stringify({ status: "accepted", messageId: id, sessionId: creator }), 0));
    report.observe(finished(send, rejected, 1));
    expect(report.unresolved()).toBeUndefined();
  });

  it.each([
    [`echo '${send}'`, rejected, 1, "failed"],
    [`${send}; echo ignored`, rejected, 1, "failed"],
    [send.replace("it worked", "$REPORT"), rejected, 1, "failed"],
    [send.replace(cli, "opentag"), rejected, 1, "failed"],
    [send.replace(creator, randomUUID()), rejected, 1, "failed"],
    [send, rejected.replace(id, randomUUID()), 1, "failed"],
    [send, `${rejected}\nunrelated output`, 1, "failed"],
    [send, rejected, 0, "completed"],
    [send, rejected, 1, "declined"],
  ])("ignores an unverified command or receipt %s", (command, output, exitCode, status) => {
    const report = new CreatorReportObservation(cli, creator);
    report.observe(finished(command, output, exitCode, status));
    expect(report.unresolved()).toBeUndefined();
  });

  it("keeps an uncorrelated internal runtime failure unknown", () => {
    const report = new CreatorReportObservation(cli, creator);
    report.observe(finished(send, `status=unreachable messageId=${id} code=runtime_unavailable`, 1));
    expect(report.unresolved()).toBe("unknown");
  });

  it("recognizes literal multiline text and shell-escaped apostrophes", () => {
    const report = new CreatorReportObservation(cli, creator);
    report.observe(finished(send.replace('"it worked"', `'it'"'"'s done\nreport'`), unknown, 3));
    expect(report.unresolved()).toBe("unknown");
    report.observe(finished(send.replace('"it worked"', `"it's done\nreport"`), accepted, 0));
    expect(report.unresolved()).toBeUndefined();
  });
});
