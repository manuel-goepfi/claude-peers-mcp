import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../bin/install-tmux-label-hooks", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runInstaller(serverAlive = true, ...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "claude-peers-tmux-label-hooks-"));
  roots.push(root);
  const tmuxLog = join(root, "tmux.log");
  const flockLog = join(root, "flock.log");
  const fakeTmux = join(root, "tmux");
  const fakeFlock = join(root, "flock");
  const fakeBun = join(root, "bun");
  writeFileSync(fakeTmux, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${tmuxLog}'\n[[ "$*" == *list-sessions* ]] && exit ${serverAlive ? 0 : 1}\nexit 0\n`);
  writeFileSync(fakeFlock, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${flockLog}'\nexit 0\n`);
  writeFileSync(fakeBun, "#!/bin/bash\nexit 0\n");
  chmodSync(fakeTmux, 0o755);
  chmodSync(fakeFlock, 0o755);
  chmodSync(fakeBun, 0o755);
  mkdirSync(join(root, "home"));

  const proc = Bun.spawn(["bash", installer, ...args], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      CLAUDE_PEERS_TMUX_BIN: fakeTmux,
      CLAUDE_PEERS_FLOCK_BIN: fakeFlock,
      CLAUDE_PEERS_BUN_BIN: fakeBun,
      CLAUDE_PEERS_TMUX_SOCKET: join(root, "tmux.sock"),
      CLAUDE_PEERS_TMUX_LABEL_LOCK: join(root, "label.lock"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return {
    code,
    tmux: readFileSync(tmuxLog, "utf8"),
    flock: existsSync(flockLog) ? readFileSync(flockLog, "utf8") : "",
  };
}

describe("tmux label hook installation", () => {
  test("installs background indexed hooks without clobbering other hook slots", async () => {
    const result = await runInstaller();
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("set-hook -g after-split-window[90]");
    expect(result.tmux).toContain("set-hook -g after-new-window[90]");
    expect(result.tmux).toContain("set-hook -g after-new-session[90]");
    expect(result.tmux).not.toContain("set-hook -ag");
    expect(result.tmux).toContain("run-shell -b");
    expect(result.tmux).toContain(".claude-peers-tmux-label.log");
    expect(result.tmux).toContain("2>&1 || :");
    expect(result.tmux).toContain("#{pane_id}");
    expect(result.flock).toContain("--all");
    expect(result.flock).not.toContain(" -- ");
  });

  test("a missing tmux server is a clean no-op", async () => {
    const result = await runInstaller(false);
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("list-sessions");
    expect(result.tmux).not.toContain("set-hook");
    expect(result.flock).toBe("");
  });

  test("uninstall removes only the reserved hook slots and never backfills", async () => {
    const result = await runInstaller(true, "--uninstall");
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("set-hook -gu after-split-window[90]");
    expect(result.tmux).toContain("set-hook -gu after-new-window[90]");
    expect(result.tmux).toContain("set-hook -gu after-new-session[90]");
    expect(result.flock).toBe("");
  });
});
