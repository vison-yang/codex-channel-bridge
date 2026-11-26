import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AiChannelIntentResolver,
  createCodexChannelIntentResolver,
  type ChannelIntentResolver
} from "../src/bridge/ai-channel-intent.js";
import {
  AI_CHANNEL_INTENT_OUTPUT_SCHEMA,
  commandsFromAiChannelIntentOutput
} from "../src/bridge/ai-channel-intent-decision.js";
import type { ChannelCommandCapability } from "../src/bridge/channel-capability.js";
import { BridgeService } from "../src/bridge/service.js";
import type { EphemeralCodexRunnerInput } from "../src/codex/runner.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { saveAccount } from "../src/weixin/accounts.js";

const action = (intent: string, overrides: Record<string, unknown> = {}) => ({
  intent,
  confidence: 0.97,
  target: null,
  detail: null,
  ...overrides
});

const input = {
  text: "我当前有哪些任务",
  actorId: "alice",
  conversationId: "alice",
  conversationKind: "direct" as const,
  projectNames: ["Bridge"]
};

test("skips production AI classification in session and Q&A modes by default", async () => {
  let calls = 0;
  const resolver = createCodexChannelIntentResolver({
    runner: {
      async runEphemeral() {
        calls += 1;
        throw new Error("unexpected classifier call");
      }
    } as never,
    cwd: "/tmp/project"
  });

  for (const currentMode of [undefined, "session", "qa"] as const) {
    assert.equal(await resolver.resolve({ ...input, currentMode }), undefined);
  }
  assert.equal(calls, 0);
});

test("keeps natural-language task creation, listing, and actions in task mode", async () => {
  const calls: EphemeralCodexRunnerInput[] = [];
  const decisions = [
    action("task_new", { detail: "整理开发文档" }),
    action("task_list"),
    action("task_accept", { target: "BRIDGE-12" })
  ];
  const resolver = createCodexChannelIntentResolver({
    runner: {
      async runEphemeral(request: EphemeralCodexRunnerInput) {
        calls.push(request);
        return { raw: "", text: JSON.stringify({ schemaVersion: 2, kind: "actions", actions: [decisions[calls.length - 1]] }) };
      }
    } as never,
    cwd: "/tmp/project",
    model: "test-model"
  });

  const intents = [];
  for (const text of ["整理开发文档", "我当前有哪些任务", "验收 BRIDGE-12"]) {
    intents.push(await resolver.resolve({ ...input, text, currentMode: "task" }));
  }
  assert.deepEqual(intents, [
    { kind: "command", command: { name: "task", arg: "form new 整理开发文档" } },
    { kind: "command", command: { name: "task", arg: "list" } },
    { kind: "command", command: { name: "task", arg: "detail BRIDGE-12" } }
  ]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.cwd, "/tmp/project");
    assert.equal(call.model, "test-model");
    assert.equal(call.effort, "low");
    assert.ok(call.outputSchema);
    assert.equal((parseClassifierContext(call.prompt) as { currentMode: string }).currentMode, "task");
  }
});

test("restores production AI classification in every mode when enabled", async () => {
  const modes: unknown[] = [];
  const resolver = createCodexChannelIntentResolver({
    runner: {
      async runEphemeral(request: EphemeralCodexRunnerInput) {
        modes.push((parseClassifierContext(request.prompt) as { currentMode: unknown }).currentMode);
        return { raw: "", text: JSON.stringify({ schemaVersion: 2, kind: "actions", actions: [action("status")] }) };
      }
    } as never,
    cwd: "/tmp/project",
    channelChatIntentClassification: true
  });

  for (const currentMode of [undefined, "session", "qa", "task"] as const) {
    assert.deepEqual(await resolver.resolve({ ...input, currentMode }), {
      kind: "command",
      command: { name: "status", arg: "" }
    });
  }
  assert.deepEqual(modes, [null, "session", "qa", "task"]);
});

