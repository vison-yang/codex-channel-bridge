import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuAccount } from "../weixin/accounts.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import { codexFailureOutcome } from "../codex/run-lifecycle.js";
import type { ChannelAdapter, ChannelMonitorOptions, ChannelTextClient } from "./types.js";
import { feishuActionCard } from "./feishu-action-card.js";
import { cardActionIdentity, formValueFromRawCardAction } from "./feishu-card-action.js";
import { FeishuCardUpdater } from "./feishu-card-updater.js";
import { checkFeishuResponse, FeishuFeedbackApi, feishuGetTiming, measureFeishuGetHttp } from "./feishu-feedback-api.js";
import { FeishuMessageFeedback, type FeishuReactions } from "./feishu-message-feedback.js";
import { FeishuProgressCard } from "./feishu-progress-card.js";
import { FeishuStreamReply, type FeishuCardKit } from "./feishu-stream-reply.js";
import { commandForFeishuMenuEvent } from "./feishu-shortcuts.js";
import { feishuTaskCard } from "./feishu-task-card.js";
import type { ChannelTaskCard } from "./task-card.js";
import { formatChannelActionCommand, parseChannelActionValue, type ChannelActionCard } from "./action-card.js";

type FeishuAdapterOptions = {
  readonly apiClient?: {
    readonly im: {
      readonly v1: {
        readonly image: Pick<Lark.Client["im"]["v1"]["image"], "create">;
        readonly message: Pick<Lark.Client["im"]["v1"]["message"], "create">
          & Partial<Pick<Lark.Client["im"]["v1"]["message"], "patch" | "reply">>;
        readonly messageResource: Pick<Lark.Client["im"]["v1"]["messageResource"], "get">;
        readonly messageReaction?: FeishuReactions;
      };
    };
    readonly cardkit?: { readonly v1: FeishuCardKit };
  };
  readonly wsClient?: Pick<Lark.WSClient, "start" | "close">;
  readonly inboundDir?: string;
  readonly feishuReactions?: boolean;
  readonly feishuProgressCards?: boolean;
  readonly feishuStreamingReplies?: boolean;
};

export class FeishuChannelAdapter implements ChannelAdapter, ChannelTextClient {
  readonly client: ChannelTextClient = this;
  private readonly apiClient: NonNullable<FeishuAdapterOptions["apiClient"]>;
  private readonly wsClient: NonNullable<FeishuAdapterOptions["wsClient"]>;
  private readonly cardUpdater: FeishuCardUpdater;
  private readonly inboundDir?: string;
  private readonly reactions?: FeishuReactions;
  private readonly feedbackApi = new FeishuFeedbackApi();
  private readonly cardApi = new FeishuFeedbackApi();
  private readonly progressCards: boolean;
  private readonly streamingReplies: boolean;

  constructor(account: FeishuAccount, options: FeishuAdapterOptions = {}) {
    const config = { appId: account.appId, appSecret: account.appSecret };
    this.apiClient = options.apiClient ?? new Lark.Client({
      ...config,
      httpInstance: feishuHttpInstance(),
      logger: {
        ...Lark.defaultLogger,
        error: (...args: unknown[]) => {
          // The SDK can log raw Axios errors with credentials; Get logs its own result.
          if (!feishuGetTiming.getStore()) Lark.defaultLogger.error(...args);
        }
      }
    });
    this.wsClient = options.wsClient ?? new Lark.WSClient(config);
    this.cardUpdater = new FeishuCardUpdater(this.apiClient.im.v1.message.patch);
    this.inboundDir = options.inboundDir;
    this.reactions = options.feishuReactions === false ? undefined : this.apiClient.im.v1.messageReaction;
    this.progressCards = options.feishuProgressCards !== false;
    this.streamingReplies = options.feishuStreamingReplies === true;
  }

