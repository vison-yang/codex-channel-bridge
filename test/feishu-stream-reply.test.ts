import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { FeishuFeedbackApi } from "../src/channels/feishu-feedback-api.js";
import { FeishuStreamReply, type FeishuCardKit } from "../src/channels/feishu-stream-reply.js";

type CardRequest = {
  data: { type: string; data: string };
};

type ContentRequest = {
  path: { card_id: string; element_id: string };
  data: { content: string; sequence: number; uuid: string };
};

type SettingsRequest = {
  path: { card_id: string };
  data: { settings: string; sequence: number; uuid: string };
};

type Call =
  | { kind: "create"; request: CardRequest }
  | { kind: "reply"; content: string }
  | { kind: "content"; request: ContentRequest }
  | { kind: "settings"; request: SettingsRequest };

type FixtureOptions = {
  failCreate?: boolean;
  failContent?: (attempt: number) => boolean;
  failSettings?: boolean;
  send?: () => Promise<string>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Call[] = [];
  let contentAttempts = 0;
  const cardKit = {
    card: {
      async create(request: CardRequest) {
        calls.push({ kind: "create", request });
        return options.failCreate ? { code: 12345 } : { code: 0, data: { card_id: "card-1" } };
      },
      async settings(request: SettingsRequest) {
        calls.push({ kind: "settings", request });
        return { code: options.failSettings ? 12345 : 0 };
      }
    },
    cardElement: {
      async content(request: ContentRequest) {
        calls.push({ kind: "content", request });
        contentAttempts++;
        return { code: options.failContent?.(contentAttempts) ? 12345 : 0 };
      }
    }
  } as unknown as FeishuCardKit;
  const stream = new FeishuStreamReply(cardKit, new FeishuFeedbackApi(), async (content) => {
    calls.push({ kind: "reply", content });
    return options.send ? options.send() : "om-reply";
  });
  return {
    calls,
    stream,
    async tick() {
      t.mock.timers.tick(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
}

function previews(calls: Call[]): string[] {
  return calls.flatMap((call) => {
    if (call.kind === "create") {
      const card = JSON.parse(call.request.data.data) as { body: { elements: Array<{ content: string }> } };
      return card.body.elements.map((element) => element.content);
    }
    return call.kind === "content" ? [call.request.data.content] : [];
  });
}

function settings(calls: Call[]): SettingsRequest[] {
  return calls.filter((call): call is Extract<Call, { kind: "settings" }> => call.kind === "settings")
    .map((call) => call.request);
}

test("creates a CardKit reply, publishes updates in order, and closes the final reply", async (t) => {
  const { stream, calls, tick } = fixture(t);
  stream.delta("Hello");
  await tick();
  assert.deepEqual(calls, []);

  stream.delta(", world.");
  await tick();
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply"]);
  const create = calls[0] as Extract<Call, { kind: "create" }>;
  assert.equal(create.request.data.type, "card_json");
  const card = JSON.parse(create.request.data.data);
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, true);
  assert.deepEqual(card.body.elements, [{ tag: "markdown", element_id: "codex_reply", content: "Hello, world." }]);
  const reply = calls[1] as Extract<Call, { kind: "reply" }>;
  assert.deepEqual(JSON.parse(reply.content), { type: "card", data: { card_id: "card-1" } });

  stream.delta(" Second sentence.");
  await tick();
  assert.equal(await stream.finish("Final <answer>."), "om-reply");
  await stream.settled();
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "content", "content", "settings"]);
  const updates = calls.filter((call): call is Extract<Call, { kind: "content" }> => call.kind === "content")
    .map((call) => call.request);
  assert.deepEqual(updates.map((request) => request.path), [
    { card_id: "card-1", element_id: "codex_reply" },
    { card_id: "card-1", element_id: "codex_reply" }
  ]);
  assert.deepEqual(updates.map((request) => request.data.content), ["Hello, world. Second sentence.", "Final &lt;answer&gt;."]);
  const [close] = settings(calls);
  assert.deepEqual(close.path, { card_id: "card-1" });
  assert.equal(JSON.parse(close.data.settings).config.streaming_mode, false);
  const operations = [...updates.map((request) => request.data), close.data];
  assert.deepEqual(operations.map((operation) => operation.sequence), [1, 2, 3]);
  assert.equal(new Set(operations.map((operation) => operation.uuid)).size, operations.length);
  assert.ok(operations.every((operation) => /^[0-9a-f-]{36}$/i.test(operation.uuid)));

  stream.delta(" late delta.");
  assert.equal(await stream.finish("A duplicate final reply."), "om-reply");
  await tick();
  assert.equal(calls.length, 5);
});

