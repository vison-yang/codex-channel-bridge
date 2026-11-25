#!/usr/bin/env node

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-hold" })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "item.started",
  item: { type: "command_execution", id: "running-command", status: "in_progress" }
})}\n`);
setInterval(() => {}, 1_000);