  async sendText(input: { toUserId: string; text: string }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "text",
        content: JSON.stringify({ text: input.text })
      }
    });
    return sentMessage(result);
  }

  async sendImage(input: { toUserId: string; path: string }): Promise<{ messageId: string }> {
    const upload = await this.apiClient.im.v1.image.create({
      data: { image_type: "message", image: await fs.promises.readFile(input.path) }
    });
    if (!upload?.image_key) {
      throw new Error("Feishu image upload did not return an image_key");
    }
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "image",
        content: JSON.stringify({ image_key: upload.image_key })
      }
    });
    return sentMessage(result);
  }

  async sendActionCard(input: { toUserId: string; card: ChannelActionCard }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "interactive",
        content: JSON.stringify(feishuActionCard(input.card))
      }
    });
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
  }

  async sendTaskCard(input: { toUserId: string; card: ChannelTaskCard }): Promise<{ messageId: string }> {
    const result = await this.apiClient.im.v1.message.create({
      params: { receive_id_type: recipientType(input.toUserId) },
      data: {
        receive_id: input.toUserId,
        msg_type: "interactive",
        content: JSON.stringify(feishuTaskCard(input.card))
      }
    });
    return { messageId: String(result.data?.message_id ?? crypto.randomUUID()) };
  }

  async updateActionCard(input: { messageId: string; card: ChannelActionCard }): Promise<void> {
    await this.cardUpdater.update(input.messageId, feishuActionCard(input.card));
  }

  async updateTaskCard(input: { messageId: string; card: ChannelTaskCard }): Promise<void> {
    await this.cardUpdater.update(input.messageId, feishuTaskCard(input.card));
  }

  async monitor(options: ChannelMonitorOptions): Promise<void> {
    const activeFeedback = new Map<string, FeishuMessageFeedback>();
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        const receivedAt = performance.now();
        if (event.message.message_type !== "text" && event.message.message_type !== "image") return;
        if (options.signal?.aborted || event.sender.sender_type === "app") return;
        const actorId = event.sender.sender_id?.open_id
          ?? event.sender.sender_id?.user_id
          ?? event.sender.sender_id?.union_id;
        if (!actorId || !event.message.message_id || !event.message.chat_id) return;
        const pendingMessage: NormalizedWeixinMessage = {
          id: event.message.message_id,
          senderId: actorId,
          replyTargetId: event.message.chat_id,
          text: "",
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (activeFeedback.has(pendingMessage.id) || (options.claimMessage && !options.claimMessage(pendingMessage))) return;
        let feedback: FeishuMessageFeedback | undefined;
        try {
          const imageKey = event.message.message_type === "image" ? parseImageKey(event.message.content) : undefined;
          if (event.message.message_type === "image" && !imageKey) {
            throw new Error("Feishu image message did not include an image_key");
          }
          if (options.isMessageAllowed?.(pendingMessage)) {
            feedback = this.createFeedback(pendingMessage.id, receivedAt);
          }
          if (feedback) {
            pendingMessage.feedback = feedback;
            activeFeedback.set(pendingMessage.id, feedback);
          }
          await options.onMessage(await this.normalizeMessage(
            pendingMessage,
            event.message.content,
            imageKey
          ));
          feedback?.finish();
        } catch (error) {
          feedback?.finish(codexFailureOutcome(error));
          if (!(error instanceof Error)) throw error;
          await reportMessageError(options, error, pendingMessage);
        } finally {
          if (feedback) void feedback.settled().finally(() => activeFeedback.delete(pendingMessage.id));
        }
      },
      "card.action.trigger": async (rawEvent: Lark.RawCardActionEvent) => {
        const event = Lark.normalizeCardAction(rawEvent, { includeRaw: true });
        if (!event) return;
        const action = parseChannelActionValue(event.action.value);
        if (!action) return;
        const command = formatChannelActionCommand(action, formValueFromRawCardAction(rawEvent));
        if (!command) return;
        const token = typeof rawEvent.token === "string" && rawEvent.token.trim()
          ? rawEvent.token.trim()
          : cardActionIdentity(event);
        const pendingMessage: NormalizedWeixinMessage = {
          id: `feishu-card:${token}`,
          senderId: event.operator.openId,
          replyTargetId: event.chatId,
          interaction: { kind: "card", messageId: event.messageId },
          text: command,
          attachments: [],
          raw: { channel: "feishu", event: rawEvent }
        };
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
        return this.cardUpdater.respondToCallback(async () => {
          try {
            await options.onMessage(pendingMessage);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            await reportMessageError(options, error, pendingMessage);
          }
        });
      },
      "application.bot.menu_v6": async (event) => {
        const command = commandForFeishuMenuEvent(event.event_key);
        const operatorId = event.operator?.operator_id?.open_id
          ?? event.operator?.operator_id?.user_id
          ?? event.operator?.operator_id?.union_id;
        if (!command || !operatorId) return;
        const eventId = event.event_id ?? event.uuid ?? crypto.randomUUID();
        const pendingMessage: NormalizedWeixinMessage = {
          id: `feishu-menu:${eventId}`,
          senderId: operatorId,
          replyTargetId: operatorId,
          source: "native-menu",
          text: command,
          attachments: [],
          raw: { channel: "feishu", event }
        };
        if (options.claimMessage && !options.claimMessage(pendingMessage)) return;
        try {
          await options.onMessage(pendingMessage);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await reportMessageError(options, error, pendingMessage);
        }
      }
    });
    try {
      const aborted = untilAborted(options.signal);
      await Promise.race([this.wsClient.start({ eventDispatcher: dispatcher }), aborted]);
      if (!options.signal?.aborted) await aborted;
    } finally {
      this.wsClient.close({ force: true });
      if (activeFeedback.size) {
        const feedback = [...activeFeedback.values()];
        for (const message of feedback) message.finish("cancelled");
        await Promise.race([Promise.all(feedback.map((message) => message.settled())), delay(8_000, undefined, { ref: false })]);
      }
    }
  }

  private createFeedback(messageId: string, receivedAt: number): FeishuMessageFeedback | undefined {
    const messageApi = this.apiClient.im.v1.message;
    const reply = messageApi.reply;
    const cardKit = this.apiClient.cardkit?.v1;
    let progress: FeishuProgressCard | undefined;
    let stream: FeishuStreamReply | undefined;
    if (reply) {
      const send = async (content: string) => {
        const data = { msg_type: "interactive", content, uuid: crypto.randomUUID() };
        const result = await this.cardApi.run("send card reply", () => reply({
          path: { message_id: messageId }, data
        }));
        return sentMessage(result).messageId;
      };
      if (this.progressCards && messageApi.patch) {
        progress = new FeishuProgressCard({
          send: (card) => send(JSON.stringify(card)),
          update: (id, card) => this.cardApi.run("update progress card", () => this.cardUpdater.update(id, card))
        });
      }
      if (this.streamingReplies && cardKit) stream = new FeishuStreamReply(cardKit, this.cardApi, send);
    }
    if (!this.reactions && !progress && !stream) return undefined;
    return new FeishuMessageFeedback(messageId, this.reactions, this.feedbackApi, receivedAt, progress, stream);
  }

  private async normalizeMessage(
    message: NormalizedWeixinMessage,
    content: string,
    imageKey?: string
  ): Promise<NormalizedWeixinMessage> {
    if (!imageKey) return { ...message, text: parseText(content) };
    if (!this.inboundDir) throw new Error("Feishu inbound directory is not configured");
    fs.mkdirSync(this.inboundDir, { recursive: true });
    const targetPath = pathForInboundImage(this.inboundDir, message.id, imageKey);
    const resource = await this.apiClient.im.v1.messageResource.get({
      params: { type: "image" },
      path: { message_id: message.id, file_key: imageKey }
    });
    await resource.writeFile(targetPath);
    return {
      ...message,
      attachments: [{ kind: "image", label: path.basename(targetPath), item: {}, path: targetPath }]
    };
  }
}

