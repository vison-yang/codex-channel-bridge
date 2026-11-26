import { performance } from "node:perf_hooks";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { CodexActivityEvent } from "../codex/activity.js";
import type { ChannelMessageFeedback, ChannelTaskOutcome } from "./types.js";
import { FeishuFeedbackApi, feishuGetTiming } from "./feishu-feedback-api.js";
import type { FeishuProgressCard } from "./feishu-progress-card.js";
import type { FeishuStreamReply } from "./feishu-stream-reply.js";

export type FeishuReactions = Pick<Lark.Client["im"]["v1"]["messageReaction"], "create" | "delete">;

const outcomeEmoji = { succeeded: "DONE", failed: "ERROR", cancelled: "CrossMark", timed_out: "Alarm" } as const;
type ReactionEmoji = "Get" | "Typing" | typeof outcomeEmoji[ChannelTaskOutcome];

export class FeishuMessageFeedback implements ChannelMessageFeedback {
  readonly activity?: (event: CodexActivityEvent) => void;
  private readonly received?: Promise<void>;
  private typing?: Promise<string | undefined>;
  private terminal?: Promise<void>;
  private outcome?: ChannelTaskOutcome;

  constructor(
    private readonly messageId: string,
    private readonly reactions: FeishuReactions | undefined,
    private readonly api: FeishuFeedbackApi,
    receivedAt: number,
    private readonly progress?: FeishuProgressCard,
    private readonly streamReply?: FeishuStreamReply
  ) {
    if (progress) this.activity = (event) => progress.activity(event);
    if (reactions) this.received = this.acknowledge(receivedAt);
  }

  get stream(): FeishuStreamReply | undefined {
    return this.streamReply?.isOpen ? this.streamReply : undefined;
  }

  start(showProgress = true): void {
    if (this.terminal) return;
    if (this.reactions) this.typing ??= this.add("Typing");
    if (showProgress) this.progress?.start();
  }

  recordOutcome(outcome: ChannelTaskOutcome): void {
    if (!this.outcome || this.outcome === "succeeded") this.outcome = outcome;
  }

  finish(outcome = this.outcome): void {
    if (this.terminal || !outcome) return;
    this.progress?.finish(outcome);
    if (outcome !== "succeeded") void this.streamReply?.finish();
    this.terminal = this.complete(outcome);
  }

  async settled(): Promise<void> {
    await Promise.all([this.received, this.terminal, this.progress?.settled(), this.streamReply?.settled()]);
  }

  private async acknowledge(receivedAt: number): Promise<void> {
    const localMs = performance.now() - receivedAt;
    const timing = { attempts: 0, backoffMs: 0, tokenMs: 0, reactionMs: 0 };
    const reactionId = await feishuGetTiming.run(timing, () => this.add("Get"));
    const totalMs = (performance.now() - receivedAt).toFixed(1);
    const segments = `localMs=${localMs.toFixed(1)} backoffMs=${timing.backoffMs.toFixed(1)} `
      + `tokenMs=${timing.tokenMs.toFixed(1)} reactionMs=${timing.reactionMs.toFixed(1)} attempts=${timing.attempts}`;
    if (reactionId) {
      console.log(`[codex-channel-bridge] Feishu Get acknowledged in ${totalMs}ms (${segments})`);
    } else {
      console.warn(`[codex-channel-bridge] Feishu could not add Get reaction after ${totalMs}ms (${segments})`);
    }
  }

  private async complete(outcome: ChannelTaskOutcome): Promise<void> {
    const reactions = this.reactions;
    if (!reactions) return;
    const reactionId = await this.typing;
    if (reactionId) {
      try {
        await this.api.run("remove reaction", () => reactions.delete({
          path: { message_id: this.messageId, reaction_id: reactionId }
        }));
      } catch {
        console.warn("[codex-channel-bridge] Feishu could not remove Typing reaction");
      }
    }
    await this.add(outcomeEmoji[outcome]);
  }

  private async add(emoji: ReactionEmoji): Promise<string | undefined> {
    const reactions = this.reactions;
    if (!reactions) return undefined;
    try {
      const response = await this.api.run("add reaction", () => reactions.create({
        path: { message_id: this.messageId },
        data: { reaction_type: { emoji_type: emoji } }
      }));
      if (!response.data?.reaction_id) throw new Error("Feishu did not return a reaction_id");
      return response.data.reaction_id;
    } catch {
      if (emoji !== "Get") console.warn(`[codex-channel-bridge] Feishu could not add ${emoji} reaction`);
      return undefined;
    }
  }
}
