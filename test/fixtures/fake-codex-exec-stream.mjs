#!/usr/bin/env node

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const includeActivity = process.argv.at(-1) === "structured-observers";

send({ type: "thread.started", thread_id: "thread-exec-stream" });
if (includeActivity) {
  send({ type: "item.started", item: { id: "cmd-1", type: "command_execution", status: "in_progress", command: "private command" } });
  send({
    type: "item.updated",
    item: { id: "collab-1", type: "collab_tool_call", status: "in_progress", agents_states: { a: { status: "pending_init", message: "private message" } } }
  });
  send({ type: "item.completed", item: { id: "reasoning-1", type: "reasoning", text: "private reasoning" } });
}
setTimeout(() => {
  send({
    type: "item.completed",
    item: { id: "agent-commentary", type: "agent_message", text: "正在查询资料。" }
  });
}, 5);
setTimeout(() => {
  if (includeActivity) {
    // Deliberately split a JSON line across writes.
    process.stdout.write('{"type":"item.completed","item":{"id":"cmd-1",');
    process.stdout.write('"type":"command_execution","status":"failed","aggregated_output":"private output"}}\n');
    send({
      type: "item.completed",
      item: { id: "collab-1", type: "collab_tool_call", status: "completed", agents_states: { a: { status: "completed" } } }
    });
    send({ type: "item.completed", item: { id: "search-1", type: "web_search", query: "private query" } });
  }
  send({
    type: "item.completed",
    item: { id: "agent-final", type: "agent_message", text: "第一段。\n\n第二段。" }
  });
  send({ type: "turn.completed", usage: { input_tokens: 1 } });
}, 10);
