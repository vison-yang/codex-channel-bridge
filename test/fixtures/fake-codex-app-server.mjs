#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let experimentalApiEnabled = false;
let nextTurn = 1;
const activeTurns = new Map();
const pendingApprovals = new Map();
const pendingToolCalls = new Map();
const pendingUserInputs = new Map();
const goals = new Map();
let externalBusyReads = 0;
let ephemeralThreadStarted = false;
let dynamicToolsEnabled = false;
let writerForkCount = 0;
let writerBusyReads = 0;
let writerRaceResumed = false;
let writerRaceReads = 0;
const writerForkTurns = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function completedTurn(id, status, error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1
  };
}

function sendObservedTurn(requestId, threadId, turnId) {
  const item = (lifecycle, value, observedTurnId = turnId) => {
    send({ method: `item/${lifecycle}`, params: { threadId, turnId: observedTurnId, item: value } });
  };
  const command = {
    id: "cmd-1", type: "commandExecution", status: "inProgress",
    command: "private command", cwd: "/private/workspace", aggregatedOutput: "private output"
  };
  item("started", command);
  item("started", { ...command, id: "foreign" }, "other-turn");
  respond(requestId, { turn: completedTurn(turnId, "inProgress") });
  item("completed", { ...command, status: "failed" });
  item("completed", { id: "file-1", type: "fileChange", status: "declined", changes: [{ path: "/private/file" }] });
  item("started", { id: "mcp-1", type: "mcpToolCall", status: "inProgress", arguments: { secret: "private arguments" } });
  item("completed", { id: "tool-1", type: "dynamicToolCall", status: "completed", contentItems: ["private content"] });
  item("started", { id: "search-1", type: "webSearch", query: "private query" });
  item("completed", { id: "search-1", type: "webSearch", results: ["private results"] });
  item("completed", { id: "image-1", type: "imageGeneration", status: "completed", savedPath: "/private/image" });
  item("completed", {
    id: "collab-1", type: "collabAgentToolCall", status: "completed", prompt: "private prompt",
    agentsStates: {
      a: { status: "pendingInit", message: "private message" },
      b: { status: "errored" },
      c: { status: "shutdown" },
      d: { status: "notFound" },
      e: { status: "unknown" }
    }
  });
  item("completed", { id: "sub-agent-1", type: "subAgentActivity", kind: "started", agentThreadId: "f", agentPath: "/private/agent" });
  item("started", { id: "unknown-state", type: "commandExecution", status: "unknown" });
  item("completed", { id: "reasoning-1", type: "reasoning", summary: ["private reasoning"] });
  item("completed", { id: "other-1", type: "unknown", status: "completed", output: "private output" });

  for (const [id, phase, deltas] of [
    ["commentary-1", "commentary", ["commentary"]],
    ["partial-1", "partial_answer", ["partial"]],
    ["unknown-1", null, ["unknown phase"]],
    ["final-1", "final_answer", ["first ", "answer"]],
    ["final-2", "final_answer", ["second answer"]]
  ]) {
    item("started", { id, type: "agentMessage", phase, text: "" });
    for (const delta of deltas) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: id, delta } });
    }
    item("completed", { id, type: "agentMessage", phase, text: deltas.join("") });
  }
  send({ method: "turn/completed", params: { threadId, turn: completedTurn(turnId, "completed") } });
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (message.jsonrpc) {
      fail(message.id, "jsonrpc header must be omitted");
      return;
    }
    if (message.params?.clientInfo?.name !== "codex-channel-bridge") {
      fail(message.id, "missing codex-channel-bridge clientInfo");
      return;
    }
    experimentalApiEnabled = message.params?.capabilities?.experimentalApi === true;
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(message.id, "Not initialized");
    return;
  }

  if (!message.method && pendingApprovals.has(message.id)) {
    const approval = pendingApprovals.get(message.id);
    pendingApprovals.delete(message.id);
    if (approval.waitForAll && Array.from(pendingApprovals.values()).some((pending) => pending.turnId === approval.turnId)) return;
    const decision = approval.kind === "permissions"
      ? (Object.keys(message.result?.permissions ?? {}).length ? "accept" : "decline")
      : message.result?.decision;
    const finish = () => {
      const itemId = `item-${approval.turnId}`;
      send({
        method: "item/completed",
        params: {
          threadId: approval.threadId,
          turnId: approval.turnId,
          completedAtMs: Date.now(),
          item: {
            type: "agentMessage",
            id: itemId,
            text: `approval:${approval.kind}:${decision}`,
            phase: "final_answer",
            memoryCitation: null
          }
        }
      });
      send({
        method: "turn/completed",
        params: { threadId: approval.threadId, turn: completedTurn(approval.turnId, "completed") }
      });
      activeTurns.delete(approval.threadId);
    };
    if (approval.delayedCompletion) setTimeout(finish, 350);
    else finish();
    return;
  }

  if (!message.method && pendingToolCalls.has(message.id)) {
    const pending = pendingToolCalls.get(message.id);
    pendingToolCalls.delete(message.id);
    const text = `tool:${message.result?.success}:${message.result?.contentItems?.[0]?.text ?? ""}`;
    send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${pending.turnId}`, text, phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: pending.threadId, turn: completedTurn(pending.turnId, "completed") } });
    activeTurns.delete(pending.threadId);
    return;
  }

  if (!message.method && pendingUserInputs.has(message.id)) {
    const pending = pendingUserInputs.get(message.id);
    pendingUserInputs.delete(message.id);
    const text = `input:${message.result?.answers?.direction?.answers?.[0] ?? "none"}`;
    send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: `item-${pending.turnId}`, text, phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: pending.threadId, turn: completedTurn(pending.turnId, "completed") } });
    activeTurns.delete(pending.threadId);
    return;
  }

  if (message.method === "thread/start") {
    const isEphemeral = message.params?.ephemeral === true;
    const configuredPolicy = message.params?.cwd === "/tmp/project-explicit-policy-a";
    if ((isEphemeral && (message.params?.approvalPolicy !== "never" || message.params?.sandbox !== "read-only"))
      || (!isEphemeral && (configuredPolicy
        ? message.params?.approvalPolicy !== "on-request"
        : Object.hasOwn(message.params, "approvalPolicy")))
      || (!isEphemeral && Object.hasOwn(message.params, "sandbox"))
      || Object.hasOwn(message.params, "sandboxPolicy")) {
      fail(message.id, "thread/start must preserve configured or project permissions");
      return;
    }
    if (message.params?.model === "verify-project-a" && message.params?.cwd !== "/tmp/project-permissions-a") {
      fail(message.id, "thread/start must use the first project cwd");
      return;
    }
    ephemeralThreadStarted = isEphemeral;
    dynamicToolsEnabled = message.params?.dynamicTools?.[0]?.name === "knowledge";
    respond(message.id, {
      thread: { id: "thread-new" },
      model: message.params.model ?? "configured-model",
      reasoningEffort: "high"
    });
    return;
  }

  if (message.method === "thread/resume") {
    const resumeError = {
      "thread-writer-conflict": { code: -32600, message: "thread thread-writer-conflict already has an active writer" },
      "thread-writer-busy": { code: -32600, message: "thread thread-writer-busy already has an active writer" },
      "thread-writer-explicit": { code: -32600, message: "thread thread-writer-explicit already has an active writer" },
      "thread-writer-race": { code: -32600, message: "thread thread-writer-race already has an active writer" },
      "thread-writer-fork-denied": { code: -32600, message: "thread thread-writer-fork-denied already has an active writer" },
      "thread-resume-missing": { code: -32600, message: "thread thread-resume-missing not found" },
      "thread-resume-other-code": { code: -32602, message: "thread thread-resume-other-code already has an active writer" },
      "thread-resume-other-writer": { code: -32600, message: "thread some-other-thread already has an active writer" }
    }[message.params?.threadId];
    if (resumeError) {
      if (message.params?.threadId === "thread-writer-race") writerRaceResumed = true;
      send({ id: message.id, error: resumeError });
      return;
    }
    const configuredPolicy = message.params?.threadId === "thread-explicit-policy-b";
    if ((configuredPolicy ? message.params?.approvalPolicy !== "on-request" : Object.hasOwn(message.params, "approvalPolicy"))
      || Object.hasOwn(message.params, "sandbox")
      || Object.hasOwn(message.params, "sandboxPolicy")) {
      fail(message.id, "thread/resume must preserve configured or project permissions");
      return;
    }
    if (configuredPolicy && message.params?.cwd !== "/tmp/project-explicit-policy-b") {
      fail(message.id, "thread/resume must use the explicit-policy project cwd");
      return;
    }
    if (message.params?.threadId === "thread-project-permissions-b" && message.params?.cwd !== "/tmp/project-permissions-b") {
      fail(message.id, "thread/resume must use the second project cwd");
      return;
    }
    respond(message.id, {
      thread: { id: message.params.threadId },
      model: "resumed-model",
      reasoningEffort: "medium"
    });
    return;
  }

  if (message.method === "thread/fork") {
    const explicitPolicy = message.params?.threadId === "thread-writer-explicit";
    if (message.params?.threadId === "thread-writer-fork-denied") {
      fail(message.id, "fork denied by fixture");
      return;
    }
    if (!["thread-writer-conflict", "thread-writer-busy", "thread-writer-explicit", "thread-writer-race"].includes(message.params?.threadId)
      || message.params?.cwd !== (explicitPolicy ? "/tmp/writer-explicit-project" : "/tmp/writer-conflict-project")
      || message.params?.excludeTurns !== true
      || message.params?.deferGoalContinuation !== true
      || message.params?.lastTurnId !== (message.params?.threadId === "thread-writer-race" ? "writer-race-terminal" : "history-turn-1")
      || Object.hasOwn(message.params, "ephemeral")
      || (explicitPolicy ? message.params?.approvalPolicy !== "on-request" : Object.hasOwn(message.params, "approvalPolicy"))
      || Object.hasOwn(message.params, "sandbox")
      || Object.hasOwn(message.params, "sandboxPolicy")
      || (message.params?.threadId === "thread-writer-busy" && writerBusyReads < 2)
      || (message.params?.threadId === "thread-writer-race" && writerRaceReads < 2)) {
      fail(message.id, "thread/fork must preserve the workspace and inherited permissions without turns or goal continuation");
      return;
    }
    const threadId = `thread-writer-fork-${++writerForkCount}`;
    writerForkTurns.set(threadId, []);
    respond(message.id, { thread: { id: threadId }, model: "resumed-model", reasoningEffort: "medium" });
    return;
  }

  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        model: "configured-model",
        model_provider: "FixtureProvider",
        model_reasoning_effort: "high"
      },
      origins: {}
    });
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [{
        id: "configured-model",
        model: "configured-model",
        displayName: "Configured Model",
        description: "Model used by the test fixture.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" }
        ],
        defaultReasoningEffort: "medium",
        isDefault: true
      }],
      nextCursor: null
    });
    return;
  }

  if (message.method === "account/rateLimits/read") {
    respond(message.id, {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 18.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
        credits: { hasCredits: true, unlimited: false, balance: "12.34" },
        individualLimit: null,
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null
    });
    return;
  }

  if (message.method === "thread/goal/get") {
    respond(message.id, { goal: goals.get(message.params.threadId) ?? null });
    return;
  }

  if (message.method === "thread/goal/set") {
    const current = goals.get(message.params.threadId);
    const goal = {
      threadId: message.params.threadId,
      objective: message.params.objective ?? current?.objective ?? "",
      status: message.params.status ?? current?.status ?? "active",
      tokenBudget: message.params.tokenBudget ?? current?.tokenBudget ?? null,
      tokensUsed: 42,
      timeUsedSeconds: 9,
      createdAt: current?.createdAt ?? 1,
      updatedAt: 2
    };
    goals.set(message.params.threadId, goal);
    respond(message.id, { goal });
    return;
  }

  if (message.method === "thread/goal/clear") {
    goals.delete(message.params.threadId);
    respond(message.id, { cleared: true });
    return;
  }

  if (message.method === "thread/list") {
    respond(message.id, { data: [{ id: "thread-new" }], nextCursor: null, backwardsCursor: null });
    return;
  }

  if (message.method === "thread/read") {
    const activeTurnId = activeTurns.get(message.params.threadId)
      ?? (message.params.threadId === "thread-external-busy" && externalBusyReads++ === 0
        ? "external-turn"
        : message.params.threadId === "thread-writer-busy" && writerBusyReads++ === 0
          ? "external-writer-turn"
          : message.params.threadId === "thread-writer-race" && writerRaceResumed && writerRaceReads++ === 0
            ? "race-active-turn"
            : undefined);
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        turns: [
          {
            id: "history-turn-1",
            status: ["thread-writer-conflict", "thread-writer-busy", "thread-writer-race"].includes(message.params.threadId) ? "interrupted" : "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_002,
            items: [
              {
                type: "userMessage",
                id: "history-user-1",
                clientId: null,
                content: [{ type: "text", text: "hello history", text_elements: [] }]
              },
              {
                type: "agentMessage",
                id: "history-commentary-1",
                text: "working",
                phase: "commentary",
                memoryCitation: null
              },
              {
                type: "agentMessage",
                id: "history-assistant-1",
                text: "history reply",
                phase: "final_answer",
                memoryCitation: null
              },
              { type: "reasoning", id: "history-reasoning-1", summary: [], content: ["hidden"] }
            ]
          },
          ...(writerForkTurns.get(message.params.threadId) ?? []).map((prompt, index) => ({
            ...completedTurn(`fork-history-turn-${index}`, "completed"),
            items: [{ type: "userMessage", id: `fork-history-user-${index}`, content: [{ type: "text", text: prompt }] }]
          })),
          ...(message.params.threadId === "thread-writer-race" && writerRaceReads >= 2
            ? [completedTurn("writer-race-terminal", "completed")]
            : []),
          ...(activeTurnId ? [completedTurn(activeTurnId, "inProgress")] : [])
        ]
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const prompt = message.params?.input?.[0]?.text;
    if (message.params?.input?.[0]?.type !== "text" || typeof prompt !== "string") {
      fail(message.id, "turn/start requires text input");
      return;
    }
    const approvalMode = prompt.startsWith("approval:") ? prompt.slice("approval:".length) : undefined;
    const approvalKind = ["early", "late", "multi"].includes(approvalMode) ? "command" : approvalMode;
    if ((prompt === "project-a" && message.params?.cwd !== "/tmp/project-permissions-a")
      || (prompt === "project-b" && message.params?.cwd !== "/tmp/project-permissions-b")) {
      fail(message.id, "turn/start must use the originating project cwd");
      return;
    }
    const isEphemeral = prompt === "classify-intent";
    const configuredPolicy = ["/tmp/project-explicit-policy-a", "/tmp/project-explicit-policy-b", "/tmp/writer-explicit-project"].includes(message.params?.cwd);
    if ((isEphemeral && message.params?.approvalPolicy !== "never")
      || (!isEphemeral && (configuredPolicy
        ? message.params?.approvalPolicy !== "on-request"
        : Object.hasOwn(message.params, "approvalPolicy")))
      || Object.hasOwn(message.params, "sandbox")) {
      fail(message.id, "turn/start must preserve configured or project approval permissions");
      return;
    }
    if (prompt === "verify-danger-full-access"
      && message.params?.sandboxPolicy?.type !== "dangerFullAccess") {
      fail(message.id, "turn/start must propagate the configured danger-full-access sandbox");
      return;
    }
    if (prompt === "classify-intent"
      && (!ephemeralThreadStarted
        || message.params?.sandboxPolicy?.type !== "readOnly"
        || message.params?.outputSchema?.properties?.intent?.type !== "string")) {
      fail(message.id, "intent classification must use an ephemeral read-only thread with output schema");
      return;
    }
    if (prompt === "fork-explicit-policy" && message.params?.sandboxPolicy?.type !== "workspaceWrite") {
      fail(message.id, "forked turn must preserve the configured workspace-write sandbox");
      return;
    }
    if (!isEphemeral && !["verify-danger-full-access", "fork-explicit-policy"].includes(prompt) && Object.hasOwn(message.params, "sandboxPolicy")) {
      fail(message.id, "ordinary turn/start must inherit the project sandbox");
      return;
    }
    writerForkTurns.get(message.params.threadId)?.push(prompt);
    if (prompt === "plan-mode") {
      if (!experimentalApiEnabled) {
        fail(message.id, "turn/start.collaborationMode requires experimentalApi capability");
        return;
      }
      if (message.params?.collaborationMode?.mode !== "plan") {
        fail(message.id, "turn/start must propagate plan collaboration mode");
        return;
      }
    }
    activeTurns.set(message.params.threadId, turnId);
    if (prompt === "structured-observers") {
      sendObservedTurn(message.id, message.params.threadId, turnId);
      activeTurns.delete(message.params.threadId);
      return;
    }
    if (["command", "file", "permissions"].includes(approvalKind)) {
      const method = approvalKind === "command"
        ? "item/commandExecution/requestApproval"
        : approvalKind === "file"
          ? "item/fileChange/requestApproval"
          : "item/permissions/requestApproval";
      const sendApproval = (index) => {
        const approvalId = `approval-${turnId}-${index}`;
        pendingApprovals.set(approvalId, {
          kind: approvalKind,
          threadId: message.params.threadId,
          turnId,
          delayedCompletion: approvalMode === "early" || approvalMode === "late",
          waitForAll: approvalMode === "multi"
        });
        send({
          id: approvalId,
          method,
          params: {
            threadId: message.params.threadId,
            turnId,
            itemId: `approval-item-${turnId}-${index}`,
            startedAtMs: Date.now(),
            cwd: "/tmp/project",
            command: approvalKind === "command" ? "touch approved.txt" : null,
            reason: `fixture ${approvalKind} approval`,
            grantRoot: approvalKind === "file" ? "/tmp/project" : null,
            permissions: approvalKind === "permissions" ? { network: { enabled: true } } : undefined
          }
        });
      };
      if (approvalMode === "early") sendApproval(1);
      respond(message.id, { turn: completedTurn(turnId, "inProgress") });
      if (approvalMode !== "early") sendApproval(1);
      if (approvalMode === "multi") sendApproval(2);
      return;
    }
    respond(message.id, { turn: completedTurn(turnId, "inProgress") });
    if (prompt === "activity-timeout" || prompt === "foreign-activity-timeout") {
      const observedTurn = prompt === "activity-timeout" ? turnId : "unrelated-turn";
      const sendActivity = () => send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId: observedTurn,
          item: { id: "activity-1", type: "commandExecution", status: "inProgress" }
        }
      });
      if (prompt === "activity-timeout") {
        setTimeout(sendActivity, 350);
        setTimeout(() => {
          send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: completedTurn(turnId, "completed") } });
          activeTurns.delete(message.params.threadId);
        }, 700);
      } else {
        for (let delay = 200; delay <= 1_400; delay += 200) setTimeout(sendActivity, delay);
      }
      return;
    }
    if (prompt === "hold") {
      return;
    }
    if (prompt === "dynamic-tool") {
      if (!dynamicToolsEnabled) {
        fail(message.id, "thread/start must register knowledge dynamic tools");
        return;
      }
      const requestId = `tool-${turnId}`;
      pendingToolCalls.set(requestId, { threadId: message.params.threadId, turnId });
      send({ id: requestId, method: "item/tool/call", params: { callId: requestId, threadId: message.params.threadId, turnId, namespace: "knowledge", tool: "search", arguments: { query: "fixture", limit: 3 } } });
      return;
    }
    if (prompt === "request-user-input") {
      const requestId = `input-${turnId}`;
      pendingUserInputs.set(requestId, { threadId: message.params.threadId, turnId });
      send({ id: requestId, method: "item/tool/requestUserInput", params: { itemId: requestId, threadId: message.params.threadId, turnId, questions: [{ header: "方向", id: "direction", question: "选择方向", options: [{ label: "方案 A", description: "使用 A" }, { label: "方案 B", description: "使用 B" }] }] } });
      return;
    }
    const sendProgress = () => {
      const progressItemId = `progress-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
        }
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: message.params.threadId, turnId, itemId: progressItemId, delta: `working:${prompt}` }
      });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: progressItemId, text: `working:${prompt}`, phase: "commentary", memoryCitation: null }
        }
      });
    };
    const sendFinal = () => {
      const itemId = `item-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
        }
      });
      for (const delta of ["reply:", prompt]) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId: message.params.threadId, turnId, itemId, delta }
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
        }
      });
      send({
        method: "turn/completed",
        params: { threadId: message.params.threadId, turn: completedTurn(turnId, "completed") }
      });
      activeTurns.delete(message.params.threadId);
    };
    if (prompt === "sliding-timeout") {
      setTimeout(sendProgress, 120);
      setTimeout(sendFinal, 260);
    } else {
      setTimeout(() => {
        sendProgress();
        sendFinal();
      }, prompt.startsWith("slow:") ? 75 : 5);
    }
    return;
  }

  if (message.method === "turn/interrupt") {
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId !== message.params.turnId) {
      fail(message.id, "turn/interrupt used the wrong turnId");
      return;
    }
    respond(message.id, {});
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: completedTurn(activeTurnId, "interrupted") }
    });
    activeTurns.delete(message.params.threadId);
    return;
  }

  fail(message.id, `unsupported method: ${message.method}`);
});
