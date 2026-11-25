import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { notifyCodexObserver, parseAppServerActivity, type CodexActivityEvent } from "./activity.js";
import { resolveCodexCommand, type CodexRunResult } from "./exec-runner.js";
import { parseAccountRateLimits, type CodexAccountBalance } from "./account-balance.js";
import {
  appServerApprovalResult,
  isAppServerApprovalMethod,
  parseAppServerApproval,
  type AppServerApprovalMethod,
  type CodexApprovalDecision,
  type CodexApprovalHandler,
  type CodexApprovalPolicy,
  type CodexApprovalRequest
} from "./approval.js";
import {
  CodexRunError,
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  notifyExecutionStarted
} from "./run-lifecycle.js";
import type { CodexExecSandbox } from "./sandbox.js";

export type AppServerRunnerOptions = {
  codexBin?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  sandbox?: CodexExecSandbox;
  approvalPolicy?: CodexApprovalPolicy;
};

export type CodexRunnerInput = {
  prompt: string;
  cwd: string;
  threadId?: string;
  queueKey?: string;
  turnTimeoutMs?: number;
  model?: string;
  effort?: string;
  onExecutionStarted?: () => void;
  onActivity?: (event: CodexActivityEvent) => void;
  onFinalAnswerDelta?: (delta: string) => void;
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onApproval?: CodexApprovalHandler;
  onDynamicToolCall?: CodexDynamicToolHandler;
  onUserInput?: CodexUserInputHandler;
  dynamicTools?: readonly Record<string, unknown>[];
  collaborationMode?: "default" | "plan";
  ephemeral?: boolean;
  outputSchema?: Record<string, unknown>;
  sandbox?: CodexExecSandbox;
};

export type CodexDynamicToolCall = {
  callId: string;
  threadId: string;
  turnId: string;
  namespace?: string;
  tool: string;
  arguments: unknown;
};

export type CodexDynamicToolHandler = (call: CodexDynamicToolCall) => Promise<string>;

export type CodexUserInputQuestion = {
  header: string;
  id: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
};

export type CodexUserInputRequest = {
  itemId: string;
  threadId: string;
  turnId: string;
  autoResolutionMs?: number;
  questions: CodexUserInputQuestion[];
};

export type CodexUserInputAnswer = Record<string, { answers: string[] }>;
export type CodexUserInputHandler = (request: CodexUserInputRequest) => Promise<CodexUserInputAnswer>;

export type CodexThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "progress";
  createdAt?: string;
};

export type CodexRuntimeInfo = {
  model?: string;
  effort?: string;
  provider?: string;
};

export type CodexModelOption = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultEffort?: string;
  supportedEfforts: Array<{
    effort: string;
    description: string;
  }>;
};

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnCompletion = {
  status: string;
  text: string;
  raw: string;
  error?: string;
};

type ActiveTurn = {
  threadId: string;
  turnId: string;
  queueKey?: string;
  onApproval?: CodexApprovalHandler;
  approvals: Map<JsonRpcId, AbortController>;
};

type ApprovalCall = {
  id: JsonRpcId;
  method: AppServerApprovalMethod;
  request: CodexApprovalRequest;
};

type StartingTurnApprovals = {
  starts: number;
  calls: Map<JsonRpcId, ApprovalCall>;
};

type StartedTurn = {
  child: ChildProcessWithoutNullStreams;
  turnId: string;
};

type TurnWaiter = {
  resolve: (value: CodexRunResult) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  refresh: () => void;
};

type TurnStream = {
  onDelta?: (delta: string) => Promise<void> | void;
  onProgress?: (message: string) => Promise<void> | void;
  onActivity?: (event: CodexActivityEvent) => void;
  onFinalAnswerDelta?: (delta: string) => void;
  finalAnswerItemId?: string;
  chain: Promise<void>;
};

type TurnObservation =
  | { type: "activity"; activity: CodexActivityEvent }
  | { type: "finalAnswerDelta"; itemId: string; delta: string };

type QueuedTurnEvent = {
  type: "delta" | "progress";
  text: string;
};

type AppServerSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly" }
  | { readonly type: "workspaceWrite" };

type WireMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

// 只有携带轮次标识的工作通知能刷新执行计时。
const turnActivityMethods = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/plan/delta",
  "rawResponseItem/completed",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
  "turn/plan/updated"
]);

