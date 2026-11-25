import assert from "node:assert/strict";
import test from "node:test";

import { userFacingMessageHandlingError } from "../src/bridge/errors.js";
import { CodexRunError } from "../src/codex/run-lifecycle.js";

test("returns actionable guidance for the Windows sandbox launch failure", () => {
  const message = userFacingMessageHandlingError(
    new Error("windows sandbox: CreateProcessAsUserW failed: 1312")
  );

  assert.match(message, /codexExecSandbox/);
  assert.match(message, /danger-full-access/);
  assert.match(message, /risk|风险/i);
});

test("returns network guidance for Codex workspace routing discovery timeouts", () => {
  const message = userFacingMessageHandlingError(new Error("workspace routing discovery timed out"));

  assert.match(message, /Codex 查询 ChatGPT 工作区路由超时/);
  assert.match(message, /桥接服务.*网络或代理/);
  assert.doesNotMatch(message, /任务执行时间过长/);
});

test("returns a retry hint when the Bridge timer expires", () => {
  const message = userFacingMessageHandlingError(new CodexRunError("codex exec timed out after 600000ms", "timed_out"));

  assert.match(message, /本轮任务执行时间过长.*重试/);
});

test("does not expose arbitrary local errors to WeChat", () => {
  const message = userFacingMessageHandlingError(new Error("timeout reading secret path C:/private/token.txt"));

  assert.doesNotMatch(message, /private|token\.txt/);
  assert.match(message, /本机服务输出/);
});