function sentMessage(result: { code?: number; data?: { message_id?: string } }): { messageId: string } {
  checkFeishuResponse("send message", result);
  if (!result.data?.message_id) throw new Error("Feishu send message did not return a message_id");
  return { messageId: result.data.message_id };
}

function feishuHttpInstance(): Lark.HttpInstance {
  // The SDK default Axios interceptor unwraps the HTTP response to the API body.
  const http = Lark.defaultHttpInstance as unknown as Lark.HttpInstance;
  const tenantTokenUrl = /\/auth\/v3\/tenant_access_token\//;
  return {
    ...http,
    request: (options) => {
      const url = options.url ?? "";
      const isReaction = /\/reactions(?:\/|$)/.test(url);
      const isTenantToken = tenantTokenUrl.test(url);
      const feedback = isReaction || isTenantToken || /\/cardkit\/v1\//.test(url)
        || /\/im\/v1\/messages\/[^/]+\/reply$/.test(url)
        || (options.method === "PATCH" && /\/im\/v1\/messages\/[^/]+$/.test(url));
      const requestOptions = feedback ? { ...options, timeout: 2_500 } : options;
      const timing = feishuGetTiming.getStore();
      if (timing && isReaction) return measureFeishuGetHttp(timing, "reactionMs", () => http.request(requestOptions));
      if (timing && isTenantToken) return measureFeishuGetHttp(timing, "tokenMs", () => http.request(requestOptions));
      return http.request(requestOptions);
    },
    post: (url, data, options) => {
      // The SDK's bound Axios post bypasses the request wrapper above.
      const timing = feishuGetTiming.getStore();
      if (timing && tenantTokenUrl.test(url)) {
        return measureFeishuGetHttp(timing, "tokenMs", () => http.post(url, data, options));
      }
      return http.post(url, data, options);
    }
  };
}

async function reportMessageError(
  options: ChannelMonitorOptions,
  error: Error,
  message: NormalizedWeixinMessage
): Promise<void> {
  try {
    await options.onMessageError?.(error, message);
  } catch (reportError) {
    if (!(reportError instanceof Error)) throw reportError;
    console.error(`[codex-channel-bridge] failed to report Feishu message error: ${errorDetail(reportError)}`);
  }
}

function recipientType(recipientId: string): "chat_id" | "open_id" | "user_id" {
  if (recipientId.startsWith("oc_")) return "chat_id";
  if (recipientId.startsWith("ou_")) return "open_id";
  return "user_id";
}

function parseText(content: string): string {
  try {
    const value = JSON.parse(content) as { text?: unknown };
    return typeof value.text === "string" ? value.text.trim() : "";
  } catch {
    return content.trim();
  }
}

function parseImageKey(content: string): string | undefined {
  try {
    const value = JSON.parse(content) as { image_key?: unknown };
    return typeof value.image_key === "string" && value.image_key.trim() ? value.image_key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function pathForInboundImage(inboundDir: string, messageId: string, imageKey: string): string {
  const safeName = `${messageId}-${imageKey}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(inboundDir, `${safeName || crypto.randomUUID()}.png`);
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