export class AppServerCodexRunner {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private connectPromise?: Promise<void>;
  private initialized = false;
  private closed = false;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly startingTurnApprovals = new Map<string, StartingTurnApprovals>();
  private readonly dynamicToolHandlersByThread = new Map<string, CodexDynamicToolHandler>();
  private readonly userInputHandlersByThread = new Map<string, CodexUserInputHandler>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnEvents = new Map<string, string[]>();
  private readonly turnTexts = new Map<string, string>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnStreams = new Map<string, TurnStream>();
  private readonly pendingTurnObservations = new Map<string, Map<string, TurnObservation[]>>();
  private readonly queuedTurnEvents = new Map<string, QueuedTurnEvent[]>();
  private readonly itemPhasesByTurn = new Map<string, Map<string, string>>();
  private readonly runtimeInfoByThread = new Map<string, CodexRuntimeInfo>();
  private modelOptions?: CodexModelOption[];

  constructor(private readonly options: AppServerRunnerOptions = {}) {}

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    await this.ensureConnected();

    if (input.threadId) {
      await this.waitForThreadIdle(input.threadId, input.onProgress);
    }

    const approvalPolicy = input.ephemeral ? "never" : this.options.approvalPolicy;
    const threadResponse = await this.request(
      input.threadId ? "thread/resume" : "thread/start",
      compactObject({
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(!input.threadId ? { ephemeral: input.ephemeral } : {}),
        cwd: input.cwd,
        model: input.model,
        // 默认由 Codex 按 cwd 解析项目权限，内部分类固定为只读且不发起审批。
        approvalPolicy,
        sandbox: input.ephemeral ? input.sandbox : undefined,
        ...(!input.threadId && input.dynamicTools ? { dynamicTools: input.dynamicTools } : {})
      })
    ) as Record<string, unknown>;
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : input.threadId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }
    this.runtimeInfoByThread.set(threadId, runtimeInfoFromThreadResponse(threadResponse));

    const runtimeInfo = this.runtimeInfoByThread.get(threadId);
    const collaborationModel = input.collaborationMode
      ? input.model ?? runtimeInfo?.model ?? (await this.getRuntimeInfo(input.cwd, threadId)).model
      : undefined;
    if (input.collaborationMode && !collaborationModel) {
      throw new Error("Codex collaboration mode requires a resolved model");
    }

    const turnParams = compactObject({
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy,
      sandboxPolicy: appServerSandboxPolicy(input.sandbox ?? this.options.sandbox),
      model: input.model,
      effort: input.effort,
      outputSchema: input.outputSchema,
      ...(input.collaborationMode ? {
        collaborationMode: {
          mode: input.collaborationMode,
          settings: {
            model: collaborationModel,
            reasoning_effort: input.effort ?? runtimeInfo?.effort ?? null,
            developer_instructions: null
          }
        }
      } : {})
    });
    let started: StartedTurn;
    if (input.onDynamicToolCall) this.dynamicToolHandlersByThread.set(threadId, input.onDynamicToolCall);
    if (input.onUserInput) this.userInputHandlersByThread.set(threadId, input.onUserInput);
    // 同一批输出可能先交付通知，再由 run 处理 turn/start 响应。
    const pendingObservations = input.onActivity || input.onFinalAnswerDelta
      ? new Map<string, TurnObservation[]>()
      : undefined;
    if (pendingObservations) this.pendingTurnObservations.set(threadId, pendingObservations);
    try {
      started = await this.startTurn(threadId, turnParams, input);
    } catch (error) {
      if (!input.threadId || !isThreadBusyError(error)) {
        this.dynamicToolHandlersByThread.delete(threadId);
        this.userInputHandlersByThread.delete(threadId);
        throw error;
      }
      try {
        await input.onProgress?.("当前会话刚刚开始了另一条任务，已排队等待完成。");
        await this.waitForThreadIdle(input.threadId);
        started = await this.startTurn(threadId, turnParams, input);
      } catch (retryError) {
        this.dynamicToolHandlersByThread.delete(threadId);
        this.userInputHandlersByThread.delete(threadId);
        throw retryError;
      }
    } finally {
      if (pendingObservations && this.pendingTurnObservations.get(threadId) === pendingObservations) {
        this.pendingTurnObservations.delete(threadId);
      }
    }
    const { child, turnId } = started;
    if (this.child !== child) throw new Error("Codex app-server stdio transport is not connected");
    const key = turnKey(threadId, turnId);
    let stream: TurnStream | undefined;
    if (input.onDelta || input.onProgress || input.onActivity || input.onFinalAnswerDelta) {
      stream = {
        onDelta: input.onDelta,
        onProgress: input.onProgress,
        onActivity: input.onActivity,
        onFinalAnswerDelta: input.onFinalAnswerDelta,
        chain: Promise.resolve()
      };
      this.turnStreams.set(key, stream);
      for (const event of this.queuedTurnEvents.get(key) ?? []) {
        this.enqueueTurnEvent(key, event);
      }
      this.queuedTurnEvents.delete(key);
    }
    const timeoutMs = input.turnTimeoutMs ?? this.options.turnTimeoutMs ?? this.options.requestTimeoutMs
      ?? DEFAULT_CODEX_TURN_TIMEOUT_MS;
    const completion = this.waitForTurn(threadId, turnId, timeoutMs);
    notifyExecutionStarted(input.onExecutionStarted);
    if (stream) {
      for (const observation of pendingObservations?.get(key) ?? []) {
        this.deliverTurnObservation(stream, observation);
      }
    }
    return completion;
  }

  async listSessions(): Promise<unknown> {
    await this.ensureConnected();
    return this.request("thread/list", {});
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    await this.ensureConnected();
    const response = await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
    const thread = response.thread as Record<string, unknown> | undefined;
    return parseThreadHistory(thread);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    const active = threadId ? this.runtimeInfoByThread.get(threadId) : undefined;
    if (active?.model || active?.effort) {
      return active;
    }
    await this.ensureConnected();
    const response = await this.request("config/read", { cwd, includeLayers: false }) as Record<string, unknown>;
    const config = response.config as Record<string, unknown> | undefined;
    return compactRuntimeInfo({
      model: config?.model,
      effort: config?.model_reasoning_effort,
      provider: config?.model_provider ?? config?.modelProvider
    });
  }

  async listModels(): Promise<CodexModelOption[]> {
    if (this.modelOptions) {
      return structuredClone(this.modelOptions);
    }
    await this.ensureConnected();
    const models: CodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.request("model/list", compactObject({
        cursor,
        includeHidden: false,
        limit: 100
      })) as Record<string, unknown>;
      const data = Array.isArray(response.data) ? response.data : [];
      for (const item of data) {
        const option = parseModelOption(item);
        if (option && !models.some((candidate) => candidate.model === option.model)) {
          models.push(option);
        }
      }
      const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    this.modelOptions = models;
    return structuredClone(models);
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    await this.ensureConnected();
    return parseAccountRateLimits(await this.request("account/rateLimits/read", {}));
  }

  async getGoal(threadId: string): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await this.request("thread/goal/get", { threadId }) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number }
  ): Promise<CodexThreadGoal | undefined> {
    await this.ensureConnected();
    const response = await this.request("thread/goal/set", {
      threadId,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {})
    }) as { goal?: unknown };
    return parseThreadGoal(response.goal);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.ensureConnected();
    await this.request("thread/goal/clear", { threadId });
  }

  async stop(threadId?: string, queueKey?: string): Promise<void> {
    if (!this.initialized || !this.child || this.child.exitCode !== null) {
      return;
    }

    const target = threadId !== undefined
      ? this.activeTurns.get(threadId)
      : [...this.activeTurns.values()].reverse().find((turn) => queueKey === undefined || turn.queueKey === queueKey);
    if (!target) {
      return;
    }

    await this.request("turn/interrupt", { threadId: target.threadId, turnId: target.turnId });
    if (this.activeTurns.get(target.threadId) === target) {
      target.onApproval = undefined;
      this.abortTurnApprovals(target);
      this.turnWaiters.get(turnKey(target.threadId, target.turnId))?.refresh();
    }
  }

  close(): void {
    this.closed = true;
    this.failTransport(new Error("Codex app-server runner closed"), true);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server runner is closed");
    }
    if (this.initialized && this.child?.exitCode === null && !this.child.stdin.destroyed) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.startAppServer().finally(() => {
        this.connectPromise = undefined;
      });
    }
    await this.connectPromise;
  }

  private async startAppServer(): Promise<void> {
    const command = resolveCodexCommand(this.options.codexBin ?? "codex");
    const child = spawn(command.command, [...command.argsPrefix, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.child = child;
    this.stderr = "";
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleMessage(child, line));
    this.lines.once("close", () => {
      if (this.child === child) this.failTransport(new Error("Codex app-server stdout closed"), true);
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this.failTransport(error, true);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child === child) this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.once("error", (error) => this.handleChildFailure(child, error));
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.handleChildFailure(
        child,
        new Error(`Codex app-server exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${suffix}`)
      );
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "codex-channel-bridge",
          title: "Codex Weixin",
          version: "0.2.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      }, Math.min(this.options.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS, 60_000));
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)), true);
      throw error;
    }
  }

  private async startTurn(
    threadId: string,
    params: Record<string, unknown>,
    input: CodexRunnerInput
  ): Promise<StartedTurn> {
    const child = this.child;
    const starting = input.onApproval
      ? this.startingTurnApprovals.get(threadId) ?? { starts: 0, calls: new Map<JsonRpcId, ApprovalCall>() }
      : undefined;
    if (starting) {
      starting.starts += 1;
      this.startingTurnApprovals.set(threadId, starting);
    }
    try {
      const response = await this.request("turn/start", params) as Record<string, unknown>;
      if (!child || this.child !== child) throw new Error("Codex app-server stdio transport is not connected");
      const turn = response.turn as Record<string, unknown> | undefined;
      const turnId = typeof turn?.id === "string" ? turn.id : undefined;
      if (!turnId) throw new Error("Codex app-server did not return a turn id");

      const active = this.completedTurns.has(turnKey(threadId, turnId)) ? undefined : {
        threadId,
        turnId,
        queueKey: input.queueKey,
        onApproval: input.onApproval,
        approvals: new Map<JsonRpcId, AbortController>()
      };
      if (active) this.activeTurns.set(threadId, active);
      // 审批可能与 turn/start 响应同批到达，确认轮次后再交给渠道。
      const calls = this.startingTurnApprovals.get(threadId)?.calls;
      if (calls) {
        for (const call of calls.values()) {
          if (call.request.turnId !== turnId) continue;
          calls.delete(call.id);
          this.handleTurnApproval(child, call, active);
        }
      }
      return { child, turnId };
    } finally {
      if (starting && --starting.starts === 0 && this.startingTurnApprovals.get(threadId) === starting) {
        this.startingTurnApprovals.delete(threadId);
        if (child) {
          for (const { id, method, request } of starting.calls.values()) {
            this.respondToServer(child, { id, result: appServerApprovalResult(method, request, "decline") });
          }
        }
      }
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new CodexRunError(`app-server request ${method} timed out after ${timeoutMs}ms`, "timed_out");
        this.pending.delete(id);
        reject(error);
        this.failTransport(new Error(error.message, { cause: error }), true);
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        clearTimeout(timer);
        this.pending.delete(id);
        reject(normalizedError);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(message: WireMessage): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdio transport is not connected");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private respondToServer(child: ChildProcessWithoutNullStreams, message: WireMessage): void {
    // 异步处理结束时，原连接可能已被替换。
    if (this.child !== child) return;
    try {
      this.send(message);
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)), true);
    }
  }

  private handleMessage(child: ChildProcessWithoutNullStreams, raw: string): void {
    if (this.child !== child) return;
    let message: WireMessage;
    try {
      message = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(child, message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params ?? {}, raw);
      return;
    }
    if (message.id === undefined) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = message.error.code === undefined ? "" : ` (${message.error.code})`;
      pending.reject(new Error(`app-server ${pending.method} failed${code}: ${message.error.message ?? "unknown error"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>, raw: string): void {
    if (turnActivityMethods.has(method)) {
      const key = turnKeyFromParams(params);
      if (key) this.turnWaiters.get(key)?.refresh();
    }

    if (method === "serverRequest/resolved") {
      this.handleResolvedApproval(params);
      return;
    }

    if (method === "item/started") {
      const key = turnKeyFromParams(params);
      if (!key) return;
      const item = params.item as Record<string, unknown> | undefined;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (itemId && item?.type === "agentMessage" && typeof item.phase === "string") {
        const phases = this.itemPhasesByTurn.get(key) ?? new Map<string, string>();
        phases.set(itemId, item.phase);
        this.itemPhasesByTurn.set(key, phases);
      }
      const activity = parseAppServerActivity(item, "started");
      if (activity) this.publishTurnObservation(params.threadId, key, { type: "activity", activity });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const key = turnKeyFromParams(params);
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!key || !itemId || !delta) return;
      const phase = this.itemPhasesByTurn.get(key)?.get(itemId);
      if (phase === "commentary") {
        return;
      }
      if (phase === "final_answer") {
        this.publishTurnObservation(params.threadId, key, { type: "finalAnswerDelta", itemId, delta });
      }
      if (this.turnStreams.has(key)) {
        this.enqueueTurnEvent(key, { type: "delta", text: delta });
      } else {
        this.queueTurnEvent(key, { type: "delta", text: delta });
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      if (!threadId || !turnId) {
        return;
      }
      const key = turnKey(threadId, turnId);
      this.appendTurnEvent(key, raw);
      const item = params.item as Record<string, unknown> | undefined;
      const activity = parseAppServerActivity(item, "completed");
      if (activity) this.publishTurnObservation(threadId, key, { type: "activity", activity });
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "commentary") {
          const progress = item.text.trim();
          if (progress) {
            if (this.turnStreams.has(key)) {
              this.enqueueTurnEvent(key, { type: "progress", text: progress });
            } else {
              this.queueTurnEvent(key, { type: "progress", text: progress });
            }
          }
        } else {
          this.turnTexts.set(key, item.text);
        }
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = params.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    if (!threadId || !turnId) {
      return;
    }
    const key = turnKey(threadId, turnId);
    this.appendTurnEvent(key, raw);
    const status = typeof turn?.status === "string" ? turn.status : "completed";
    const errorValue = turn?.error as Record<string, unknown> | undefined;
    const completion: TurnCompletion = {
      status,
      text: this.turnTexts.get(key) ?? extractAgentMessageFromTurn(turn),
      raw: (this.turnEvents.get(key) ?? []).join("\n"),
      error: typeof errorValue?.message === "string" ? errorValue.message : undefined
    };
    const active = this.activeTurns.get(threadId);
    if (active?.turnId === turnId) {
      this.activeTurns.delete(threadId);
      this.abortTurnApprovals(active);
    }
    this.dynamicToolHandlersByThread.delete(threadId);
    this.userInputHandlersByThread.delete(threadId);
    const waiter = this.turnWaiters.get(key);
    if (!waiter) {
      this.completedTurns.set(key, completion);
      return;
    }
    this.turnWaiters.delete(key);
    clearTimeout(waiter.timer);
    void this.finishTurn(threadId, key, completion, waiter.resolve, waiter.reject);
  }

  private waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<CodexRunResult> {
    const key = turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return new Promise((resolve, reject) => {
        void this.finishTurn(threadId, key, completed, resolve, reject);
      });
    }

    const active = this.activeTurns.get(threadId);
    return new Promise((resolve, reject) => {
      const expire = () => {
        this.turnWaiters.delete(key);
        const error = new CodexRunError(`app-server turn timed out after ${timeoutMs}ms`, "timed_out");
        reject(error);
        this.failTransport(new Error(error.message, { cause: error }), true);
      };
      const waiter: TurnWaiter = {
        resolve,
        reject,
        refresh: () => {
          clearTimeout(waiter.timer);
          // 最后一项人工审批结束后，从完整的无活动窗口重新计时。
          waiter.timer = active?.turnId === turnId && active.approvals.size
            ? undefined
            : setTimeout(expire, timeoutMs);
        }
      };
      this.turnWaiters.set(key, waiter);
      waiter.refresh();
    });
  }

  private async waitForThreadIdle(
    threadId: string,
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<void> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let notified = false;
    while (true) {
      const response = await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
      const thread = response.thread as Record<string, unknown> | undefined;
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const busy = turns.slice(-1).some((value) => {
        const turn = value as Record<string, unknown>;
        const status = typeof turn.status === "string"
          ? turn.status.replace(/[_\s-]/g, "").toLowerCase()
          : "";
        return status === "inprogress" || status === "running" || status === "started";
      });
      if (!busy) return;
      if (!notified) {
        notified = true;
        await onProgress?.("当前会话的上一条任务仍在执行，已排队等待完成。");
      }
      if (Date.now() >= deadline) {
        throw new CodexRunError(`等待已有会话空闲超时（${Math.round(timeoutMs / 1_000)} 秒）`, "timed_out");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async finishTurn(
    threadId: string,
    key: string,
    completion: TurnCompletion,
    resolve: (value: CodexRunResult) => void,
    reject: (error: Error) => void
  ): Promise<void> {
    const stream = this.turnStreams.get(key);
    this.turnStreams.delete(key);
    await stream?.chain;
    this.turnEvents.delete(key);
    this.turnTexts.delete(key);
    this.queuedTurnEvents.delete(key);
    this.itemPhasesByTurn.delete(key);
    if (completion.status === "completed") {
      resolve({ text: completion.text, threadId, turnId: key.slice(threadId.length + 1), raw: completion.raw });
      return;
    }
    if (completion.status === "interrupted") {
      reject(new CodexRunError("Codex app-server turn was interrupted", "cancelled"));
      return;
    }
    reject(new Error(completion.error ?? `Codex app-server turn ended with status ${completion.status}`));
  }

  private appendTurnEvent(key: string, raw: string): void {
    const events = this.turnEvents.get(key) ?? [];
    events.push(raw);
    this.turnEvents.set(key, events);
  }

  private queueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const queued = this.queuedTurnEvents.get(key) ?? [];
    queued.push(event);
    this.queuedTurnEvents.set(key, queued);
  }

  private publishTurnObservation(threadId: unknown, key: string, observation: TurnObservation): void {
    const stream = this.turnStreams.get(key);
    if (stream) {
      this.deliverTurnObservation(stream, observation);
      return;
    }
    const pending = typeof threadId === "string" ? this.pendingTurnObservations.get(threadId) : undefined;
    if (!pending) return;
    const observations = pending.get(key) ?? [];
    observations.push(observation);
    pending.set(key, observations);
  }

  private deliverTurnObservation(stream: TurnStream, observation: TurnObservation): void {
    if (observation.type === "activity") {
      notifyCodexObserver(stream.onActivity, observation.activity);
      return;
    }
    if (!stream.onFinalAnswerDelta) return;
    // 固定首个明确标为最终答案且已收到增量的条目，避免混合多条消息。
    stream.finalAnswerItemId ??= observation.itemId;
    if (stream.finalAnswerItemId === observation.itemId) {
      notifyCodexObserver(stream.onFinalAnswerDelta, observation.delta);
    }
  }

  private enqueueTurnEvent(key: string, event: QueuedTurnEvent): void {
    const stream = this.turnStreams.get(key);
    if (!stream) return;
    const callback = event.type === "progress" ? stream.onProgress : stream.onDelta;
    if (!callback) return;
    stream.chain = stream.chain
      .then(() => callback(event.text))
      .catch((error) => {
        console.warn(`Codex ${event.type} callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private handleServerRequest(child: ChildProcessWithoutNullStreams, message: WireMessage): void {
    const id = message.id as JsonRpcId;
    if (isAppServerApprovalMethod(message.method)) {
      const method = message.method;
      const request = parseAppServerApproval(method, message.params ?? {});
      if (!request) {
        const fallback = {
          kind: "command" as const,
          threadId: "",
          turnId: "",
          itemId: ""
        };
        this.respondToServer(child, { id, result: appServerApprovalResult(method, fallback, "decline") });
        return;
      }
      const call = { id, method, request };
      const active = this.activeTurns.get(request.threadId);
      if (active?.turnId === request.turnId) {
        this.handleTurnApproval(child, call, active);
      } else {
        const starting = this.startingTurnApprovals.get(request.threadId);
        if (starting) starting.calls.set(id, call);
        else this.handleTurnApproval(child, call);
      }
      return;
    }
    switch (message.method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        this.respondToServer(child, { id, result: { decision: "denied" } });
        return;
      case "item/tool/requestUserInput":
        this.handleUserInputRequest(child, id, message.params ?? {});
        return;
      case "mcpServer/elicitation/request":
        this.respondToServer(child, { id, result: { action: "cancel", content: null, _meta: null } });
        return;
      case "item/tool/call":
        this.handleDynamicToolRequest(child, id, message.params ?? {});
        return;
      case "currentTime/read":
        this.respondToServer(child, { id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      default:
        this.respondToServer(child, {
          id,
          error: { code: -32601, message: `Unsupported app-server request: ${message.method ?? "unknown"}` }
        });
    }
  }

  private handleTurnApproval(child: ChildProcessWithoutNullStreams, call: ApprovalCall, active?: ActiveTurn): void {
    if (this.child !== child) return;
    const { id, method, request } = call;
    if (!active?.onApproval) {
      this.respondToServer(child, { id, result: appServerApprovalResult(method, request, "decline") });
      return;
    }
    if (active.approvals.has(id)) return;

    const controller = new AbortController();
    active.approvals.set(id, controller);
    this.turnWaiters.get(turnKey(active.threadId, active.turnId))?.refresh();
    void this.resolveApproval(child, call, active, active.onApproval, controller);
  }

  private async resolveApproval(
    child: ChildProcessWithoutNullStreams,
    { id, method, request }: ApprovalCall,
    active: ActiveTurn,
    handler: CodexApprovalHandler,
    controller: AbortController
  ): Promise<void> {
    let decision: CodexApprovalDecision;
    try {
      decision = await handler(request, controller.signal) === "accept" ? "accept" : "decline";
    } catch {
      decision = "decline";
    }
    if (controller.signal.aborted) return;
    this.respondToServer(child, { id, result: appServerApprovalResult(method, request, decision) });
    if (active.approvals.delete(id)) this.turnWaiters.get(turnKey(active.threadId, active.turnId))?.refresh();
  }

  private handleResolvedApproval(params: Record<string, unknown>): void {
    const { threadId, requestId } = params;
    if (typeof threadId !== "string" || (typeof requestId !== "number" && typeof requestId !== "string")) return;

    const active = this.activeTurns.get(threadId);
    const controller = active?.approvals.get(requestId);
    if (active && controller) {
      active.approvals.delete(requestId);
      controller.abort();
      this.turnWaiters.get(turnKey(active.threadId, active.turnId))?.refresh();
    } else {
      this.startingTurnApprovals.get(threadId)?.calls.delete(requestId);
    }
  }

  private abortTurnApprovals(turn: ActiveTurn): void {
    const approvals = [...turn.approvals.values()];
    turn.approvals.clear();
    for (const controller of approvals) controller.abort();
  }

  private handleDynamicToolRequest(
    child: ChildProcessWithoutNullStreams,
    id: JsonRpcId,
    params: Record<string, unknown>
  ): void {
    const call = parseDynamicToolCall(params);
    const handler = call ? this.dynamicToolHandlersByThread.get(call.threadId) : undefined;
    if (!call || !handler) {
      this.respondToServer(child, {
        id,
        result: {
          contentItems: [{ type: "inputText", text: "当前会话没有启用该动态工具。" }],
          success: false
        }
      });
      return;
    }
    Promise.resolve().then(() => handler(call))
      .then((text) => this.respondToServer(child, {
        id,
        result: { contentItems: [{ type: "inputText", text }], success: true }
      }))
      .catch((error) => this.respondToServer(child, {
        id,
        result: {
          contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
          success: false
        }
      }));
  }

  private handleUserInputRequest(
    child: ChildProcessWithoutNullStreams,
    id: JsonRpcId,
    params: Record<string, unknown>
  ): void {
    const request = parseUserInputRequest(params);
    const handler = request ? this.userInputHandlersByThread.get(request.threadId) : undefined;
    if (!request || !handler) {
      this.respondToServer(child, { id, result: { answers: {} } });
      return;
    }
    Promise.resolve().then(() => handler(request))
      .then((answers) => this.respondToServer(child, { id, result: { answers } }))
      .catch(() => this.respondToServer(child, { id, result: { answers: {} } }));
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.failTransport(error, false);
  }

  private failTransport(error: Error, kill: boolean): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    this.lines?.close();
    this.lines = undefined;
    if (kill && child?.exitCode === null) {
      child.kill();
    }
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [key, waiter] of this.turnWaiters.entries()) {
      this.turnWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    const activeTurns = [...this.activeTurns.values()];
    this.activeTurns.clear();
    this.startingTurnApprovals.clear();
    this.dynamicToolHandlersByThread.clear();
    this.userInputHandlersByThread.clear();
    this.turnEvents.clear();
    this.turnTexts.clear();
    this.completedTurns.clear();
    this.turnStreams.clear();
    this.pendingTurnObservations.clear();
    this.queuedTurnEvents.clear();
    this.itemPhasesByTurn.clear();
    this.runtimeInfoByThread.clear();
    this.modelOptions = undefined;
    for (const turn of activeTurns) this.abortTurnApprovals(turn);
  }
}

function appServerSandboxPolicy(sandbox: CodexExecSandbox | undefined): AppServerSandboxPolicy | undefined {
  switch (sandbox) {
    case undefined:
      return undefined;
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

function parseDynamicToolCall(params: Record<string, unknown>): CodexDynamicToolCall | undefined {
  if (
    typeof params.callId !== "string"
    || typeof params.threadId !== "string"
    || typeof params.turnId !== "string"
    || typeof params.tool !== "string"
  ) {
    return undefined;
  }
  return {
    callId: params.callId,
    threadId: params.threadId,
    turnId: params.turnId,
    tool: params.tool,
    arguments: params.arguments,
    ...(typeof params.namespace === "string" ? { namespace: params.namespace } : {})
  };
}

function parseUserInputRequest(params: Record<string, unknown>): CodexUserInputRequest | undefined {
  if (
    typeof params.itemId !== "string"
    || typeof params.threadId !== "string"
    || typeof params.turnId !== "string"
    || !Array.isArray(params.questions)
  ) {
    return undefined;
  }
  const questions = params.questions.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.header !== "string" || typeof item.id !== "string" || typeof item.question !== "string") {
      return [];
    }
    const options = Array.isArray(item.options)
      ? item.options.flatMap((rawOption) => {
          if (!rawOption || typeof rawOption !== "object") return [];
          const option = rawOption as Record<string, unknown>;
          return typeof option.label === "string" && typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [];
        })
      : [];
    return [{
      header: item.header,
      id: item.id,
      question: item.question,
      ...(options.length ? { options } : {})
    }];
  });
  if (!questions.length) return undefined;
  return {
    itemId: params.itemId,
    threadId: params.threadId,
    turnId: params.turnId,
    questions,
    ...(typeof params.autoResolutionMs === "number" ? { autoResolutionMs: params.autoResolutionMs } : {})
  };
}

function parseThreadGoal(value: unknown): CodexThreadGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Record<string, unknown>;
  if (
    typeof goal.threadId !== "string"
    || typeof goal.objective !== "string"
    || !isGoalStatus(goal.status)
    || typeof goal.tokensUsed !== "number"
    || typeof goal.timeUsedSeconds !== "number"
    || typeof goal.createdAt !== "number"
    || typeof goal.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {})
  };
}

