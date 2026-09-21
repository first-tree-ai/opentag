import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { deriveProviderCliRunKey, executeProviderCliTurnPlan } from "../index.js";
import {
  captureFeishuOutgoingReply,
  classifyLarkOutgoingMutation,
  parseLarkCliSuccessEnvelope,
  postToPlainText,
  spawnCapturedProcess,
  withOutgoingReplyInflight,
} from "../runtime/provider-cli/outgoing-reply-capture.js";
import { cleanupOutgoingReplyRun, collectOutgoingReplyReceipts } from "../runtime/provider-cli/outgoing-reply-store.js";
import {
  installTurnTarget,
  makeTurnPlanHarness,
  writeExternalTurnSelection,
} from "./fixtures/provider-cli-turn-plan.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function trackedHarness() {
  const harness = await makeTurnPlanHarness();
  tempDirs.push(harness.accountHome, harness.openTagHome);
  return harness;
}

function sendEnvelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    identity: "bot",
    data: { message_id: "om_sent", chat_id: "oc_chat", create_time: "1000", ...overrides },
  });
}

function getEnvelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    identity: "bot",
    data: {
      items: [
        {
          message_id: "om_sent",
          chat_id: "oc_chat",
          msg_type: "text",
          body: { content: JSON.stringify({ text: "actual provider body" }) },
          sender: { id: "ou_bot", sender_type: "app" },
          ...overrides,
        },
      ],
    },
  });
}

describe("classifyLarkOutgoingMutation", () => {
  it("accepts shortcut, native, and raw send/reply and rejects reads, dry-run, and other mutations", () => {
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--text", "hi"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["im", "+messages-reply", "--message-id", "om_1"])).toBe("reply");
    expect(classifyLarkOutgoingMutation(["im", "messages", "create"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["im", "messages", "reply"])).toBe("reply");
    expect(classifyLarkOutgoingMutation(["api", "POST", "/open-apis/im/v1/messages"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["api", "POST", "/open-apis/im/v1/messages/om_1/reply"])).toBe("reply");
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--dry-run"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--dry-run=false"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--text", "--dry-run"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--dry-run", "--dry-run=0"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["im", "+messages-send", "--dry-run=true"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["api", "GET", "/open-apis/im/v1/messages/om_1"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "messages", "list"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "+messages-mget"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "send", "hello"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["api", "POST", "/open-apis/im/v1/messages/mget"])).toBeUndefined();
  });

  it("normalizes absolute, relative, and trailing-slash raw API paths", () => {
    expect(classifyLarkOutgoingMutation(["api", "POST", "https://open.feishu.cn/open-apis/im/v1/messages"])).toBe(
      "send",
    );
    expect(classifyLarkOutgoingMutation(["api", "POST", "im/v1/messages"])).toBe("send");
    expect(classifyLarkOutgoingMutation(["api", "POST", "/open-apis/im/v1/messages/"])).toBe("send");
    expect(
      classifyLarkOutgoingMutation(["api", "POST", "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply"]),
    ).toBe("reply");
  });
});

describe("parseLarkCliSuccessEnvelope", () => {
  it("rejects non-success envelopes and recovers the last JSON object from noisy stdout", () => {
    expect(parseLarkCliSuccessEnvelope(Buffer.from("not-json\n"))).toBeUndefined();
    expect(parseLarkCliSuccessEnvelope(Buffer.from(JSON.stringify({ ok: false, identity: "bot" })))).toBeUndefined();
    expect(
      parseLarkCliSuccessEnvelope(
        'update available\n{"ok":false,"identity":"bot"}\n{"ok":true,"identity":"bot","data":{"message_id":"om_log"}}\n',
      ),
    ).toEqual({ ok: true, identity: "bot", data: { message_id: "om_log" } });
  });
});

describe("withOutgoingReplyInflight", () => {
  it("runs the turn unchanged when capture is disabled or the inflight marker cannot start", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const disabled = vi.fn(async () => "ran-disabled");
    await expect(
      withOutgoingReplyInflight({
        plansRoot: layout.plans,
        planPath: prepared.planPath,
        runId: "run-1",
        enabled: false,
        run: disabled,
      }),
    ).resolves.toBe("ran-disabled");
    expect(disabled).toHaveBeenCalledTimes(1);

    // A non-directory inflight path fails the marker write; the turn still runs, but the
    // run is permanently marked unavailable instead of silently complete-zero.
    const runDir = join(prepared.sessionDir, "runs", deriveProviderCliRunKey("run-1"));
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "inflight"), "not a directory\n");
    const enabled = vi.fn(async () => "ran-enabled");
    await expect(
      withOutgoingReplyInflight({
        plansRoot: layout.plans,
        planPath: prepared.planPath,
        runId: "run-1",
        enabled: true,
        run: enabled,
      }),
    ).resolves.toBe("ran-enabled");
    expect(enabled).toHaveBeenCalledTimes(1);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected).toEqual({ status: "unavailable", receipts: [] });
  });
});

