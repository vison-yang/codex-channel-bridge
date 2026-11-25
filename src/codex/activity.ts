export type CodexActivityEvent = {
  id: string;
  kind: "command" | "file" | "mcp" | "dynamic" | "search" | "agent" | "image";
  status: "running" | "completed" | "failed";
  agents?: readonly { id: string; status: "pending" | "running" | "completed" | "failed" | "stopped" }[];
};

type ItemLifecycle = "started" | "updated" | "completed";
type AgentActivity = NonNullable<CodexActivityEvent["agents"]>[number];

const appServerKinds = new Map<string, CodexActivityEvent["kind"]>([
  ["commandExecution", "command"],
  ["fileChange", "file"],
  ["mcpToolCall", "mcp"],
  ["dynamicToolCall", "dynamic"],
  ["webSearch", "search"],
  ["collabAgentToolCall", "agent"],
  ["subAgentActivity", "agent"],
  ["imageGeneration", "image"],
  ["imageView", "image"]
]);

const execKinds = new Map<string, CodexActivityEvent["kind"]>([
  ["command_execution", "command"],
  ["file_change", "file"],
  ["mcp_tool_call", "mcp"],
  ["web_search", "search"],
  ["collab_tool_call", "agent"]
]);

export function parseAppServerActivity(item: unknown, lifecycle: "started" | "completed"): CodexActivityEvent | undefined {
  return parseActivity(item, lifecycle, appServerKinds, "agentsStates");
}

export function parseExecActivityLine(line: string): CodexActivityEvent | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(event);
  switch (record?.type) {
    case "item.started":
      return parseActivity(record.item, "started", execKinds, "agents_states");
    case "item.updated":
      return parseActivity(record.item, "updated", execKinds, "agents_states");
    case "item.completed":
      return parseActivity(record.item, "completed", execKinds, "agents_states");
  }
  return undefined;
}

export function notifyCodexObserver<T>(observer: ((value: T) => void) | undefined, value: T): void {
  try {
    const result: unknown = observer?.(value);
    if (result instanceof Promise) void result.catch(logObserverError);
  } catch (error) {
    logObserverError(error);
  }
}

function parseActivity(
  value: unknown,
  lifecycle: ItemLifecycle,
  kinds: ReadonlyMap<string, CodexActivityEvent["kind"]>,
  agentsKey: "agentsStates" | "agents_states"
): CodexActivityEvent | undefined {
  const item = asRecord(value);
  if (typeof item?.id !== "string" || !item.id || typeof item.type !== "string") return undefined;
  const kind = kinds.get(item.type);
  if (!kind) return undefined;

  if (item.type === "subAgentActivity") {
    return parseSubAgentActivity(item, item.id);
  }

  // 搜索和图片查看只带生命周期，无独立状态字段。
  const status = kind === "search" || item.type === "imageView"
    ? (lifecycle === "started" ? "running" : lifecycle === "completed" ? "completed" : undefined)
    : activityStatus(item.status);
  if (!status) return undefined;

  const agents = kind === "agent" ? parseAgentStates(item[agentsKey]) : [];
  return { id: item.id, kind, status, ...(agents.length ? { agents } : {}) };
}

function parseSubAgentActivity(item: Record<string, unknown>, id: string): CodexActivityEvent | undefined {
  const agentId = item.agentThreadId;
  if (typeof agentId !== "string" || !agentId) return undefined;
  switch (item.kind) {
    case "started":
      return { id, kind: "agent", status: "running", agents: [{ id: agentId, status: "running" }] };
    case "interrupted":
      return { id, kind: "agent", status: "completed", agents: [{ id: agentId, status: "stopped" }] };
    case "completed":
      return { id, kind: "agent", status: "completed", agents: [{ id: agentId, status: "completed" }] };
  }
  return undefined;
}

function parseAgentStates(value: unknown): AgentActivity[] {
  const states = asRecord(value);
  if (!states) return [];
  const agents: AgentActivity[] = [];
  for (const [id, state] of Object.entries(states)) {
    const status = agentStatus(asRecord(state)?.status);
    if (id && status) agents.push({ id, status });
  }
  return agents;
}

function activityStatus(value: unknown): CodexActivityEvent["status"] | undefined {
  switch (value) {
    case "inProgress":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "declined":
    case "interrupted":
      return "failed";
  }
  return undefined;
}

function agentStatus(value: unknown): AgentActivity["status"] | undefined {
  switch (value) {
    case "pendingInit":
    case "pending_init":
      return "pending";
    case "running":
    case "completed":
      return value;
    case "errored":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "stopped";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function logObserverError(error: unknown): void {
  console.warn(`Codex turn observer failed: ${error instanceof Error ? error.message : String(error)}`);
}