test("account startup passes the persisted classification setting to its resolver", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-intent-account-"));
  const paths = resolveStatePaths(root);
  saveConfig(paths, defaultConfig(root));
  saveAccount(paths, {
    accountId: "account-one",
    userId: "user-one",
    token: "token-one",
    baseUrl: "https://example.test",
    cdnBaseUrl: "https://cdn.example.test",
    savedAt: new Date().toISOString(),
    enabled: true
  });
  let activeResolver: ChannelIntentResolver | undefined;
  let calls = 0;
  const manager = new AccountManager({
    paths,
    bridgeFactory: (options) => {
      activeResolver = options.intentResolver;
      return { async handleMessage() {} } as never;
    },
    clientFactory: () => ({}) as never,
    monitor: async ({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    runnerFactory: () => ({
      async runEphemeral() {
        calls += 1;
        return { raw: "", text: JSON.stringify({ schemaVersion: 2, kind: "actions", actions: [action("status")] }) };
      },
      async warmUp() {},
      close() {}
    }) as never
  });
  t.after(async () => {
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await manager.startAccount("account-one", false);
  assert.ok(activeResolver);
  assert.equal(await activeResolver.resolve(input), undefined);
  assert.equal(calls, 0);

  saveConfig(paths, { ...loadConfig(paths), channelChatIntentClassification: true });
  await manager.refreshAccount("account-one");
  assert.ok(activeResolver);
  assert.deepEqual(await activeResolver.resolve(input), {
    kind: "command",
    command: { name: "status", arg: "" }
  });
  assert.equal(calls, 1);
});

test("ordinary messages reach a formal turn while slash, menu, and card commands keep their route", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-intent-fast-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const runs: string[] = [];
  const cards: string[] = [];
  const modes: unknown[] = [];
  const events: string[] = [];
  const runner = {
    async run(request: { prompt: string }) {
      events.push("turn");
      runs.push(request.prompt);
      return { raw: "", text: "完成", threadId: "thread-fast-path" };
    },
    async runEphemeral(request: EphemeralCodexRunnerInput) {
      events.push("classification");
      modes.push((parseClassifierContext(request.prompt) as { currentMode: unknown }).currentMode);
      return { raw: "", text: JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] }) };
    },
    async stop() {}
  };
  const options = {
    config: { ...defaultConfig(root), allowedSenderIds: ["alice", "bob"] },
    stateStore,
    runner: runner as never,
    intentResolver: createCodexChannelIntentResolver({ runner: runner as never, cwd: root }),
    weixin: {
      async sendTyping() {},
      async sendText() { return { messageId: "sent" }; },
      async sendActionCard(request: { card: { title: string } }) {
        cards.push(request.card.title);
        return { messageId: "card" };
      }
    } as never
  };
  const service = new BridgeService(options);
  const message = { senderId: "alice", attachments: [], raw: {} };

  await service.handleMessage({ ...message, id: "ordinary", text: "帮我解释这个问题" });
  await service.handleMessage({ ...message, id: "slash", text: "/help" });
  await service.handleMessage({ ...message, id: "menu", text: "/help", source: "native-menu" });
  await service.handleMessage({ ...message, id: "card", text: "/help", interaction: { kind: "card", messageId: "card" } });

  assert.equal(runs.length, 1);
  assert.match(runs[0] ?? "", /帮我解释这个问题/);
  assert.equal(cards.length, 3);
  assert.deepEqual(events, ["turn"]);

  const taskService = new BridgeService({
    ...options,
    modeSettings: { defaultMode: "task", enabledModes: ["session", "task", "qa"] }
  });
  assert.equal(stateStore.getActiveProject("bob"), undefined);
  await taskService.handleMessage({ ...message, id: "first-task", senderId: "bob", text: "讨论开发文档" });

  assert.deepEqual(modes, ["task"]);
  assert.deepEqual(events, ["turn", "classification", "turn"]);
  assert.match(runs[1] ?? "", /讨论开发文档/);
  assert.equal(stateStore.getInteractionMode("bob"), "task");
});

test("maps up to four actions in declared order", () => {
  const commands = commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "actions",
    actions: [
      action("project_switch", { target: "知识库项目" }),
      action("mode_task"),
      action("task_list"),
      action("goal_show")
    ]
  }));

  assert.deepEqual(commands, [
    { name: "project", arg: "switch 知识库项目" },
    { name: "mode", arg: "task" },
    { name: "task", arg: "list" },
    { name: "goal", arg: "" }
  ]);
});

test("rejects mixed low-confidence and oversized decisions without a partial prefix", () => {
  const validAction = action("status");
  const invalidOutputs = [
    { schemaVersion: 2, kind: "actions", actions: [validAction, action("ordinary_chat")] },
    { schemaVersion: 2, kind: "actions", actions: [validAction, action("task_list", { confidence: 0.79 })] },
    { schemaVersion: 2, kind: "actions", actions: Array.from({ length: 5 }, () => validAction) },
    { schemaVersion: 2, kind: "actions", actions: [] },
    { schemaVersion: 1, kind: "actions", actions: [validAction] },
    { schemaVersion: 2, kind: "actions", actions: [validAction], unexpected: true },
    { schemaVersion: 2, kind: "actions", actions: [action("project_switch", { target: "bad\nname" })] },
    { schemaVersion: 2, kind: "actions", actions: [action("task_new", { detail: "" })] },
    { schemaVersion: 2, kind: "actions", actions: [action("task_new", { detail: "x".repeat(2_001) })] }
  ];

  for (const output of invalidOutputs) {
    assert.equal(commandsFromAiChannelIntentOutput(JSON.stringify(output)), undefined);
  }
});

