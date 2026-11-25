import assert from "node:assert/strict";
import test from "node:test";

import type * as Lark from "@larksuiteoapi/node-sdk";

import { FeishuProgressCard } from "../src/channels/feishu-progress-card.js";
import type { ChannelTaskOutcome } from "../src/channels/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

class ManualClock {
  time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  now = () => this.time;

  schedule = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  };

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      this.time = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

type CardWrite = { kind: "send" | "update"; at: number; id?: string; card: Lark.InteractiveCard };

function fixture(options: {
  send?: (card: Lark.InteractiveCard) => Promise<string>;
  update?: (id: string, card: Lark.InteractiveCard) => Promise<void>;
} = {}) {
  const clock = new ManualClock();
  const writes: CardWrite[] = [];
  const progress = new FeishuProgressCard({
    async send(card) {
      writes.push({ kind: "send", at: clock.now(), card });
      return options.send?.(card) ?? "card-message";
    },
    async update(id, card) {
      writes.push({ kind: "update", at: clock.now(), id, card });
      await options.update?.(id, card);
    }
  }, clock);
  return { clock, writes, progress };
}

function text(card: Lark.InteractiveCard): string {
  return JSON.stringify(card);
}

test("does not create cards for queued or short tasks", async () => {
  const queued = fixture();
  queued.progress.activity({ id: "queued-secret", kind: "command", status: "running" });
  await queued.clock.advance(20_000);
  queued.progress.finish("cancelled");
  queued.progress.start();
  await queued.progress.settled();
  await queued.clock.advance(20_000);
  assert.equal(queued.writes.length, 0);

  const short = fixture();
  short.progress.start();
  await short.clock.advance(9_999);
  short.progress.finish("succeeded");
  await short.progress.settled();
  await short.clock.advance(20_000);
  assert.equal(short.writes.length, 0);
});

test("creates a curated v1 card at ten seconds without rendering identifiers or raw data", async () => {
  const { progress, clock, writes } = fixture();
  progress.start();
  progress.activity({ id: "secret-command --password", kind: "command", status: "running", raw: "/private/file" } as never);
  progress.activity({ id: "sensitive-file", kind: "file", status: "completed" });
  progress.activity({
    id: "sensitive-team", kind: "agent", status: "running", agents: [
      { id: "private-agent-id", status: "running" },
      { id: "private-agent-finished", status: "completed" }
    ]
  });
  await clock.advance(9_999);
  assert.equal(writes.length, 0);
  await clock.advance(1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].at, 10_000);
  assert.deepEqual(writes[0].card.config, { wide_screen_mode: true, update_multi: true });
  assert.equal(writes[0].card.header?.title.content, "任务进度");
  const content = text(writes[0].card);
  assert.match(content, /进行中/);
  assert.match(content, /10 秒/);
  assert.match(content, /命令执行/);
  assert.match(content, /文件处理/);
  assert.match(content, /子智能体：进行中 1 · 已完成 1/);
  for (const secret of ["secret-command", "password", "/private/file", "sensitive-file", "sensitive-team", "private-agent"]) {
    assert.equal(content.includes(secret), false);
  }
  progress.finish("cancelled");
  await clock.advance(5_000);
  await progress.settled();
});

test("coalesces activity updates, applies the same limit to the terminal update, and freezes elapsed time", async () => {
  const { progress, clock, writes } = fixture();
  progress.start();
  await clock.advance(10_000);
  progress.activity({ id: "same-command", kind: "command", status: "running" });
  progress.activity({ id: "same-command", kind: "command", status: "completed" });
  progress.activity({ id: "second-command", kind: "command", status: "running" });
  await clock.advance(4_999);
  assert.equal(writes.length, 1);
  await clock.advance(1);
  assert.equal(writes.length, 2);
  assert.match(text(writes[1].card), /命令执行：进行中 1 · 已完成 1/);
  await clock.advance(2_400);
  progress.finish("succeeded");
  progress.finish("failed");
  let settled = false;
  void progress.settled().then(() => { settled = true; });
  await clock.advance(2_599);
  assert.equal(writes.length, 2);
  assert.equal(settled, false);
  await clock.advance(1);
  await progress.settled();
  assert.deepEqual(writes.map(({ kind, at }) => ({ kind, at })), [
    { kind: "send", at: 10_000 },
    { kind: "update", at: 15_000 },
    { kind: "update", at: 20_000 }
  ]);
  assert.equal(writes[2].id, "card-message");
  assert.match(text(writes[2].card), /状态：已完成/);
  assert.match(text(writes[2].card), /已用时：17 秒/);
  await clock.advance(60_000);
  assert.equal(writes.length, 3);
});

