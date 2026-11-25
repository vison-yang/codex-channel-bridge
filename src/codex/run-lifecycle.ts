export type CodexFailureOutcome = "cancelled" | "timed_out" | "failed";

export const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CODEX_USER_INPUT_TIMEOUT_MS = 5 * 60_000;

export class CodexRunError extends Error {
  constructor(message: string, readonly outcome: Exclude<CodexFailureOutcome, "failed">) {
    super(message);
    this.name = "CodexRunError";
  }
}

export function codexFailureOutcome(error: unknown): CodexFailureOutcome {
  return error instanceof CodexRunError ? error.outcome : "failed";
}

export function notifyExecutionStarted(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch (error) {
    console.warn(`Codex execution start callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
