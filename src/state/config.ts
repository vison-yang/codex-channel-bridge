import os from "node:os";
import path from "node:path";

import { parseCodexApprovalPolicy, type CodexApprovalPolicy } from "../codex/approval.js";
import {
  DEFAULT_CODEX_APPROVAL_TIMEOUT_MS,
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_CODEX_USER_INPUT_TIMEOUT_MS
} from "../codex/run-lifecycle.js";
import { parseCodexExecSandbox, type CodexExecSandbox } from "../codex/sandbox.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

export const MAX_INBOUND_BYTES = 100 * 1024 * 1024;
const LEGACY_DEFAULT_INBOUND_BYTES = 50 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const defaultCodexTimeouts = {
  codexApprovalTimeoutMs: DEFAULT_CODEX_APPROVAL_TIMEOUT_MS,
  codexTurnTimeoutMs: DEFAULT_CODEX_TURN_TIMEOUT_MS,
  codexRequestTimeoutMs: DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  codexUserInputTimeoutMs: DEFAULT_CODEX_USER_INPUT_TIMEOUT_MS
};
type CodexTimeoutField = keyof typeof defaultCodexTimeouts;

export type CodexWeixinConfig = {
  defaultCwd: string;
  allowedSenderIds: string[];
  allowedWorkspaces: string[];
  codexBin: string;
  codexBackend: "auto" | "app-server" | "exec";
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexExecSandbox?: CodexExecSandbox;
  model?: string;
  effort?: string;
  streamReplies: boolean;
  feishuReactions: boolean;
  feishuProgressCards: boolean;
  feishuStreamingReplies: boolean;
  maxBufferItems: number;
  promptBufferTtlMs: number;
  maxInboundBytes: number;
  taskboardEnabled: boolean;
  taskboardUrl: string;
} & typeof defaultCodexTimeouts;

export function defaultConfig(cwd = path.join(os.homedir(), ".codex-weixin")): CodexWeixinConfig {
  return {
    defaultCwd: path.resolve(cwd),
    allowedSenderIds: [],
    allowedWorkspaces: [path.resolve(cwd)],
    codexBin: "codex",
    codexBackend: "auto",
    ...defaultCodexTimeouts,
    streamReplies: true,
    feishuReactions: true,
    feishuProgressCards: true,
    feishuStreamingReplies: false,
    maxBufferItems: 50,
    promptBufferTtlMs: 10 * 60_000,
    maxInboundBytes: MAX_INBOUND_BYTES,
    taskboardEnabled: true,
    taskboardUrl: "http://127.0.0.1:47823"
  };
}

export function loadConfig(paths: StatePaths, cwd?: string): CodexWeixinConfig {
  const base = cwd ? defaultConfig(cwd) : defaultConfig();
  const loaded = readJsonFile<Partial<CodexWeixinConfig>>(paths.configPath, {});
  return {
    ...base,
    ...loaded,
    ...parseCodexTimeouts(loaded),
    codexApprovalPolicy: parseCodexApprovalPolicy(loaded.codexApprovalPolicy),
    codexExecSandbox: parseConfiguredCodexSandbox(loaded.codexExecSandbox),
    streamReplies: typeof loaded.streamReplies === "boolean" ? loaded.streamReplies : base.streamReplies,
    feishuReactions: typeof loaded.feishuReactions === "boolean" ? loaded.feishuReactions : base.feishuReactions,
    feishuProgressCards: typeof loaded.feishuProgressCards === "boolean" ? loaded.feishuProgressCards : base.feishuProgressCards,
    feishuStreamingReplies: typeof loaded.feishuStreamingReplies === "boolean" ? loaded.feishuStreamingReplies : base.feishuStreamingReplies,
    taskboardEnabled: typeof loaded.taskboardEnabled === "boolean" ? loaded.taskboardEnabled : base.taskboardEnabled,
    taskboardUrl: typeof loaded.taskboardUrl === "string" && loaded.taskboardUrl.trim()
      ? loaded.taskboardUrl.trim()
      : base.taskboardUrl,
    maxInboundBytes: normalizeInboundBytes(loaded.maxInboundBytes, base.maxInboundBytes),
    allowedSenderIds: loaded.allowedSenderIds ?? base.allowedSenderIds,
    allowedWorkspaces: (loaded.allowedWorkspaces?.length ? loaded.allowedWorkspaces : base.allowedWorkspaces)
      .map((workspace) => path.resolve(workspace))
  };
}

export function saveConfig(paths: StatePaths, config: CodexWeixinConfig): void {
  writeJsonFile(paths.configPath, {
    ...config,
    ...parseCodexTimeouts(config),
    codexApprovalPolicy: parseCodexApprovalPolicy(config.codexApprovalPolicy),
    codexExecSandbox: parseConfiguredCodexSandbox(config.codexExecSandbox),
    maxInboundBytes: normalizeInboundBytes(config.maxInboundBytes, MAX_INBOUND_BYTES)
  });
}

function parseConfiguredCodexSandbox(value: unknown): CodexExecSandbox | undefined {
  return value === null || value === "inherit" ? undefined : parseCodexExecSandbox(value);
}

function parseCodexTimeouts(config: Partial<Record<CodexTimeoutField, unknown>>): typeof defaultCodexTimeouts {
  const timeouts = { ...defaultCodexTimeouts };
  for (const field of Object.keys(timeouts) as CodexTimeoutField[]) {
    const value = config[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
      throw new Error(`Invalid ${field}: expected an integer between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
    }
    timeouts[field] = value;
  }
  return timeouts;
}

function normalizeInboundBytes(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value);
  if (bytes === LEGACY_DEFAULT_INBOUND_BYTES) return MAX_INBOUND_BYTES;
  return Math.min(bytes, MAX_INBOUND_BYTES);
}

export function isWorkspaceAllowed(workspace: string, allowedWorkspaces: string[]): boolean {
  const resolved = path.resolve(workspace);
  return allowedWorkspaces.some((allowed) => {
    const root = path.resolve(allowed);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
