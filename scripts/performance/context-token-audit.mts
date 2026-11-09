import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore-start lint/correctness/noUndeclaredDependencies: Standalone tooling resolves the public Shared export from source via scripts/tsconfig.scripts.json.
import {
  type AgentRuntimeProvider,
  computeRuntimeSnapshotHashes,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  runtimeUsageTotalTokens,
} from "@opentag/shared";
// biome-ignore-end lint/correctness/noUndeclaredDependencies: End the source-resolved tooling import.
import {
  createClaudeCodeBridgeIdentity,
  startClaudeCodeHostedToolBridge,
} from "../../packages/client/src/providers/claude-code/hosted-tool-bridge.js";
import { buildAgentInput } from "../../packages/client/src/runtime/agent-turn-runner.js";
import {
  type ManagedSessionContext,
  renderManagedSystemPrompt,
} from "../../packages/client/src/runtime/managed-instructions.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const sessionInstruction = "Preserve the user's files and report the checks actually performed.";
const snapshot: EffectiveRuntimeSnapshot = {
  agentId,
  provider: "pi",
  model: "synthetic-model",
  revision: { agent: { sequence: 1, id: "agent-v1" }, session: { sequence: 1, id: "session-v1" } },
  contextTrees: [],
  instructions: {
    platform: "OpenTag Agent slug: synthetic-agent",
    agent: "Help with the requested task.",
    session: sessionInstruction,
  },
  execution: { approvalPolicy: "never", networkAccess: true },
  workspace: { workspaceId: "synthetic-workspace", mode: "empty_on_create", sharing: "agent" },
  selfConfigurationEnabled: true,
};
const context: ManagedSessionContext = {
  environment: "local",
  sessionId,
  sessionKind: "visible",
  cliCommand: "opentag",
  sessionCliAvailable: true,
  selfConfigurationEnabled: true,
  agentHome: "/synthetic/agent-home",
  contextTree: { status: "unconfigured" },
};
const delivery: DirectImMessageDeliveryRequest = {
  type: "im:deliver",
  requestId: "synthetic-request",
  deliveryId: "synthetic-delivery",
  imMessageId: "synthetic-message",
  sessionId,
  agentId,
  placementGeneration: 1,
  attention: "direct",
  content: {
    kind: "text",
    text: "List the files in this task.",
    providerRef: {
      provider: "feishu",
      teamBrand: "feishu",
      appId: "synthetic-app",
      botOpenId: "synthetic-bot",
      chatId: "synthetic-chat",
      messageId: "synthetic-message",
    },
  },
  runtime: snapshot,
  deadlineAt: "2026-11-03T05:00:00.000Z",
};

function size(text: string) {
  return {
    utf8Bytes: Buffer.byteLength(text),
    utf16CodeUnits: text.length,
    roughEnglishTokens: Math.ceil(text.length / 4),
  };
}

