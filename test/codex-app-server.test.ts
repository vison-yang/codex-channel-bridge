import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CodexActivityEvent } from "../src/codex/activity.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { codexFailureOutcome } from "../src/codex/run-lifecycle.js";
import { createConfiguredCodexRunner, HybridCodexRunner } from "../src/codex/runner.js";
import { defaultConfig } from "../src/state/config.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("observes typed activities and deltas from one explicit final-answer item", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const events: ("started" | CodexActivityEvent)[] = [];
  const streamed: string[] = [];
  const legacyDeltas: string[] = [];
  const legacyProgress: string[] = [];

  const result = await runner.run({
    prompt: "structured-observers",
    cwd: fixturesDir,
    onExecutionStarted: () => events.push("started"),
    onActivity: (event) => events.push(event),
    onFinalAnswerDelta: (delta) => streamed.push(delta),
    onDelta: (delta) => { legacyDeltas.push(delta); },
    onProgress: (message) => { legacyProgress.push(message); }
  });

  assert.deepEqual(events, [
    "started",
    { id: "cmd-1", kind: "command", status: "running" },
    { id: "cmd-1", kind: "command", status: "failed" },
    { id: "file-1", kind: "file", status: "failed" },
    { id: "mcp-1", kind: "mcp", status: "running" },
    { id: "tool-1", kind: "dynamic", status: "completed" },
    { id: "search-1", kind: "search", status: "running" },
    { id: "search-1", kind: "search", status: "completed" },
    { id: "image-1", kind: "image", status: "completed" },
    { id: "collab-1", kind: "agent", status: "completed", agents: [
      { id: "a", status: "pending" }, { id: "b", status: "failed" }, { id: "c", status: "stopped" }
    ] },
    { id: "sub-agent-1", kind: "agent", status: "running", agents: [{ id: "f", status: "running" }] }
  ]);
  assert.deepEqual(streamed, ["first ", "answer"]);
  assert.deepEqual(legacyDeltas, ["partial", "unknown phase", "first ", "answer", "second answer"]);
  assert.deepEqual(legacyProgress, ["commentary"]);
  assert.equal(result.text, "second answer");
});

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const deltas: string[] = [];
  const progress: string[] = [];
  const first = await runner.run({
    prompt: "first",
    cwd: "/tmp/project",
    model: "test-model",
    effort: "high",
    onDelta: async (delta) => {
      deltas.push(delta);
    },
    onProgress: async (message) => {
      progress.push(message);
    }
  });
  assert.equal(first.threadId, "thread-new");
  assert.equal(first.text, "reply:first");
  assert.deepEqual(deltas, ["reply:", "first"]);
  assert.deepEqual(progress, ["working:first"]);
  assert.match(first.raw, /item\/completed/);
  assert.match(first.raw, /turn\/completed/);
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-new"), {
    model: "test-model",
    effort: "high"
  });

  const resumed = await runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumed.threadId, "thread-existing");
  assert.equal(resumed.text, "reply:second");
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-existing"), {
    model: "resumed-model",
    effort: "medium"
  });

  assert.deepEqual(await runner.listSessions(), {
    data: [{ id: "thread-new" }],
    nextCursor: null,
    backwardsCursor: null
  });

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
      createdAt: "2023-11-14T22:13:20.000Z"
    },
    {
      id: "history-commentary-1",
      role: "assistant",
      text: "working",
      kind: "progress",
      createdAt: "2023-11-14T22:13:22.000Z"
    },
    {
      id: "history-assistant-1",
      role: "assistant",
      text: "history reply",
      createdAt: "2023-11-14T22:13:22.000Z"
    }
  ]);

  assert.deepEqual(await runner.getRuntimeInfo("/tmp/another-project"), {
    model: "configured-model",
    effort: "high",
    provider: "FixtureProvider"
  });
  assert.deepEqual(await runner.listModels(), [{
    model: "configured-model",
    displayName: "Configured Model",
    description: "Model used by the test fixture.",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper reasoning" }
    ]
  }]);
  assert.deepEqual(await runner.getAccountRateLimits(), {
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
    credits: { hasCredits: true, unlimited: false, balance: "12.34" },
    spendControlReached: false
  });
});

test("keeps an active channel turn alive from its latest progress reply", async (t) => {
  // Given: a turn whose progress arrives before the timeout and final answer arrives after the original deadline.
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 200,
    turnTimeoutMs: 200
  });
  t.after(() => runner.close());

  const progress: string[] = [];

  // When: the originating channel receives progress during the active turn.
  const result = await runner.run({
    prompt: "sliding-timeout",
    cwd: "/tmp/project",
    onProgress: (message) => progress.push(message)
  });

  // Then: the timeout is measured from that reply and the final answer completes.
  assert.deepEqual(progress, ["working:sliding-timeout"]);
  assert.equal(result.text, "reply:sliding-timeout");
});