function isGoalStatus(value: unknown): value is CodexThreadGoalStatus {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete";
}

function isThreadBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already.*(active|running)|turn.*(active|in progress|running)|thread.*busy/i.test(message);
}

function turnKeyFromParams(params: Record<string, unknown>): string | undefined {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  return threadId && turnId ? turnKey(threadId, turnId) : undefined;
}

function parseModelOption(value: unknown): CodexModelOption | undefined {
  const model = value as Record<string, unknown>;
  const modelId = typeof model.model === "string" && model.model
    ? model.model
    : typeof model.id === "string" ? model.id : "";
  if (!modelId || model.hidden === true) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
      const effort = value as Record<string, unknown>;
      return typeof effort.reasoningEffort === "string" && effort.reasoningEffort
        ? [{
          effort: effort.reasoningEffort,
          description: typeof effort.description === "string" ? effort.description : ""
        }]
        : [];
    })
    : [];
  return {
    model: modelId,
    displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : modelId,
    description: typeof model.description === "string" ? model.description : "",
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort
      ? { defaultEffort: model.defaultReasoningEffort }
      : {}),
    supportedEfforts: efforts
  };
}

function runtimeInfoFromThreadResponse(response: Record<string, unknown>): CodexRuntimeInfo {
  return compactRuntimeInfo({
    model: response.model,
    effort: response.reasoningEffort,
    provider: response.modelProvider ?? response.model_provider
  });
}

