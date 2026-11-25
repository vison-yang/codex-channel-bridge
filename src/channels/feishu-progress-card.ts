import { performance } from "node:perf_hooks";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { CodexActivityEvent } from "../codex/activity.js";
import type { ChannelTaskOutcome } from "./types.js";

type ProgressCardTransport = {
  send(card: Lark.InteractiveCard): Promise<string>;
  update(id: string, card: Lark.InteractiveCard): Promise<void>;
};

type ProgressCardClock = {
  now(): number;
  schedule(callback: () => void, delayMs: number, keepAlive: boolean): () => void;
};

const defaultClock: ProgressCardClock = {
  now: () => performance.now(),
  schedule(callback, delayMs, keepAlive) {
    const timer = setTimeout(callback, delayMs);
    if (!keepAlive) timer.unref();
    return () => clearTimeout(timer);
  }
};

const createDelayMs = 10_000;
const updateIntervalMs = 5_000;
const activityLabels = {
  command: "命令执行",
  file: "文件处理",
  mcp: "外部工具",
  dynamic: "扩展工具",
  search: "搜索",
  agent: "智能体协作",
  image: "图片处理"
} as const;
const outcomeLabels = {
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  timed_out: "已超时"
} as const;
const outcomeTemplates = {
  succeeded: "green",
  failed: "red",
  cancelled: "grey",
  timed_out: "orange"
} as const;

/** Sends one delayed, rate-limited status card without exposing activity payloads. */
export class FeishuProgressCard {
  private readonly activities = new Map<string, Pick<CodexActivityEvent, "kind" | "status">>();
  private readonly agents = new Map<string, "pending" | "running" | "completed" | "failed" | "stopped">();
  private readonly terminal: Promise<void>;
  private resolveTerminal!: () => void;
  private startedAt?: number;
  private finishedAt?: number;
  private outcome?: ChannelTaskOutcome;
  private messageId?: string;
  private lastWriteAt = 0;
  private cancelTimer?: () => void;
  private inFlight?: Promise<void>;
  private disabled = false;
  private updatesPaused = false;
  private terminalAttempted = false;

  constructor(private readonly transport: ProgressCardTransport, private readonly clock: ProgressCardClock = defaultClock) {
    this.terminal = new Promise((resolve) => { this.resolveTerminal = resolve; });
  }

  start(): void {
    if (this.startedAt !== undefined || this.outcome) return;
    this.startedAt = this.clock.now();
    this.arm(createDelayMs, false, () => this.create());
  }

  activity(event: CodexActivityEvent): void {
    if (this.startedAt === undefined || this.outcome) return;
    if (!event.id || !Object.hasOwn(activityLabels, event.kind)) return;
    if (event.status !== "running" && event.status !== "completed" && event.status !== "failed") return;
    this.activities.set(event.id, { kind: event.kind, status: event.status });
    for (const agent of event.agents ?? []) {
      if (!agent.id) continue;
      if (agent.status === "pending" || agent.status === "running" || agent.status === "completed"
        || agent.status === "failed" || agent.status === "stopped") {
        this.agents.set(agent.id, agent.status);
      }
    }
    this.scheduleUpdate();
  }

  finish(outcome: ChannelTaskOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.finishedAt = this.clock.now();
    this.clearTimer();
    if (!this.messageId && !this.inFlight) {
      this.resolveTerminal();
      return;
    }
    this.scheduleUpdate();
  }

  settled(): Promise<void> {
    return this.outcome ? this.terminal : (this.inFlight ?? Promise.resolve());
  }

  private create(): void {
    if (this.outcome || this.messageId || this.disabled || this.inFlight) return;
    const card = this.render();
    this.inFlight = Promise.resolve()
      .then(() => {
        this.lastWriteAt = this.clock.now();
        return this.transport.send(card);
      })
      .then((id) => {
        if (!id) throw new Error("Feishu did not return a card message ID");
        this.messageId = id;
      })
      .catch(() => {
        this.disabled = true;
        console.warn("[codex-channel-bridge] Feishu progress card could not be created");
      })
      .finally(() => {
        this.inFlight = undefined;
        if (this.disabled && this.outcome) this.resolveTerminal();
        else this.scheduleUpdate();
      });
  }

  private scheduleUpdate(): void {
    if (!this.messageId || this.disabled || this.inFlight || this.cancelTimer || this.terminalAttempted) return;
    if (this.updatesPaused && !this.outcome) return;
    const delayMs = Math.max(0, this.lastWriteAt + updateIntervalMs - this.clock.now());
    this.arm(delayMs, Boolean(this.outcome), () => this.update());
  }

  private update(): void {
    if (!this.messageId || this.disabled || this.inFlight || this.terminalAttempted) return;
    const messageId = this.messageId;
    const isTerminal = Boolean(this.outcome);
    const card = this.render();
    this.inFlight = Promise.resolve()
      .then(() => {
        this.lastWriteAt = this.clock.now();
        return this.transport.update(messageId, card);
      })
      .catch(() => {
        this.updatesPaused = true;
        console.warn("[codex-channel-bridge] Feishu progress card could not be updated");
      })
      .finally(() => {
        this.inFlight = undefined;
        if (isTerminal) {
          this.terminalAttempted = true;
          this.resolveTerminal();
        } else {
          this.scheduleUpdate();
        }
      });
  }

  private arm(delayMs: number, keepAlive: boolean, callback: () => void): void {
    this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined;
      callback();
    }, delayMs, keepAlive);
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private render(): Lark.InteractiveCard {
    const elapsed = Math.max(0, (this.finishedAt ?? this.clock.now()) - (this.startedAt ?? this.clock.now()));
    const status = this.outcome ? outcomeLabels[this.outcome] : "进行中";
    const details = Object.entries(activityLabels).flatMap(([kind, label]) => {
      const matching = [...this.activities.values()].filter((activity) => activity.kind === kind);
      if (!matching.length) return [];
      const counts = [
        ["进行中", matching.filter((activity) => activity.status === "running").length],
        ["已完成", matching.filter((activity) => activity.status === "completed").length],
        ["失败", matching.filter((activity) => activity.status === "failed").length]
      ].filter(([, count]) => count).map(([name, count]) => `${name} ${count}`);
      return [`${label}：${counts.join(" · ")}`];
    });
    const agentCounts = [
      ["等待", "pending"], ["进行中", "running"], ["已完成", "completed"],
      ["失败", "failed"], ["已停止", "stopped"]
    ].flatMap(([label, state]) => {
      const count = [...this.agents.values()].filter((status) => status === state).length;
      return count ? [`${label} ${count}`] : [];
    });
    const lines = [
      `状态：${status}`,
      `已用时：${formatElapsed(elapsed)}`,
      ...(details.length ? ["", "工具概览", ...details] : []),
      ...(agentCounts.length ? ["", `子智能体：${agentCounts.join(" · ")}`] : [])
    ];
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: this.outcome ? outcomeTemplates[this.outcome] : "blue",
        title: { tag: "plain_text", content: "任务进度" }
      },
      elements: [{ tag: "div", text: { tag: "plain_text", content: lines.join("\n") } }]
    };
  }
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remaining = seconds % 60;
  return [hours ? `${hours} 小时` : "", minutes ? `${minutes} 分` : "", `${remaining} 秒`].filter(Boolean).join(" ");
}