for (const observer of ["feishu", "none"] as const) {
  test(`renews the current turn timeout on tool activity with ${observer} observers`, async (t) => {
    const runner = new AppServerCodexRunner({
      codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
      requestTimeoutMs: 500,
      turnTimeoutMs: 500
    });
    t.after(() => runner.close());
    const events: CodexActivityEvent[] = [];

    const result = await runner.run({
      prompt: "activity-timeout",
      cwd: fixturesDir,
      ...(observer === "feishu" ? {
        onActivity: (event: CodexActivityEvent) => events.push(event),
        onFinalAnswerDelta: (_delta: string) => undefined
      } : {})
    });

    assert.equal(result.turnId, "turn-1");
    if (observer === "feishu") {
      assert.deepEqual(events, [{ id: "activity-1", kind: "command", status: "running" }]);
    }
  });
}

test("ignores activity from an unrelated turn when renewing a timeout", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 500,
    turnTimeoutMs: 500
  });
  t.after(() => runner.close());

  const running = runner.run({ prompt: "foreign-activity-timeout", cwd: fixturesDir });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(Promise.race([
      running,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("foreign activity extended the turn")), 1_100); })
    ]), /app-server turn timed out/i);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

for (const mode of ["early", "late"] as const) {
  test(`pauses the turn timeout while ${mode} approval waits and restarts it after the decision`, async (t) => {
    const runner = new AppServerCodexRunner({
      codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
      requestTimeoutMs: 500,
      turnTimeoutMs: 500
    });
    t.after(() => runner.close());
    let release!: (decision: "accept") => void;
    let approvalSeen!: () => void;
    const seen = new Promise<void>((resolve) => { approvalSeen = resolve; });
    const decision = new Promise<"accept">((resolve) => { release = resolve; });

    const running = runner.run({
      prompt: `approval:${mode}`,
      cwd: fixturesDir,
      onApproval: () => {
        approvalSeen();
        return decision;
      }
    });
    // Attach a rejection handler before holding the approval across the old deadline.
    const outcome = running.then((result) => ({ result }), (error: Error) => ({ error }));
    await Promise.race([seen, outcome.then((settled) => {
      if ("error" in settled) throw settled.error;
      throw new Error("turn completed before approval was requested");
    })]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    release("accept");
    const settled = await outcome;
    if ("error" in settled) throw settled.error;
    assert.equal(settled.result.text, "approval:command:accept");
  });
}

test("keeps the turn paused until every concurrent approval is decided", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 500,
    turnTimeoutMs: 500
  });
  t.after(() => runner.close());
  const decisions: Array<(decision: "accept") => void> = [];
  let observed!: () => void;
  const seen = new Promise<void>((resolve) => { observed = resolve; });
  const running = runner.run({
    prompt: "approval:multi",
    cwd: fixturesDir,
    onApproval: () => new Promise<"accept">((resolve) => {
      decisions.push(resolve);
      if (decisions.length === 2) observed();
    })
  });
  const outcome = running.then((result) => ({ result }), (error: Error) => ({ error }));
  await Promise.race([seen, outcome.then((settled) => {
    if ("error" in settled) throw settled.error;
    throw new Error("turn completed before both approvals were requested");
  })]);
  decisions[0]?.("accept");
  await new Promise((resolve) => setTimeout(resolve, 700));
  decisions[1]?.("accept");
  const settled = await outcome;
  if ("error" in settled) throw settled.error;
  assert.equal(settled.result.text, "approval:command:accept");
});

test("aborts all interrupted approvals without cancelling another turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const approvals = new Map<string, Array<{ signal: AbortSignal | undefined; decide: (value: "accept") => void }>>();
  let observed!: () => void;
  const allObserved = new Promise<void>((resolve) => { observed = resolve; });
  const onApproval = (request: { threadId: string }, signal?: AbortSignal) => new Promise<"accept">((decide) => {
    const pending = approvals.get(request.threadId) ?? [];
    pending.push({ signal, decide });
    approvals.set(request.threadId, pending);
    if ((approvals.get("thread-first")?.length ?? 0) === 2 && approvals.has("thread-second")) observed();
  });
  const first = runner.run({ prompt: "approval:multi", cwd: fixturesDir, threadId: "thread-first", onApproval });
  const firstInterrupted = assert.rejects(first, /interrupted/i);
  const second = runner.run({ prompt: "approval:command", cwd: fixturesDir, threadId: "thread-second", onApproval });
  void firstInterrupted.catch(() => undefined);
  void second.catch(() => undefined);
  await allObserved;

  await runner.stop("thread-first");
  await firstInterrupted;
  assert.deepEqual(approvals.get("thread-first")?.map(({ signal }) => signal?.aborted), [true, true]);
  assert.equal(approvals.get("thread-second")?.[0]?.signal?.aborted, false);
  approvals.get("thread-second")?.[0]?.decide("accept");
  assert.equal((await second).text, "approval:command:accept");
});

