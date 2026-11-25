import { setTimeout as delay } from "node:timers/promises";

type FeishuResponse = { code?: number };

export class FeishuResponseError extends Error {
  constructor(operation: string, readonly code: number) {
    super(`Feishu ${operation} failed (code ${code})`);
  }
}

export function checkFeishuResponse(operation: string, response: FeishuResponse): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new FeishuResponseError(operation, response.code);
  }
}

export class FeishuFeedbackApi {
  private retryAfter = 0;

  async run<T extends FeishuResponse | void>(operation: string, request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.retryAfter - Date.now();
      if (wait > 0) await delay(wait + Math.floor(Math.random() * 100));
      try {
        const response = await request();
        if (response) checkFeishuResponse(operation, response);
        return response;
      } catch (error) {
        const response = error as { code?: number; response?: { status?: number; data?: FeishuResponse } } | null;
        const code = response?.response?.data?.code ?? response?.code;
        if (response?.response?.status !== 429 && code !== 99991400 && code !== 230020) throw error;
        this.retryAfter = Math.max(this.retryAfter, Date.now() + 350 * 2 ** attempt);
        if (attempt === 2) throw error;
      }
    }
  }
}
