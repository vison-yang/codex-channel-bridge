import { randomUUID } from "node:crypto";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { ChannelStreamReply } from "./types.js";
import { FeishuFeedbackApi } from "./feishu-feedback-api.js";

export type FeishuCardKit = {
  card: Pick<Lark.Client["cardkit"]["v1"]["card"], "create" | "settings">;
  cardElement: Pick<Lark.Client["cardkit"]["v1"]["cardElement"], "content">;
};

const ELEMENT_ID = "codex_reply";
const UPDATE_INTERVAL_MS = 1_000;
const MAX_STREAM_BYTES = 12_000;
const PREVIEW_MARKUP = /[`[<]|(?:^|\n)\s*[$>]\s/;
const PREVIEW_CREDENTIAL = /\b(?:authorization|cookie|[\w-]*(?:secret|password|passwd|api[_ -]?key|token|credential)[\w-]*)\s*(?:[:=]|\bis\b)|\bbearer\s|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)/i;

export class FeishuStreamReply implements ChannelStreamReply {
  private draft = "";
  private published = "";
  private cardId?: string;
  private messageId?: string;
  private sequence = 0;
  private timer?: NodeJS.Timeout;
  private write?: Promise<void>;
  private terminal?: Promise<string | undefined>;
  private disabled = false;

  constructor(
    private readonly cardKit: FeishuCardKit,
    private readonly api: FeishuFeedbackApi,
    private readonly send: (content: string) => Promise<string>
  ) {}

  get isOpen(): boolean {
    return !this.terminal;
  }

  delta(text: string): void {
    if (this.terminal || this.disabled) return;
    this.draft = (this.draft + text).slice(0, MAX_STREAM_BYTES);
    this.schedule();
  }

  finish(text?: string): Promise<string | undefined> {
    return this.terminal ??= this.complete(text);
  }

  async settled(): Promise<void> {
    await this.terminal;
  }

  private schedule(): void {
    if (this.timer || this.write || this.terminal || this.disabled) return;
    if (previewText(this.draft) === this.published) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write = this.flush().finally(() => {
        this.write = undefined;
        this.schedule();
      });
    }, UPDATE_INTERVAL_MS);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    const text = previewText(this.draft);
    if (!text || text === this.published) return;
    try {
      if (!this.messageId) {
        const response = await this.api.run("create streaming card", () => this.cardKit.card.create({
          data: {
            type: "card_json",
            data: JSON.stringify({
              schema: "2.0",
              config: { streaming_mode: true, summary: { content: "正在生成 Codex 回复" } },
              body: { elements: [{ tag: "markdown", element_id: ELEMENT_ID, content: text }] }
            })
          }
        }));
        this.cardId = response.data?.card_id;
        if (!this.cardId) throw new Error("Feishu did not return a card_id");
        this.messageId = await this.send(JSON.stringify({ type: "card", data: { card_id: this.cardId } }));
      } else {
        await this.update(text);
      }
      this.published = text;
    } catch {
      this.disabled = true;
      console.warn("[codex-channel-bridge] Feishu streaming reply update failed");
    }
  }

  private async complete(text?: string): Promise<string | undefined> {
    clearTimeout(this.timer);
    await this.write;
    if (!this.cardId) return undefined;

    const content = text && cardText(text);
    const hasFinalReply = Boolean(this.messageId && content && Buffer.byteLength(content) <= MAX_STREAM_BYTES);
    let delivered = false;
    try {
      if (this.messageId) {
        const display = hasFinalReply ? content! : text ? "完整回复见后续消息。" : "本次回复已停止。";
        if (display !== this.published) await this.update(display);
        delivered = hasFinalReply;
      }
    } catch {
      console.warn("[codex-channel-bridge] Feishu streaming reply final text failed");
    } finally {
      try {
        const data = {
          settings: JSON.stringify({ config: {
            streaming_mode: false,
            summary: { content: delivered ? "Codex 回复" : "Codex 流式回复已结束" }
          } }),
          ...this.nextOperation()
        };
        await this.api.run("close streaming card", () => this.cardKit.card.settings({
          path: { card_id: this.cardId! }, data
        }));
      } catch {
        console.warn("[codex-channel-bridge] Feishu could not close streaming reply card");
      }
    }
    return delivered ? this.messageId : undefined;
  }

  private async update(content: string): Promise<void> {
    const data = { content, ...this.nextOperation() };
    await this.api.run("update streaming reply", () => this.cardKit.cardElement.content({
      path: { card_id: this.cardId!, element_id: ELEMENT_ID }, data
    }));
  }

  private nextOperation(): { sequence: number; uuid: string } {
    return { sequence: ++this.sequence, uuid: randomUUID() };
  }
}

function previewText(draft: string): string {
  // 暂缓包含代码、链接、动作块或凭证样式的草稿，等 Bridge 生成最终可见文本。
  const markers = [draft.search(PREVIEW_MARKUP), draft.search(PREVIEW_CREDENTIAL)].filter((index) => index >= 0);
  const candidate = draft.slice(0, Math.min(draft.length, ...markers));
  let boundary = 0;
  for (const match of candidate.matchAll(/\n|[。！？]|[.!?](?=\s|$)/gu)) {
    boundary = match.index + match[0].length;
  }
  const text = cardText(candidate.slice(0, boundary).trim());
  return Buffer.byteLength(text) <= MAX_STREAM_BYTES ? text : "";
}

function cardText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
