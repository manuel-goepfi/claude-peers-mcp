const [portText, resultPath, ...threadIds] = process.argv.slice(2);
const port = Number(portText);
if (!Number.isInteger(port) || !resultPath || threadIds.length === 0) process.exit(64);

await Bun.sleep(350);
const results: Array<{ status: number; body: unknown }> = [];
for (const threadId of threadIds) {
  const response = await fetch(`http://127.0.0.1:${port}/bind-codex-pane-thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caller_pid: process.pid,
      tmux_pane_id: process.env.TMUX_PANE,
      thread_id: threadId,
    }),
  });
  results.push({ status: response.status, body: await response.json() });
}
await Bun.write(resultPath, JSON.stringify(results));
