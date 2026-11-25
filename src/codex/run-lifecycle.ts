export type CodexFailureOutcome = "cancelled" | "timed_out" | "failed";

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