test("returns no card ID when no preview card exists, leaving final delivery to the caller", async (t) => {
  const { stream, calls, tick } = fixture(t);
  stream.delta("A still incomplete sentence");
  assert.equal(await stream.finish("The complete final answer."), undefined);
  await tick();
  assert.deepEqual(calls, []);
});

test("closes the preview and falls back for a final reply over the CardKit byte limit", async (t) => {
  const { stream, calls, tick } = fixture(t);
  stream.delta("A preview.");
  await tick();
  assert.equal(await stream.finish("答".repeat(4_001)), undefined);
  assert.equal(previews(calls).at(-1), "完整回复见后续消息。");
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
});

test("keeps an incomplete action block and its JSON out of all previews", async (t) => {
  const { stream, calls, tick } = fixture(t);
  stream.delta("文件已处理。\n");
  await tick();
  stream.delta("``");
  await tick();
  stream.delta("`codex-channel-bridge-actions\n{\"send\":[{\"type\":\"file\",\"path\":\"/private/report.pdf\"}]}\n");
  await tick();
  stream.delta("```");
  await tick();
  assert.ok(previews(calls).length > 0);
  assert.ok(previews(calls).every((text) => text === "文件已处理。"));
  assert.equal(await stream.finish("文件已处理。"), "om-reply");
});

for (const [name, first, second, privateParts] of [
  ["API key assignment", "api_key=sec", "ret-value.\n", ["sec", "ret-value"]],
  ["token prefix", "sk-part", ".remainder\n", ["sk-part", "remainder"]],
  ["Basic authorization", "Authorization: Basic dGVzdC4", "wYXNz\n", ["dGVzdC4", "wYXNz"]],
  ["natural language password", "password is hunter.", "two\n", ["hunter", "two"]]
] as const) {
  test(`does not publish a split ${name} in the preview`, async (t) => {
    const { stream, calls, tick } = fixture(t);
    stream.delta("公开内容。\n");
    await tick();
    stream.delta(first);
    await tick();
    stream.delta(second);
    await tick();
    const texts = previews(calls);
    assert.ok(texts.length > 0);
    for (const text of texts) {
      for (const part of privateParts) assert.equal(text.includes(part), false, `preview exposed ${part}: ${text}`);
    }
    assert.equal(await stream.finish("公开内容。"), "om-reply");
  });
}

test("falls back when card creation fails", async (t) => {
  const { stream, calls, tick } = fixture(t, { failCreate: true });
  stream.delta("A preview.");
  await tick();
  stream.delta(" Another preview.");
  await tick();
  assert.equal(await stream.finish("Final answer."), undefined);
  assert.deepEqual(calls.map((call) => call.kind), ["create"]);
});

test("closes the created card and falls back when sending its reply fails", async (t) => {
  const { stream, calls, tick } = fixture(t, { send: async () => { throw new Error("send failed"); } });
  stream.delta("A preview.");
  await tick();
  assert.equal(await stream.finish("Final answer."), undefined);
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "settings"]);
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
});

test("falls back and closes the card when the final content update fails", async (t) => {
  const { stream, calls, tick } = fixture(t, { failContent: () => true });
  stream.delta("A preview.");
  await tick();
  assert.equal(await stream.finish("Final answer."), undefined);
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "content", "settings"]);
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
});

test("uses the card if a failed preview update is followed by a successful final update", async (t) => {
  const { stream, calls, tick } = fixture(t, { failContent: (attempt) => attempt === 1 });
  stream.delta("A preview.");
  await tick();
  stream.delta(" More preview.");
  await tick();
  assert.equal(await stream.finish("Final answer."), "om-reply");
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "content", "content", "settings"]);
  assert.deepEqual(previews(calls), ["A preview.", "A preview. More preview.", "Final answer."]);
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
});

test("keeps the delivered card ID if closing the card fails after the final text is written", async (t) => {
  const { stream, calls, tick } = fixture(t, { failSettings: true });
  stream.delta("A preview.");
  await tick();
  assert.equal(await stream.finish("Final answer."), "om-reply");
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "content", "settings"]);
  assert.equal(previews(calls).at(-1), "Final answer.");
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
});

test("cancellation waits for an in-flight card reply, closes it, and ignores later deltas", async (t) => {
  const pendingSend = deferred<string>();
  const { stream, calls, tick } = fixture(t, { send: () => pendingSend.promise });
  stream.delta("A preview.");
  await tick();
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply"]);

  const completion = stream.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply"]);
  stream.delta(" a late delta.");
  pendingSend.resolve("om-reply");
  assert.equal(await completion, undefined);
  await stream.settled();
  assert.deepEqual(calls.map((call) => call.kind), ["create", "reply", "content", "settings"]);
  assert.equal(previews(calls).at(-1), "本次回复已停止。");
  assert.equal(JSON.parse(settings(calls)[0].data.settings).config.streaming_mode, false);
  await tick();
  assert.equal(calls.length, 4);
});