function compactRuntimeInfo(input: { model?: unknown; effort?: unknown; provider?: unknown }): CodexRuntimeInfo {
  return {
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    ...(typeof input.effort === "string" && input.effort ? { effort: input.effort } : {}),
    ...(typeof input.provider === "string" && input.provider ? { provider: input.provider } : {})
  };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function extractAgentMessageFromTurn(turn: Record<string, unknown> | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as Record<string, unknown>;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

export function parseThreadHistory(thread: Record<string, unknown> | undefined): CodexHistoryMessage[] {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: CodexHistoryMessage[] = [];
  for (const rawTurn of turns) {
    const turn = rawTurn as Record<string, unknown>;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userCreatedAt = unixSecondsToIso(turn.startedAt);
    const assistantCreatedAt = unixSecondsToIso(turn.completedAt ?? turn.startedAt);
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : `${String(turn.id ?? "turn")}:${messages.length}`;
      if (item.type === "userMessage") {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({ id, role: "user", text, ...(userCreatedAt ? { createdAt: userCreatedAt } : {}) });
        }
        continue;
      }
      if (
        item.type === "agentMessage"
        && typeof item.text === "string"
        && item.text.trim()
      ) {
        messages.push({
          id,
          role: "assistant",
          text: item.text.trim(),
          ...(item.phase === "commentary" ? { kind: "progress" as const } : {}),
          ...(assistantCreatedAt ? { createdAt: assistantCreatedAt } : {})
        });
      }
    }
  }
  return messages;
}

function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      return `[本机图片: ${item.path}]`;
    }
    if (item.type === "image" && typeof item.url === "string") {
      return `[图片: ${item.url}]`;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}
