import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import type { FeishuCardKit } from "../src/channels/feishu-stream-reply.js";
import type { CodexRunnerInput } from "../src/codex/app-server-runner.js";
import { CodexRunError } from "../src/codex/run-lifecycle.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

type Step = {
  kind: string;
  at: number;
  messageId?: string;
  emoji?: string;
  reactionId?: string;
};

type RunInput = Pick<CodexRunnerInput, "prompt" | "onExecutionStarted" | "onActivity" | "onFinalAnswerDelta" | "onProgress">;
type RunResult = { raw: string; text: string; threadId?: string };
type MessageResult = { code: number; data?: { message_id: string } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function message(id: string, options: { actor?: string; chat?: string; image?: boolean; text?: string } = {}) {
  return {
    sender: { sender_id: { open_id: options.actor ?? "ou_allowed" }, sender_type: "user" },
    message: {
      message_id: id,
      chat_id: options.chat ?? "oc_test",
      message_type: options.image ? "image" : "text",
      content: JSON.stringify(options.image ? { image_key: "img_test" } : { text: options.text ?? `ordinary message ${id}` })
    }
  };
}

function createFixture(t: TestContext, options: {
  reactions?: boolean;
  progressCards?: boolean;
  streamingReplies?: boolean;
  cardKit?: FeishuCardKit;
  classify?: () => Promise<void>;
  run?: (input: RunInput) => Promise<RunResult>;
  send?: () => Promise<MessageResult>;
  download?: () => Promise<void>;
  reactionCode?: (emoji: string) => number;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feishu-feedback-"));
  const paths = resolveStatePaths(path.join(root, "state"));
  const store = new RuntimeStateStore(paths);
  const project = store.createProject("Feedback test", root);
  store.activateProject("oc_test", project.id);
  const steps: Step[] = [];
  const errors: unknown[] = [];
  const record = (kind: string, detail: Omit<Step, "kind" | "at"> = {}) => {
    steps.push({ kind, at: performance.now(), ...detail });
  };
  let dispatcher: { handles: Map<string, (event: unknown) => Promise<unknown>> } | undefined;
  const adapter = new FeishuChannelAdapter({
    channel: "feishu",
    accountId: "feishu-test",
    appId: "cli_test",
    appSecret: "secret",
    savedAt: "2026-11-25T00:00:00.000Z",
    enabled: true
  }, {
    inboundDir: paths.inboundDir,
    feishuReactions: options.reactions,
    feishuProgressCards: options.progressCards,
    feishuStreamingReplies: options.streamingReplies,
    apiClient: {
      ...(options.cardKit ? { cardkit: { v1: options.cardKit } } : {}),
      im: { v1: {
        image: { async create() { return { image_key: "unused" }; } },
        message: {
          async create() {
            record("send-request");
            const result = await (options.send?.() ?? Promise.resolve({ code: 0, data: { message_id: "outbound" } }));
            record("send-response");
            return result;
          },
          async reply(input: { path: { message_id: string } }) {
            record("card-reply", { messageId: input.path.message_id });
            return { code: 0, data: { message_id: "card-outbound" } };
          },
          async patch() {
            record("card-patch");
            return { code: 0 };
          }
        },
        messageResource: {
          async get() {
            record("download-request");
            await options.download?.();
            record("download-response");
            return { async writeFile(filePath: string) { fs.writeFileSync(filePath, "image bytes"); } };
          }
        },
        messageReaction: {
          async create(input: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }) {
            const messageId = input.path.message_id;
            const emoji = input.data.reaction_type.emoji_type;
            const reactionId = `reaction-${messageId}-${emoji}`;
            record("reaction-request", { messageId, emoji, reactionId });
            const code = options.reactionCode?.(emoji) ?? 0;
            if (code) return { code };
            await Promise.resolve();
            record("reaction-response", { messageId, emoji, reactionId });
            return { code: 0, data: { reaction_id: reactionId } };
          },
          async delete(input: { path: { message_id: string; reaction_id: string } }) {
            record("reaction-delete", { messageId: input.path.message_id, reactionId: input.path.reaction_id });
            return { code: 0 };
          }
        }
      } }
    } as never,
    wsClient: {
      async start(input) { dispatcher = input.eventDispatcher as typeof dispatcher; },
      close() {}
    }
  });
  const service = new BridgeService({
    config: {
      ...defaultConfig(root),
      allowedSenderIds: ["ou_allowed"],
      feishuProgressCards: options.progressCards ?? true,
      feishuStreamingReplies: options.streamingReplies ?? false
    },
    stateStore: store,
    weixin: adapter.client,
    inboundDir: paths.inboundDir,
    ...(options.classify ? {
      intentResolver: {
        async resolve() {
          record("classify-start");
          await options.classify?.();
          record("classify-end");
          return undefined;
        }
      }
    } : {}),
    runner: {
      async run(input: RunInput) {
        record("runner-invoked");
        const wrapped = {
          ...input,
          onExecutionStarted: () => {
            record("execution-start");
            input.onExecutionStarted?.();
          }
        };
        if (options.run) return options.run(wrapped);
        wrapped.onExecutionStarted();
        return { raw: "", text: "answer" };
      },
      async stop() {}
    } as never
  });
  const controller = new AbortController();
  const monitor = adapter.monitor({
    signal: controller.signal,
    claimMessage: (incoming) => store.claimProcessedMessage(incoming.id),
    isMessageAllowed: (incoming) => service.isMessageAllowed(incoming),
    onMessage: (incoming) => service.handleMessage(incoming),
    onMessageError: (error) => { errors.push(error); }
  });
  t.after(async () => {
    controller.abort();
    await monitor;
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.ok(dispatcher);
  const handler = dispatcher.handles.get("im.message.receive_v1");
  assert.ok(handler);
  return {
    store,
    steps,
    errors,
    dispatch: (event: ReturnType<typeof message>) => handler(event),
    stop: () => { controller.abort(); return monitor; },
    has: (kind: string, messageId?: string, emoji?: string) => steps.some((step) =>
      step.kind === kind && (!messageId || step.messageId === messageId) && (!emoji || step.emoji === emoji))
  };
}

test("acknowledges a direct message before classification and marks success only after delivery", async (t) => {
  const classification = deferred<void>();
  const run = deferred<RunResult>();
  const send = deferred<MessageResult>();
  const fixture = createFixture(t, {
    classify: () => classification.promise,
    run: async (input) => { input.onExecutionStarted?.(); return run.promise; },
    send: () => send.promise
  });
  const startedAt = performance.now();
  const handling = fixture.dispatch(message("om_text"));
  await waitFor(() => fixture.has("classify-start") && fixture.has("reaction-response", "om_text", "Get"), "Get and classification");
  const getRequest = fixture.steps.find((step) => step.kind === "reaction-request" && step.emoji === "Get")!;
  const getResponse = fixture.steps.find((step) => step.kind === "reaction-response" && step.emoji === "Get")!;
  const classificationStart = fixture.steps.find((step) => step.kind === "classify-start")!;
  t.diagnostic(`mocked event to Get API request: ${(getRequest.at - startedAt).toFixed(1)} ms; to API response: ${(getResponse.at - startedAt).toFixed(1)} ms`);
  assert.ok(getRequest.at <= classificationStart.at);
  assert.ok(getResponse.at - startedAt < 1_000);
  assert.equal(fixture.has("runner-invoked"), false);
  assert.equal(fixture.has("reaction-request", "om_text", "Typing"), false);

  classification.resolve();
  await waitFor(() => fixture.has("reaction-response", "om_text", "Typing"), "execution start");
  run.resolve({ raw: "", text: "answer" });
  await waitFor(() => fixture.has("send-request"), "final send request");
  assert.equal(fixture.has("reaction-request", "om_text", "DONE"), false);
  assert.equal(fixture.has("reaction-delete", "om_text"), false);
  send.resolve({ code: 0, data: { message_id: "outbound" } });
  await handling;
  await waitFor(() => fixture.has("reaction-response", "om_text", "DONE"), "DONE reaction");
  const sendResponse = fixture.steps.findIndex((step) => step.kind === "send-response");
  const deletion = fixture.steps.findIndex((step) => step.kind === "reaction-delete");
  const done = fixture.steps.findIndex((step) => step.kind === "reaction-request" && step.emoji === "DONE");
  assert.ok(sendResponse < deletion && deletion < done);
  assert.equal(fixture.steps[deletion].reactionId, "reaction-om_text-Typing");
  assert.deepEqual(fixture.errors, []);
});

test("routes exact Feishu new-session text without using the classifier or runner", async (t) => {
  const fixture = createFixture(t, { classify: async () => {} });
  await fixture.dispatch(message("om_new_session", { text: " 新建会话 " }));

  const session = fixture.store.getActiveSession("oc_test");
  assert.ok(session);
  assert.equal(session.projectId, fixture.store.getActiveProject("oc_test")?.id);
  assert.equal(session.threadId, undefined);
  assert.equal(fixture.has("classify-start"), false);
  assert.equal(fixture.has("runner-invoked"), false);
  assert.equal(fixture.has("send-response"), true);

  await fixture.dispatch(message("om_question", { text: "如何新建会话？" }));

  assert.equal(fixture.has("classify-start"), true);
  assert.equal(fixture.has("runner-invoked"), true);
  assert.equal(fixture.store.getActiveSession("oc_test")?.id, session.id);
  assert.deepEqual(fixture.errors, []);
});

test("acknowledges an image while its resource download is still blocked", async (t) => {
  const download = deferred<void>();
  const fixture = createFixture(t, { download: () => download.promise });
  const startedAt = performance.now();
  const handling = fixture.dispatch(message("om_image", { image: true }));
  await waitFor(() => fixture.has("download-request") && fixture.has("reaction-response", "om_image", "Get"), "Get before image download");
  const request = fixture.steps.find((step) => step.kind === "reaction-request" && step.emoji === "Get")!;
  const response = fixture.steps.find((step) => step.kind === "reaction-response" && step.emoji === "Get")!;
  t.diagnostic(`mocked image event to Get API request: ${(request.at - startedAt).toFixed(1)} ms; to API response: ${(response.at - startedAt).toFixed(1)} ms`);
  assert.ok(request.at < fixture.steps.find((step) => step.kind === "download-request")!.at);
  assert.ok(response.at - startedAt < 1_000);
  assert.equal(fixture.has("download-response"), false);
  assert.equal(fixture.has("runner-invoked"), false);
  download.resolve();
  await handling;
  await waitFor(() => fixture.has("reaction-response", "om_image", "DONE"), "image turn completion");
  assert.deepEqual(fixture.errors, []);
});

test("does not react to unauthorized messages or process duplicate deliveries", async (t) => {
  const run = deferred<RunResult>();
  const fixture = createFixture(t, { run: async (input) => { input.onExecutionStarted?.(); return run.promise; } });
  await fixture.dispatch(message("om_denied", { actor: "ou_denied", chat: "oc_denied" }));
  assert.equal(fixture.steps.some((step) => step.messageId === "om_denied"), false);
  assert.equal(fixture.has("runner-invoked"), false);

  const event = message("om_replay");
  const first = fixture.dispatch(event);
  await waitFor(() => fixture.has("reaction-response", "om_replay", "Typing"), "first execution");
  await fixture.dispatch(event);
  run.resolve({ raw: "", text: "answer" });
  await first;
  await waitFor(() => fixture.has("reaction-response", "om_replay", "DONE"), "first completion");
  await fixture.dispatch(event);
  assert.equal(fixture.steps.filter((step) => step.kind === "runner-invoked").length, 1);
  for (const emoji of ["Get", "Typing", "DONE"]) {
    assert.equal(fixture.steps.filter((step) => step.kind === "reaction-request" && step.messageId === "om_replay" && step.emoji === emoji).length, 1);
  }
});

test("keeps concurrent messages and Typing reaction identifiers separate", async (t) => {
  const firstRun = deferred<RunResult>();
  const secondRun = deferred<RunResult>();
  const fixture = createFixture(t, {
    run: async (input) => {
      input.onExecutionStarted?.();
      return input.prompt.includes("om_first") ? firstRun.promise : secondRun.promise;
    }
  });
  const first = fixture.dispatch(message("om_first"));
  const second = fixture.dispatch(message("om_second"));
  await waitFor(() => fixture.has("reaction-response", "om_first", "Typing") && fixture.has("reaction-response", "om_second", "Typing"), "both executions");
  secondRun.resolve({ raw: "", text: "second answer" });
  await second;
  await waitFor(() => fixture.has("reaction-response", "om_second", "DONE"), "second completion");
  assert.equal(fixture.has("reaction-request", "om_first", "DONE"), false);
  firstRun.resolve({ raw: "", text: "first answer" });
  await first;
  await waitFor(() => fixture.has("reaction-response", "om_first", "DONE"), "first completion");
  assert.deepEqual(fixture.steps.filter((step) => step.kind === "reaction-delete").map(({ messageId, reactionId }) => ({ messageId, reactionId })), [
    { messageId: "om_second", reactionId: "reaction-om_second-Typing" },
    { messageId: "om_first", reactionId: "reaction-om_first-Typing" }
  ]);
});

test("a Feishu nonzero send response is a failure and cannot produce DONE", async (t) => {
  const fixture = createFixture(t, { send: async () => ({ code: 12345 }) });
  await fixture.dispatch(message("om_send_fail"));
  await waitFor(() => fixture.has("reaction-response", "om_send_fail", "ERROR"), "send failure reaction");
  assert.equal(fixture.has("reaction-request", "om_send_fail", "DONE"), false);
  assert.equal(fixture.steps.find((step) => step.kind === "reaction-delete")?.reactionId, "reaction-om_send_fail-Typing");
  assert.equal(fixture.errors.length, 1);
});

for (const [name, error, emoji] of [
  ["cancelled", new CodexRunError("cancelled", "cancelled"), "CrossMark"],
  ["timed out", new CodexRunError("timed out", "timed_out"), "Alarm"],
  ["failed", new Error("runner failed"), "ERROR"]
] as const) {
  test(`reports ${name} execution with the correct terminal reaction`, async (t) => {
    const fixture = createFixture(t, { run: async (input) => { input.onExecutionStarted?.(); throw error; } });
    await fixture.dispatch(message("om_failure"));
    await waitFor(() => fixture.has("reaction-response", "om_failure", emoji), `${emoji} reaction`);
    assert.equal(fixture.has("reaction-request", "om_failure", "DONE"), false);
    assert.equal(fixture.steps.find((step) => step.kind === "reaction-delete")?.reactionId, "reaction-om_failure-Typing");
    assert.deepEqual(fixture.errors, [error]);
  });
}

test("disabled Feishu reactions leave ordinary message delivery working", async (t) => {
  const fixture = createFixture(t, { reactions: false });
  await fixture.dispatch(message("om_disabled"));
  assert.equal(fixture.has("send-response"), true);
  assert.equal(fixture.steps.some((step) => step.kind.startsWith("reaction-")), false);
  assert.deepEqual(fixture.errors, []);
});

test("a throttled reaction is retried independently from the task and reply", async (t) => {
  let throttled = false;
  const fixture = createFixture(t, {
    reactionCode: (emoji) => {
      if (emoji !== "Get" || throttled) return 0;
      throttled = true;
      return 99991400;
    }
  });
  await fixture.dispatch(message("om_throttled"));
  assert.ok(fixture.has("send-response"));
  await waitFor(() => fixture.has("reaction-response", "om_throttled", "Get"), "retried Get reaction");
  await waitFor(() => fixture.has("reaction-response", "om_throttled", "DONE"), "independent completion");
  const requests = fixture.steps.filter((step) => step.kind === "reaction-request" && step.emoji === "Get");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].at - requests[0].at >= 300);
});

test("monitor shutdown cleans up an active Typing reaction", async (t) => {
  const run = deferred<RunResult>();
  const fixture = createFixture(t, { run: async (input) => { input.onExecutionStarted?.(); return run.promise; } });
  const handling = fixture.dispatch(message("om_shutdown"));
  await waitFor(() => fixture.has("reaction-response", "om_shutdown", "Typing"), "active Typing reaction");
  await fixture.stop();
  assert.equal(fixture.steps.find((step) => step.kind === "reaction-delete")?.reactionId, "reaction-om_shutdown-Typing");
  assert.ok(fixture.has("reaction-response", "om_shutdown", "CrossMark"));
  run.resolve({ raw: "", text: "answer" });
  await handling;
  assert.equal(fixture.has("reaction-request", "om_shutdown", "DONE"), false);
});

test("streams the final reply without reactions or legacy commentary when enabled independently", async (t) => {
  const run = deferred<RunResult>();
  const updates: string[] = [];
  const fixture = createFixture(t, {
    reactions: false,
    progressCards: false,
    streamingReplies: true,
    cardKit: {
      card: {
        async create() { return { code: 0, data: { card_id: "card" } }; },
        async settings() { return { code: 0 }; }
      },
      cardElement: {
        async content(input) {
          if (input) updates.push(input.data.content);
          return { code: 0 };
        }
      }
    },
    run: async (input) => {
      input.onExecutionStarted?.();
      assert.equal(input.onActivity, undefined);
      assert.equal(input.onProgress, undefined);
      assert.ok(input.onFinalAnswerDelta);
      input.onFinalAnswerDelta("第一段。");
      return run.promise;
    }
  });

  const handling = fixture.dispatch(message("om_streamed"));
  await waitFor(() => fixture.has("card-reply", "om_streamed"), "streamed reply to the original message");
  run.resolve({ raw: "", text: "第一段。\n第二段。" });
  await handling;
  assert.deepEqual(updates, ["第一段。\n第二段。"]);
  assert.equal(fixture.has("send-request"), false);
  assert.equal(fixture.has("reaction-request"), false);
  assert.deepEqual(fixture.errors, []);
});