function sections(prompt: string) {
  return prompt.split(/(?=^## )/m).map((text) => ({ section: text.split("\n")[0], ...size(text) }));
}

function prefix(left: string, right: string) {
  let offset = 0;
  while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset++;
  return { commonPrefixUtf16CodeUnits: offset, identical: left === right };
}

const localPromptTexts: string[] = [];
const prompts = (["claude-code", "codex", "pi"] as const).map((provider) => {
  const prompt = renderManagedSystemPrompt({ ...snapshot, provider }, context);
  localPromptTexts.push(prompt);
  assert.equal(prompt, renderManagedSystemPrompt({ ...snapshot, provider }, context));
  return { environment: "local", provider, ...size(prompt), sections: sections(prompt) };
});
const cloudContext: ManagedSessionContext = { ...context, environment: "cloud", agentHome: undefined };
const cloudPrompt = renderManagedSystemPrompt(snapshot, cloudContext);
prompts.push({ environment: "cloud", provider: "pi", ...size(cloudPrompt), sections: sections(cloudPrompt) });

const first = buildAgentInput(delivery, undefined, undefined, new Date("2026-11-03T04:00:00.000Z"));
const second = buildAgentInput(delivery, undefined, undefined, new Date("2026-11-03T04:01:00.000Z"));
const textOf = (input: typeof first) => input.items.map((item) => (item.type === "text" ? item.text : "")).join("\n");
const firstText = textOf(first);
const secondText = textOf(second);
assert.notEqual(firstText, secondText);
const systemAndInputBothContainSessionInstruction = [...localPromptTexts, cloudPrompt, firstText].every((text) =>
  text.includes(sessionInstruction),
);
assert.equal(systemAndInputBothContainSessionInstruction, true);
assert.equal(first.items.length, 2);
const revisedSnapshot = { ...snapshot, revision: { ...snapshot.revision, session: { sequence: 2, id: "session-v2" } } };
const localRevisionHashChanged =
  computeRuntimeSnapshotHashes(snapshot).effectiveSnapshotHash !==
  computeRuntimeSnapshotHashes(revisedSnapshot).effectiveSnapshotHash;
assert.equal(localRevisionHashChanged, true);

const ready = {
  status: "ready",
  treePath: "/synthetic/tree",
  projectPath: "/synthetic/project",
  branch: "main",
  sha: "a".repeat(40),
} as const;
const beforeTreeUpdate = renderManagedSystemPrompt(snapshot, { ...cloudContext, contextTree: ready });
const afterTreeUpdate = renderManagedSystemPrompt(snapshot, {
  ...cloudContext,
  contextTree: { ...ready, sha: "b".repeat(40) },
});
assert.notEqual(beforeTreeUpdate, afterTreeUpdate);

const scratch = await mkdtemp(join(tmpdir(), "opentag-context-token-audit-"));
let claudeNamespaceContinuity: {
  pluginIdentityStable: boolean;
  gatewayNamespaceStable: boolean;
  skillContentUnchanged: boolean;
  privatePathsChanged: boolean;
  differentRuntimeIdentityChanged: boolean;
};
try {
  const skill = join(scratch, "synthetic-skill");
  await mkdir(skill);
  const content =
    "---\nname: synthetic-skill\ndescription: Synthetic offline audit skill.\n---\nInspect only synthetic files.\n";
  await writeFile(join(skill, "SKILL.md"), content);
  const runtimeIdentity = createClaudeCodeBridgeIdentity();
  const open = (runId: string, identity = runtimeIdentity) =>
    startClaudeCodeHostedToolBridge(
      undefined,
      runId,
      new AbortController().signal,
      [skill],
      {
        url: "https://synthetic.invalid/api/v1/mcp",
        token: "synthetic-not-a-credential",
      },
      undefined,
      identity,
    );
  const bridges: Awaited<ReturnType<typeof open>>[] = [];
  try {
    bridges.push(await open("synthetic-turn-1"));
    bridges.push(await open("synthetic-turn-2"));
    bridges.push(await open("synthetic-other-runtime", createClaudeCodeBridgeIdentity()));
    const [a, b, other] = await Promise.all(
      bridges.map(async (bridge) => ({
        plugin: JSON.parse(await readFile(join(bridge.pluginPath, ".claude-plugin/plugin.json"), "utf8")).name,
        gateway: Object.keys(JSON.parse(await readFile(bridge.configPath, "utf8")).mcpServers)[0],
        skill: await readFile(join(bridge.pluginPath, "skills/synthetic-skill/SKILL.md"), "utf8"),
      })),
    );
    assert(a && b && other);
    claudeNamespaceContinuity = {
      pluginIdentityStable: a.plugin === b.plugin,
      gatewayNamespaceStable: a.gateway === b.gateway,
      skillContentUnchanged: a.skill === b.skill,
      privatePathsChanged: bridges[0]?.pluginPath !== bridges[1]?.pluginPath,
      differentRuntimeIdentityChanged: a.plugin !== other.plugin && a.gateway !== other.gateway,
    };
    assert.deepEqual(claudeNamespaceContinuity, {
      pluginIdentityStable: true,
      gatewayNamespaceStable: true,
      skillContentUnchanged: true,
      privatePathsChanged: true,
      differentRuntimeIdentityChanged: true,
    });
  } finally {
    await Promise.all(bridges.map((bridge) => bridge.close()));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 };
const usageExamples = (["codex", "claude-code", "pi"] satisfies AgentRuntimeProvider[]).map((provider) => ({
  provider,
  syntheticRuntimeUsage: usage,
  displayedTotalTokens: runtimeUsageTotalTokens(provider, usage),
}));
assert.deepEqual(
  usageExamples.map((row) => row.displayedTotalTokens),
  [1050, 1850, 1850],
);

process.stdout.write(
  `${JSON.stringify(
    {
      evidence: "SYNTHETIC_ONLY",
      tokenEstimate:
        "ceil(UTF-16 code units / 4), English-only sizing heuristic; not a model tokenizer, provider usage, billed tokens, or a context-window measurement",
      excludes: [
        "native provider base prompt",
        "real user instructions",
        "native project context",
        "Skill catalog",
        "MCP tool schemas",
        "native conversation history",
        "tool results",
        "images",
      ],
      managedPrompts: prompts,
      appendedInput: {
        items: first.items.map((item, index) => ({ index, ...(item.type === "text" ? size(item.text) : {}) })),
        clockOnlyChange: prefix(firstText, secondText),
        systemAndInputBothContainSessionInstruction,
      },
      cloudTreeCommitChange: prefix(beforeTreeUpdate, afterTreeUpdate),
      localRevisionHashChanged,
      claudeNamespaceContinuity,
      usageExamples,
    },
    null,
    2,
  )}\n`,
);