test("maps ordinary chat and malformed output to no commands", () => {
  assert.equal(commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "ordinary_chat",
    actions: []
  })), undefined);
  assert.equal(commandsFromAiChannelIntentOutput("not-json"), undefined);
});

test("ignores classifier arguments for extension actions that declare no argument", () => {
  const capability: ChannelCommandCapability = {
    id: "example",
    commandName: "example",
    aliases: {},
    helpLine: "/example - 示例",
    aiActions: [{
      intent: "example_status",
      operation: "status",
      guidance: "查看示例状态。",
      argument: "none"
    }],
    resolve: () => ({ kind: "reply", text: "unused" })
  };
  const commands = commandsFromAiChannelIntentOutput(JSON.stringify({
    schemaVersion: 2,
    kind: "actions",
    actions: [action("example_status", { target: "ignored", detail: "ignored" })]
  }), [capability]);

  assert.deepEqual(commands, [{ name: "example", arg: "status" }]);
});

test("uses a response-format-compatible schema without unsupported oneOf", () => {
  const serializedSchema = JSON.stringify(AI_CHANNEL_INTENT_OUTPUT_SCHEMA);
  assert.doesNotMatch(serializedSchema, /"oneOf"/);
});

test("includes actor and conversation identity in classifier context", async () => {
  const contexts: unknown[] = [];
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    contexts.push(parseClassifierContext(prompt));
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "我当前有哪些任务",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct",
    projectNames: ["Bridge"]
  });
  await resolver.resolve({
    text: "我先切到 Bridge，再看任务",
    actorId: "alice",
    conversationId: "chat-team",
    conversationKind: "shared",
    projectNames: ["Bridge"]
  });

  assert.deepEqual(contexts, [
    {
      message: "我当前有哪些任务",
      actor: { actorId: "alice", conversationId: "alice", conversationKind: "direct" },
      currentProject: null,
      currentMode: null,
      knowledgeBase: null,
      availableProjects: ["Bridge"]
    },
    {
      message: "我先切到 Bridge，再看任务",
      actor: { actorId: "alice", conversationId: "chat-team", conversationKind: "shared" },
      currentProject: null,
      currentMode: null,
      knowledgeBase: null,
      availableProjects: ["Bridge"]
    }
  ]);
});

test("instructs the AI to keep mode and goal product discussions in ordinary chat", async () => {
  let classifierPrompt = "";
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    classifierPrompt = prompt;
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "为什么会话模式默认进入目标，目标和计划也应该正常回复对话内容",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct",
    currentProjectName: "Bridge",
    projectNames: ["Bridge"]
  });

  assert.match(classifierPrompt, /讨论或质疑.*模式.*目标.*计划.*ordinary_chat/);
});

test("instructs the AI to create a task for concrete work assigned in task mode", async () => {
  let classifierPrompt = "";
  const resolver = new AiChannelIntentResolver(async (prompt) => {
    classifierPrompt = prompt;
    return JSON.stringify({ schemaVersion: 2, kind: "ordinary_chat", actions: [] });
  });

  await resolver.resolve({
    text: "相关开发文档和技术调研都移动到项目目录里",
    actorId: "ou_actor",
    conversationId: "oc_team",
    conversationKind: "shared",
    currentProjectName: "wx-claw",
    currentMode: "task",
    projectNames: ["wx-claw"]
  });

  assert.match(classifierPrompt, /当前模式为 task.*具体工作.*task_new/);
});

test("resolves one action compatibly and multiple actions as an ordered sequence", async () => {
  const outputs = [
    {
      schemaVersion: 2,
      kind: "actions",
      actions: [action("status")]
    },
    {
      schemaVersion: 2,
      kind: "actions",
      actions: [action("project_switch", { target: "Bridge" }), action("task_list")]
    }
  ];
  let outputIndex = 0;
  const resolver = new AiChannelIntentResolver(async () => JSON.stringify(outputs[outputIndex++]));
  const input = {
    text: "渠道操作",
    actorId: "alice",
    conversationId: "alice",
    conversationKind: "direct" as const,
    projectNames: ["Bridge"]
  };

  assert.deepEqual(await resolver.resolve(input), {
    kind: "command",
    command: { name: "status", arg: "" }
  });
  assert.deepEqual(await resolver.resolve(input), {
    kind: "command_sequence",
    commands: [
      { name: "project", arg: "switch Bridge" },
      { name: "task", arg: "list" }
    ]
  });
});

function parseClassifierContext(prompt: string): unknown {
  const lines = prompt.split("\n");
  const serializedContext = lines[lines.length - 1];
  assert.ok(serializedContext);
  const context: unknown = JSON.parse(serializedContext);
  return context;
}