describe("postToPlainText", () => {
  it("keeps a direct native post body readable and preserves blank lines", () => {
    expect(postToPlainText({ title: "Actual title", content: [[{ tag: "text", text: "Actual body" }]] })).toBe(
      "Actual title\nActual body",
    );
    expect(
      postToPlainText({ zh_cn: { content: [[{ tag: "text", text: "one" }], [], [{ tag: "text", text: "two" }]] } }),
    ).toBe("one\n\ntwo");
  });
});

describe("spawnCapturedProcess", () => {
  it("drains stdout after the child exits while a descendant still holds the pipe", async () => {
    const descendant = 'setTimeout(()=>process.stdout.write("accepted receipt\\n"),80)';
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,'ignore']}).unref();process.exit(0)`;
    const result = await spawnCapturedProcess({
      file: process.execPath,
      args: ["-e", parent],
      env: process.env,
      timeoutMs: 1000,
      maxBytes: 1024,
      forward: false,
    });
    expect(result.stdout.toString()).toBe("accepted receipt\n");
  });
});

describe("Provider CLI outgoing reply capture", () => {
  it("forwards stdout and exit code while recording the provider body instead of argv", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const code = await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "argv body that must not be used"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
        OPENTAG_TEST_LARK_REQUIRE_BOT_JSON: "1",
      },
      plansRoot: layout.plans,
    });
    expect(code).toBe(0);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.status).toBe("complete");
    expect(collected.receipts).toHaveLength(1);
    expect(collected.receipts[0]?.messageId).toBe("om_sent");
    expect(collected.receipts[0]?.content?.text).toBe("actual provider body");
    expect(JSON.stringify(collected.receipts)).not.toContain("argv body");
  });

  it("does not invent a send from reads, dry-run, failed exit, or user identity", async () => {
    const cases: Array<{ argv: string[]; envelope?: string; exit?: string }> = [
      { argv: ["api", "GET", "/open-apis/im/v1/messages/om_sent"], envelope: sendEnvelope() },
      { argv: ["im", "+messages-send", "--dry-run"], envelope: sendEnvelope({}) },
      {
        argv: ["im", "+messages-send", "--text", "x"],
        envelope: JSON.stringify({
          ok: true,
          identity: "bot",
          dry_run: true,
          data: { message_id: "om_sent", chat_id: "oc_chat" },
        }),
      },
      { argv: ["im", "+messages-send", "--text", "x"], envelope: sendEnvelope(), exit: "2" },
      {
        argv: ["im", "+messages-send", "--text", "x"],
        envelope: JSON.stringify({ ok: true, identity: "user", data: { message_id: "om_sent", chat_id: "oc_chat" } }),
      },
      {
        argv: ["im", "+messages-send", "--text", "x"],
        envelope: JSON.stringify({ ok: false, data: { message_id: "om_sent", chat_id: "oc_chat" } }),
      },
    ];
    for (const testCase of cases) {
      const { accountHome, layout, manager } = await trackedHarness();
      const target = await installTurnTarget(join(accountHome, "bin"));
      await writeExternalTurnSelection(layout, "feishu", target);
      const prepared = await manager.prepare({
        provider: "feishu",
        captureOutgoingReplies: true,
        sessionId: "s-1",
        runId: "run-1",
      });
      await executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: testCase.argv,
        env: {
          ...process.env,
          OPENTAG_TEST_TARGET_MODE: "lark-cli",
          OPENTAG_TEST_LARK_ENVELOPE: testCase.envelope ?? sendEnvelope(),
          OPENTAG_TEST_TARGET_EXIT: testCase.exit ?? "0",
        },
        plansRoot: layout.plans,
      });
      const collected = await collectOutgoingReplyReceipts({
        plansRoot: layout.plans,
        sessionDir: prepared.sessionDir,
        runId: "run-1",
        waitMs: 0,
      });
      expect(collected.receipts, testCase.argv.join(" ")).toEqual([]);
    }
  });

  it("marks malformed successful-send stdout incomplete instead of complete-zero", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    let code = 1;
    // Empty stdout, non-JSON stdout, and a success envelope whose payload carries no message
    // identity all mean the same thing: no accepted send can be reported.
    for (const envelope of ["", "not-json", JSON.stringify({ ok: true, identity: "bot", data: {} })]) {
      code = await executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: ["im", "+messages-send", "--text", "x"],
        env: { ...process.env, OPENTAG_TEST_TARGET_MODE: "lark-cli", OPENTAG_TEST_LARK_ENVELOPE: envelope },
        plansRoot: layout.plans,
      });
    }
    expect(code).toBe(0);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts).toEqual([]);
    expect(collected.status).toBe("incomplete");
  });

  it("keeps send success when the follow-up content read fails or times out", async () => {
    for (const getEnv of [{ OPENTAG_TEST_LARK_GET_EXIT: "1" }, { OPENTAG_TEST_LARK_GET_HANG: "1" }]) {
      const { accountHome, layout, manager } = await trackedHarness();
      const target = await installTurnTarget(join(accountHome, "bin"));
      await writeExternalTurnSelection(layout, "feishu", target);
      const prepared = await manager.prepare({
        provider: "feishu",
        captureOutgoingReplies: true,
        sessionId: "s-1",
        runId: "run-1",
      });
      const code = await executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: ["im", "+messages-reply", "--message-id", "om_root", "--text", "hi"],
        env: {
          ...process.env,
          OPENTAG_TEST_TARGET_MODE: "lark-cli",
          OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
          ...getEnv,
        },
        plansRoot: layout.plans,
      });
      expect(code).toBe(0);
      const collected = await collectOutgoingReplyReceipts({
        plansRoot: layout.plans,
        sessionDir: prepared.sessionDir,
        runId: "run-1",
        waitMs: 0,
      });
      expect(collected.receipts[0]?.messageId).toBe("om_sent");
      expect(collected.receipts[0]?.contentStatus).not.toBe("available");
    }
  });

  it("does not treat a user sender as the bound bot", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({ sender: { id: "ou_user", sender_type: "user" } }),
      },
      plansRoot: layout.plans,
    });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts[0]?.messageId).toBe("om_sent");
    expect(collected.receipts[0]?.contentStatus).toBe("unavailable");
  });

  it("preserves send order when the first content read is slower", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const first = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const one = executeProviderCliTurnPlan({
      planPath: first.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--chat-id", "oc_chat", "--text", "one"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope({ message_id: "om_one", create_time: "1000" }),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({
          message_id: "om_one",
          create_time: "1000",
          body: { content: JSON.stringify({ text: "one" }) },
        }),
        OPENTAG_TEST_LARK_GET_DELAY_om_one: "400",
      },
      plansRoot: layout.plans,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const two = executeProviderCliTurnPlan({
      planPath: first.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--chat-id", "oc_chat", "--text", "two"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope({ message_id: "om_two", create_time: "2000" }),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({
          message_id: "om_two",
          create_time: "2000",
          body: { content: JSON.stringify({ text: "two" }) },
        }),
      },
      plansRoot: layout.plans,
    });
    await Promise.all([one, two]);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: first.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts.map((receipt) => receipt.messageId)).toEqual(["om_one", "om_two"]);
  });

  it("isolates a late completing run from a successor collection", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const first = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const late = executeProviderCliTurnPlan({
      planPath: first.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "late"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope({ message_id: "om_late", create_time: "1000" }),
        OPENTAG_TEST_LARK_GET_HANG_om_late: "1",
      },
      plansRoot: layout.plans,
    });
    await expect
      .poll(
        async () => {
          const current = await collectOutgoingReplyReceipts({
            plansRoot: layout.plans,
            sessionDir: first.sessionDir,
            runId: "run-1",
            waitMs: 0,
          });
          return current.receipts.some((receipt) => receipt.messageId === "om_late");
        },
        { timeout: 3_000 },
      )
      .toBe(true);
    await manager.cleanup({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const second = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-2",
    });
    await executeProviderCliTurnPlan({
      planPath: second.planPath,
      provider: "feishu",
      runId: "run-2",
      argv: ["im", "+messages-send", "--text", "successor"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope({ message_id: "om_successor", create_time: "2000" }),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({ message_id: "om_successor" }),
      },
      plansRoot: layout.plans,
    });
    const successor = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: second.sessionDir,
      runId: "run-2",
      waitMs: 0,
    });
    expect(successor.receipts.map((receipt) => receipt.messageId)).toEqual(["om_successor"]);
    expect(successor.receipts.map((receipt) => receipt.messageId)).not.toContain("om_late");
    await late;
    const afterLate = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: second.sessionDir,
      runId: "run-2",
      waitMs: 0,
    });
    expect(afterLate.receipts.map((receipt) => receipt.messageId)).toEqual(["om_successor"]);
  });

  it("refuses cleanup through a symlinked runs parent", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
      },
      plansRoot: layout.plans,
    });
    const outside = join(accountHome, "outside-runs");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    const runsDir = join(prepared.sessionDir, "runs");
    await rm(runsDir, { recursive: true, force: true });
    await symlink(outside, runsDir);
    await cleanupOutgoingReplyRun({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
    });
    const { stat } = await import("node:fs/promises");
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it("keeps surviving receipts when one record is corrupt", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
      },
      plansRoot: layout.plans,
    });
    const receiptsDir = join(prepared.sessionDir, "runs");
    const { readdir } = await import("node:fs/promises");
    const runDirs = await readdir(receiptsDir);
    const outgoing = join(receiptsDir, runDirs[0] ?? "", "outgoing-replies");
    await writeFile(join(outgoing, "zzzz-corrupt.json"), "{not-json}\n", { mode: 0o600 });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts.some((receipt) => receipt.messageId === "om_sent")).toBe(true);
    expect(collected.status).toBe("incomplete");
  });

  it("cleans only the originating run receipts", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["api", "POST", "/open-apis/im/v1/messages"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope({
          msg_type: "text",
          body: { content: JSON.stringify({ text: "native body" }) },
        }),
      },
      plansRoot: layout.plans,
    });
    await cleanupOutgoingReplyRun({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
    });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts).toEqual([]);
  });

  it("marks classified successful-send stdout without the 1.0.92 envelope as incomplete", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const legacy = JSON.stringify({ message_id: "om_legacy", chat_id: "oc_chat", create_time: "1000" });
    const missingIdentity = JSON.stringify({
      ok: true,
      data: { message_id: "om_noid", chat_id: "oc_chat", create_time: "1000" },
    });
    const unusableData = JSON.stringify({ ok: true, identity: "bot", data: null });
    for (const envelope of [legacy, missingIdentity, unusableData]) {
      await executeProviderCliTurnPlan({
        planPath: prepared.planPath,
        provider: "feishu",
        runId: "run-1",
        argv: ["im", "+messages-send", "--text", "hi"],
        env: { ...process.env, OPENTAG_TEST_TARGET_MODE: "lark-cli", OPENTAG_TEST_LARK_ENVELOPE: envelope },
        plansRoot: layout.plans,
      });
    }
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.status).toBe("incomplete");
    expect(collected.receipts).toEqual([]);
  });

  it("ignores known-failed envelopes instead of marking capture incomplete", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: JSON.stringify({ ok: false, identity: "bot", msg: "denied" }),
      },
      plansRoot: layout.plans,
    });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.status).toBe("complete");
    expect(collected.receipts).toEqual([]);
  });

  it("derives the managed argument prefix from the launcher argv", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const userArgv = ["im", "+messages-send", "--text", "hi"];
    const env = {
      ...process.env,
      OPENTAG_TEST_TARGET_MODE: "lark-cli",
      OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
      OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
    };
    const base = {
      plan: prepared.plan,
      planPath: prepared.planPath,
      plansRoot: layout.plans,
      userArgv,
      env,
      code: 0,
      stdout: Buffer.from(sendEnvelope()),
    };
    // The launcher argv ends with the caller argv: the managed prefix is trimmed away.
    await expect(captureFeishuOutgoingReply({ ...base, spawnArgs: userArgv })).resolves.toBe("recorded");
    // The launcher argv does not end with the caller argv: the prefix is dropped entirely.
    await expect(
      captureFeishuOutgoingReply({ ...base, spawnArgs: ["--skip-update", "im", "+messages-send"] }),
    ).resolves.toBe("recorded");
  });

  it("fails closed when the receipt cannot be written at all", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const argv = ["im", "+messages-send", "--text", "hi"];
    // A plans root that does not contain the Session cannot accept a receipt: the write is
    // refused and capture must report incomplete rather than claim a complete empty run.
    await expect(
      captureFeishuOutgoingReply({
        plan: prepared.plan,
        planPath: prepared.planPath,
        plansRoot: join(accountHome, "detached-plans"),
        userArgv: argv,
        spawnArgs: argv,
        env: process.env,
        code: 0,
        stdout: Buffer.from(sendEnvelope()),
      }),
    ).resolves.toBe("incomplete");
  });

  it("keeps the send recorded when the enriched receipt cannot be rewritten", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    const receiptsDir = join(prepared.sessionDir, "runs", deriveProviderCliRunKey("run-1"), "outgoing-replies");
    const argv = ["im", "+messages-send", "--text", "hi"];
    const captured = captureFeishuOutgoingReply({
      plan: prepared.plan,
      planPath: prepared.planPath,
      plansRoot: layout.plans,
      userArgv: argv,
      spawnArgs: argv,
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
        OPENTAG_TEST_LARK_GET_DELAY_om_sent: "1000",
      },
      code: 0,
      stdout: Buffer.from(sendEnvelope()),
    });
    // The accepted receipt is durable first; break the directory while the content read is
    // still in flight so the enrichment rewrite is the write that fails.
    await expect
      .poll(async () => (await readdir(receiptsDir).catch(() => [])).length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    await rm(receiptsDir, { recursive: true, force: true });
    await writeFile(receiptsDir, "not a directory\n");
    await expect(captured).resolves.toBe("recorded");
    const statusPath = join(prepared.sessionDir, "runs", deriveProviderCliRunKey("run-1"), "capture-status.json");
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toEqual({ schemaVersion: 1, status: "incomplete" });
  });

  it("marks a send incomplete when the content read cannot be parsed", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: "no-json-envelope",
      },
      plansRoot: layout.plans,
    });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts[0]?.messageId).toBe("om_sent");
    expect(collected.receipts[0]?.contentStatus).toBe("unavailable");
    expect(collected.receipts[0]?.content?.text).toBeUndefined();
  });

  it("discards content read for a different message identity", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({
      provider: "feishu",
      captureOutgoingReplies: true,
      sessionId: "s-1",
      runId: "run-1",
    });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({ message_id: "om_other" }),
      },
      plansRoot: layout.plans,
    });
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.receipts[0]?.messageId).toBe("om_sent");
    expect(collected.receipts[0]?.contentStatus).toBe("unavailable");
    expect(collected.receipts[0]?.content?.text).toBeUndefined();
    expect(collected.receipts[0]?.threadId).toBeUndefined();
  });

  it("does not persist receipts unless captureOutgoingReplies is true", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    expect(prepared.plan.captureOutgoingReplies).toBeUndefined();
    const code = await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope(),
      },
      plansRoot: layout.plans,
    });
    expect(code).toBe(0);
    const collected = await collectOutgoingReplyReceipts({
      plansRoot: layout.plans,
      sessionDir: prepared.sessionDir,
      runId: "run-1",
      waitMs: 0,
    });
    expect(collected.status).toBe("complete");
    expect(collected.receipts).toEqual([]);
  });
});
