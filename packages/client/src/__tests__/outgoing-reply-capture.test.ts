import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { executeProviderCliTurnPlan } from "../index.js";
import {
  classifyLarkOutgoingMutation,
  postToPlainText,
  spawnCapturedProcess,
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
    expect(classifyLarkOutgoingMutation(["api", "GET", "/open-apis/im/v1/messages/om_1"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "messages", "list"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "+messages-mget"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["im", "send", "hello"])).toBeUndefined();
    expect(classifyLarkOutgoingMutation(["api", "POST", "/open-apis/im/v1/messages/mget"])).toBeUndefined();
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
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
      const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    const code = await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "x"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: "not-json",
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
    expect(collected.receipts).toEqual([]);
    expect(collected.status).toBe("incomplete");
  });

  it("keeps send success when the follow-up content read fails or times out", async () => {
    for (const getEnv of [{ OPENTAG_TEST_LARK_GET_EXIT: "1" }, { OPENTAG_TEST_LARK_GET_HANG: "1" }]) {
      const { accountHome, layout, manager } = await trackedHarness();
      const target = await installTurnTarget(join(accountHome, "bin"));
      await writeExternalTurnSelection(layout, "feishu", target);
      const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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

  it("does not treat another app sender as the bound bot", async () => {
    const { accountHome, layout, manager } = await trackedHarness();
    const target = await installTurnTarget(join(accountHome, "bin"));
    await writeExternalTurnSelection(layout, "feishu", target);
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
    await executeProviderCliTurnPlan({
      planPath: prepared.planPath,
      provider: "feishu",
      runId: "run-1",
      argv: ["im", "+messages-send", "--text", "hi"],
      env: {
        ...process.env,
        OPENTAG_TEST_TARGET_MODE: "lark-cli",
        OPENTAG_TEST_LARK_ENVELOPE: sendEnvelope(),
        OPENTAG_TEST_LARK_GET_ENVELOPE: getEnvelope({ sender: { id: "ou_other_app", sender_type: "app" } }),
      },
      expectedSenderIds: ["ou_bot"],
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
    const first = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
    const first = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
    const second = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-2" });
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
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
    const prepared = await manager.prepare({ provider: "feishu", sessionId: "s-1", runId: "run-1" });
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
});