test("aborts a pending approval when the app-server runner closes", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  let signal: AbortSignal | undefined;
  let observed!: () => void;
  const seen = new Promise<void>((resolve) => { observed = resolve; });
  const running = runner.run({
    prompt: "approval:command",
    cwd: fixturesDir,
    onApproval: (_request, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      observed();
      return new Promise<"accept">(() => undefined);
    }
  });
  const closed = assert.rejects(running, /runner closed/i);
  await seen;
  runner.close();
  await closed;
  assert.equal(signal?.aborted, true);
});

test("inherits each project permission policy for new and resumed threads", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const first = await runner.run({ prompt: "project-a", cwd: "/tmp/project-permissions-a", model: "verify-project-a" });
  const second = await runner.run({
    prompt: "project-b",
    cwd: "/tmp/project-permissions-b",
    threadId: "thread-project-permissions-b"
  });
  assert.equal(first.text, "reply:project-a");
  assert.equal(second.text, "reply:project-b");
});

test("propagates an explicit approval policy for new and resumed threads", async (t) => {
  const runner = createConfiguredCodexRunner({
    ...defaultConfig(fixturesDir),
    codexBackend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    codexRequestTimeoutMs: 2_000,
    codexApprovalPolicy: "on-request"
  });
  t.after(() => runner.close());

  const first = await runner.run({
    prompt: "approval:command",
    cwd: "/tmp/project-explicit-policy-a",
    onApproval: () => "accept"
  });
  const second = await runner.run({
    prompt: "approval:command",
    cwd: "/tmp/project-explicit-policy-b",
    threadId: "thread-explicit-policy-b",
    onApproval: () => "accept"
  });
  assert.equal(first.text, "approval:command:accept");
  assert.equal(second.text, "approval:command:accept");
});

test("propagates the configured sandbox to an app-server turn", async (t) => {
  // Given: a bridge configured to allow Codex full workspace access.
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    execSandbox: "danger-full-access"
  });
  t.after(() => runner.close());

  // When: a message starts a turn through the app-server path used by channel streaming.
  const result = await runner.run({
    prompt: "verify-danger-full-access",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });

  // Then: the downstream app-server accepts the expected policy and completes the turn.
  assert.equal(result.text, "reply:verify-danger-full-access");
});

test("runs AI classification on a persistent ephemeral app-server thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000,
    execSandbox: "danger-full-access",
    approvalPolicy: "on-request"
  });
  t.after(() => runner.close());

  const result = await runner.runEphemeral({
    prompt: "classify-intent",
    cwd: "/tmp",
    outputSchema: {
      type: "object",
      properties: { intent: { type: "string" } },
      required: ["intent"]
    }
  });

  assert.equal(result.text, "reply:classify-intent");
});

test("registers llm-wiki dynamic tools and routes autonomous tool calls", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());
  const calls: unknown[] = [];

  const result = await runner.run({
    prompt: "dynamic-tool",
    cwd: "/tmp/current-project",
    dynamicTools: [{ type: "namespace", name: "knowledge", description: "read only", tools: [] }],
    onDynamicToolCall: async (call) => {
      calls.push(call);
      return JSON.stringify({ result: [{ anchor: "wiki/fixture.md#answer" }] });
    }
  });

  assert.match(result.text, /wiki\/fixture\.md#answer/);
  assert.deepEqual(calls, [{
    callId: "tool-turn-1",
    threadId: "thread-new",
    turnId: "turn-1",
    namespace: "knowledge",
    tool: "search",
    arguments: { query: "fixture", limit: 3 }
  }]);
});

test("routes Codex request_user_input through a channel-native answer handler", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "request-user-input",
    cwd: "/tmp/project",
    onUserInput: async (request) => {
      assert.equal(request.questions[0]?.options?.[0]?.label, "方案 A");
      return { direction: { answers: ["方案 A"] } };
    }
  });

  assert.equal(result.text, "input:方案 A");
});

