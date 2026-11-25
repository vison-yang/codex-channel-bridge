import { codexFailureOutcome } from "../codex/run-lifecycle.js";

export function userFacingMessageHandlingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim() === "workspace routing discovery timed out") {
    return "[codex-channel-bridge] Codex 查询 ChatGPT 工作区路由超时。请检查运行桥接服务的机器能否通过当前网络或代理连接 ChatGPT，再重试。";
  }
  if (/CreateProcessAsUserW failed:\s*1312|codexExecSandbox/i.test(message)) {
    return [
      "[codex-channel-bridge] Windows Codex sandbox 启动失败。",
      "可在 ~/.codex-weixin/config.json 中设置 \"codexExecSandbox\": \"danger-full-access\" 后重启。",
      "该设置会让 Codex 获得本机完整访问权限，请仅在理解并接受安全风险时启用。"
    ].join("\n");
  }
  if (codexFailureOutcome(error) === "timed_out") {
    return "[codex-channel-bridge] 本轮任务执行时间过长，已停止处理。请拆成更小的步骤后重试。";
  }
  return "[codex-channel-bridge] 本轮消息处理失败，详细错误已写入本机服务输出。";
}
