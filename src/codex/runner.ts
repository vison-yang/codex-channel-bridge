import {
  AppServerCodexRunner,
  isThreadWriterConflictError,
  type CodexHistoryMessage,
  type CodexModelOption,
  type CodexRunnerInput,
  type CodexRuntimeInfo,
  type CodexThreadGoal,
  type CodexThreadGoalStatus
} from "./app-server-runner.js";
import { CodexExecRunner, type CodexRunResult } from "./exec-runner.js";
import { DEFAULT_CODEX_REQUEST_TIMEOUT_MS, DEFAULT_CODEX_TURN_TIMEOUT_MS, codexFailureOutcome } from "./run-lifecycle.js";
import type { CodexApprovalPolicy } from "./approval.js";
import type { CodexExecSandbox } from "./sandbox.js";
import type { CodexAccountBalance } from "./account-balance.js";
import type { CodexWeixinConfig } from "../state/config.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type HybridCodexRunnerOptions = {
  backend: CodexBackend;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
};

export type EphemeralCodexRunnerInput = {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly outputSchema?: Record<string, unknown>;
};

export class HybridCodexRunner {
  private readonly appServer: AppServerCodexRunner;
  private readonly exec: CodexExecRunner;
  private readonly runTails = new Map<string, Promise<void>>();
  private readonly sessionRunTails = new Map<string, Promise<void>>();

  constructor(private readonly options: HybridCodexRunnerOptions) {
    const turnTimeoutMs = options.turnTimeoutMs ?? options.timeoutMs ?? DEFAULT_CODEX_TURN_TIMEOUT_MS;
    this.appServer = new AppServerCodexRunner({
      codexBin: options.codexBin,
      requestTimeoutMs: options.requestTimeoutMs ?? options.timeoutMs,
      turnTimeoutMs,
      sandbox: options.execSandbox,
      approvalPolicy: options.approvalPolicy
    });
    this.exec = new CodexExecRunner({
      codexBin: options.codexBin,
      sandbox: options.execSandbox,
      approvalPolicy: options.approvalPolicy,
      timeoutMs: turnTimeoutMs
    });
  }

  run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const getBoundThreadId = input.getBoundThreadId;
    if (!getBoundThreadId) {
      return this.runQueued(this.runTails, input.queueKey ?? input.threadId, input.onProgress, () => this.runImmediately(input));
    }
    // 先进入托管会话的队列，再读取上一个请求可能已更新的绑定。
    return this.runQueued(this.sessionRunTails, input.queueKey, input.onProgress, () => {
      const threadId = getBoundThreadId();
      return this.runQueued(this.runTails, threadId, input.onProgress, (tail) => {
        return this.runManagedThread({ ...input, threadId }, tail);
      });
    });
  }

  private async runManagedThread(input: CodexRunnerInput, tail?: Promise<void>): Promise<CodexRunResult> {
    const onThreadForked = input.onThreadForked;
    if (!tail || !onThreadForked) return this.runImmediately(input);

    let forkedThreadId: string | undefined;
    try {
      return await this.runImmediately({
        ...input,
        onThreadForked: (threadId) => {
          if (this.runTails.has(threadId)) throw new Error("Codex fork returned a thread id already queued");
          // 在公开新绑定之前占住新线程的队列，避免另一会话交错启动轮次。
          this.runTails.set(threadId, tail);
          forkedThreadId = threadId;
          onThreadForked(threadId);
        }
      });
    } finally {
      if (forkedThreadId && this.runTails.get(forkedThreadId) === tail) this.runTails.delete(forkedThreadId);
    }
  }

  private async runQueued(
    tails: Map<string, Promise<void>>,
    queueKey: string | undefined,
    onProgress: CodexRunnerInput["onProgress"],
    run: (tail?: Promise<void>) => Promise<CodexRunResult>
  ): Promise<CodexRunResult> {
    if (!queueKey) return run();

    const predecessor = tails.get(queueKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (predecessor ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    tails.set(queueKey, tail);
    try {
      if (predecessor) {
        await onProgress?.("当前会话的上一条消息仍在处理中，已加入队列。");
        await predecessor.catch(() => undefined);
      }
      return await run(tail);
    } finally {
      release();
      if (tails.get(queueKey) === tail) {
        tails.delete(queueKey);
      }
    }
  }

  private async runImmediately(input: CodexRunnerInput): Promise<CodexRunResult> {
    const requiresAppServerForStreaming = Boolean(input.onDelta || input.onProgress || input.onApproval);
    if (this.options.backend === "exec" && !requiresAppServerForStreaming) {
      return this.exec.run(input);
    }
    let hasStarted = false;
    let hasForked = false;
    const onThreadForked = input.onThreadForked;
    try {
      return await this.appServer.run({
        ...input,
        onThreadForked: onThreadForked && ((threadId) => {
          hasForked = true;
          onThreadForked(threadId);
        }),
        onExecutionStarted: () => {
          hasStarted = true;
          input.onExecutionStarted?.();
        }
      });
    } catch (error) {
      if (this.options.backend === "app-server" || input.onApproval || hasForked || codexFailureOutcome(error) !== "failed"
        || ((input.getBoundThreadId || onThreadForked) && isThreadWriterConflictError(error))) {
        throw error;
      }
      const fallback = await this.exec.run({
        ...input,
        onExecutionStarted: hasStarted ? undefined : input.onExecutionStarted,
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string, queueKey?: string): Promise<void> {
    // 托管请求的活动轮次可能已经转到副本，按请求进入时的会话标识查找。
    const targetThreadId = queueKey && this.sessionRunTails.has(queueKey) ? undefined : threadId;
    await Promise.all([
      this.appServer.stop(targetThreadId, queueKey),
      this.exec.stop(targetThreadId, queueKey)
    ]);
  }

  runEphemeral(input: EphemeralCodexRunnerInput): Promise<CodexRunResult> {
    return this.appServer.run({
      ...input,
      ephemeral: true,
      turnTimeoutMs: this.options.requestTimeoutMs ?? this.options.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
      sandbox: "read-only"
    });
  }

  async warmUp(cwd: string): Promise<void> {
    await this.appServer.getRuntimeInfo(cwd);
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    return this.appServer.getHistory(threadId);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    return this.appServer.getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  async getAccountRateLimits(): Promise<CodexAccountBalance> {
    return this.appServer.getAccountRateLimits();
  }

  async getGoal(threadId: string): Promise<CodexThreadGoal | undefined> {
    return this.appServer.getGoal(threadId);
  }

  async setGoal(
    threadId: string,
    input: { objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number }
  ): Promise<CodexThreadGoal | undefined> {
    return this.appServer.setGoal(threadId, input);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.appServer.clearGoal(threadId);
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
  }
}

export function createConfiguredCodexRunner(config: CodexWeixinConfig): HybridCodexRunner {
  return new HybridCodexRunner({
    backend: config.codexBackend,
    codexBin: config.codexBin,
    execSandbox: config.codexExecSandbox,
    approvalPolicy: config.codexApprovalPolicy,
    requestTimeoutMs: config.codexRequestTimeoutMs,
    turnTimeoutMs: config.codexTurnTimeoutMs
  });
}