test("declares experimentalApi before starting plan collaboration mode and manages native thread goals", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "plan-mode",
    cwd: "/tmp/project",
    model: "configured-model",
    collaborationMode: "plan"
  });
  assert.equal(result.text, "reply:plan-mode");

  const goal = await runner.setGoal(result.threadId, { objective: "完成渠道问答", status: "active", tokenBudget: 5000 });
  assert.equal(goal?.objective, "完成渠道问答");
  assert.equal((await runner.getGoal(result.threadId))?.tokenBudget, 5000);
  await runner.clearGoal(result.threadId);
  assert.equal(await runner.getGoal(result.threadId), undefined);
});

test("routes command, file, and permission approvals to the active channel turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  for (const kind of ["command", "file", "permissions"] as const) {
    const requests: Array<{ kind: string; command?: string; reason?: string }> = [];
    const result = await runner.run({
      prompt: `approval:${kind}`,
      cwd: "/tmp/project",
      threadId: `thread-approval-${kind}`,
      onApproval: async (request) => {
        requests.push(request);
        return "accept";
      }
    });

    assert.equal(result.text, `approval:${kind}:accept`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, kind);
    assert.match(requests[0]?.reason ?? "", new RegExp(kind));
    if (kind === "command") assert.equal(requests[0]?.command, "touch approved.txt");
  }
});

test("declines an app-server approval when the channel rejects it", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "approval:command",
    cwd: "/tmp/project",
    threadId: "thread-approval-decline",
    onApproval: async () => "decline"
  });

  assert.equal(result.text, "approval:command:decline");
});

test("interrupts only the active V2 turn scoped to a new managed session", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  let onExecutionStarted!: () => void;
  const started = new Promise<void>((resolve) => { onExecutionStarted = resolve; });
  const run = runner.run({ prompt: "hold", cwd: "/tmp/project", queueKey: "managed-stop", onExecutionStarted });
  await Promise.race([started, run]);
  let onUnrelatedStarted!: () => void;
  const unrelatedStarted = new Promise<void>((resolve) => { onUnrelatedStarted = resolve; });
  const unrelatedRun = runner.run({
    prompt: "slow:unrelated",
    cwd: "/tmp/project",
    threadId: "thread-other",
    queueKey: "managed-other",
    onExecutionStarted: onUnrelatedStarted
  });
  await Promise.race([unrelatedStarted, unrelatedRun]);

  await runner.stop("thread-unrelated");
  await runner.stop(undefined, "managed-unrelated");
  await runner.stop(undefined, "managed-stop");
  await assert.rejects(run, (error: Error) => {
    assert.match(error.message, /interrupted/i);
    assert.equal(codexFailureOutcome(error), "cancelled");
    return true;
  });
  assert.equal((await unrelatedRun).text, "reply:slow:unrelated");
});

test("reports an active app-server timeout without replaying the turn through exec", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 500,
    turnTimeoutMs: 500
  });
  t.after(() => runner.close());
  let starts = 0;

  await assert.rejects(runner.run({
    prompt: "hold",
    cwd: fixturesDir,
    onExecutionStarted: () => { starts += 1; }
  }), (error: Error) => {
    assert.match(error.message, /app-server turn timed out/i);
    assert.equal(codexFailureOutcome(error), "timed_out");
    return true;
  });
  assert.equal(starts, 1);
});

test("serializes concurrent turns for the same managed session", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "app-server",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const lifecycleOrder: string[] = [];
  const first = runner.run({
    prompt: "slow:first",
    cwd: "/tmp/project",
    queueKey: "managed-session",
    onExecutionStarted: () => lifecycleOrder.push("start:first")
  }).then(() => lifecycleOrder.push("finish:first"));
  const second = runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    queueKey: "managed-session",
    onExecutionStarted: () => lifecycleOrder.push("start:second")
  }).then(() => lifecycleOrder.push("finish:second"));

  await Promise.all([first, second]);
  assert.deepEqual(lifecycleOrder, ["start:first", "finish:first", "start:second", "finish:second"]);
});

test("waits for an existing thread turn before continuing it", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const progress: string[] = [];
  const result = await runner.run({
    prompt: "continue",
    cwd: "/tmp/project",
    threadId: "thread-external-busy",
    onExecutionStarted: () => progress.push("started"),
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.text, "reply:continue");
  assert.deepEqual(progress, ["当前会话的上一条任务仍在执行，已排队等待完成。", "started", "working:continue"]);
});

test("auto backend falls back to codex exec for an existing thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  let starts = 0;

  const result = await runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing",
    onExecutionStarted: () => { starts += 1; }
  });

  assert.equal(starts, 1);
  assert.equal(result.threadId, "thread-existing");
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-resumed/);
});

test("exec backend uses app-server when true streaming is requested", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, ["reply:", "stream"]);
  assert.equal(result.text, "reply:stream");
});

test("streaming fallback to exec sends only the final answer", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-new/);
});