test("updates elapsed time even without new activity", async () => {
  const { progress, clock, writes } = fixture();
  progress.start();
  await clock.advance(15_000);
  assert.equal(writes.length, 2);
  assert.match(text(writes[1].card), /15 秒/);
  progress.finish("succeeded");
  await clock.advance(5_000);
  await progress.settled();
});

test("waits for a slow creation before sending the final state", async () => {
  const send = deferred<string>();
  const { progress, clock, writes } = fixture({ send: () => send.promise });
  progress.start();
  await clock.advance(10_000);
  await clock.advance(1_000);
  progress.finish("failed");
  await clock.advance(9_000);
  assert.equal(writes.length, 1);
  send.resolve("slow-card");
  await flush();
  await clock.advance(0);
  await progress.settled();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].id, "slow-card");
  assert.match(text(writes[1].card), /状态：执行失败/);
  assert.match(text(writes[1].card), /已用时：11 秒/);
});

test("serializes a slow update and never lets an old snapshot overwrite the terminal state", async () => {
  const slowUpdate = deferred<void>();
  let count = 0;
  let active = 0;
  let maxActive = 0;
  const { progress, clock, writes } = fixture({
    update: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (++count === 1) await slowUpdate.promise;
      active--;
    }
  });
  progress.start();
  await clock.advance(15_000);
  progress.activity({ id: "command", kind: "command", status: "completed" });
  await clock.advance(2_000);
  progress.finish("cancelled");
  progress.activity({ id: "must-not-render", kind: "search", status: "running" });
  await clock.advance(5_000);
  assert.equal(writes.length, 2);
  slowUpdate.resolve();
  await flush();
  await clock.advance(0);
  await progress.settled();
  assert.equal(maxActive, 1);
  assert.deepEqual(writes.map((write) => write.at), [10_000, 15_000, 22_000]);
  const final = text(writes[2].card);
  assert.match(final, /状态：已取消/);
  assert.match(final, /命令执行：已完成 1/);
  assert.doesNotMatch(final, /搜索/);
  assert.match(final, /已用时：17 秒/);
  await clock.advance(60_000);
  assert.equal(writes.length, 3);
});

test("stops after creation failure and does not retry forever", async () => {
  const { progress, clock, writes } = fixture({ send: async () => { throw new Error("transport unavailable"); } });
  progress.start();
  await clock.advance(10_000);
  await clock.advance(60_000);
  progress.finish("failed");
  await progress.settled();
  await clock.advance(60_000);
  assert.equal(writes.length, 1);
});

test("does not retry a failed running update but tries the terminal state once", async () => {
  let attempts = 0;
  const { progress, clock, writes } = fixture({
    update: async () => { if (++attempts === 1) throw new Error("transport unavailable"); }
  });
  progress.start();
  await clock.advance(15_000);
  await clock.advance(60_000);
  assert.equal(writes.length, 2);
  progress.finish("timed_out");
  await clock.advance(0);
  await progress.settled();
  await clock.advance(60_000);
  assert.equal(writes.length, 3);
  assert.equal(attempts, 2);
  assert.match(text(writes[2].card), /状态：已超时/);
});

for (const [outcome, label, template] of [
  ["succeeded", "已完成", "green"],
  ["failed", "执行失败", "red"],
  ["cancelled", "已取消", "grey"],
  ["timed_out", "已超时", "orange"]
] as const satisfies ReadonlyArray<readonly [ChannelTaskOutcome, string, string]>) {
  test(`renders terminal outcome ${outcome}`, async () => {
    const { progress, clock, writes } = fixture();
    progress.start();
    await clock.advance(10_000);
    progress.finish(outcome);
    await clock.advance(5_000);
    await progress.settled();
    assert.match(text(writes[1].card), new RegExp(`状态：${label}`));
    assert.equal(writes[1].card.header?.template, template);
  });
}
