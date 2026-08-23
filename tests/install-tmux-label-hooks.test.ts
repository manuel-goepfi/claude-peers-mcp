import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const installer = new URL("../bin/install-tmux-label-hooks", import.meta.url).pathname;
const labeler = new URL("../bin/tmux-label-pane.ts", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runInstaller(options: {
  serverAlive?: boolean;
  args?: string[];
  labelLogName?: string;
  createLabelLogParent?: boolean;
  failingPaneLabeler?: boolean;
  failingBackfill?: boolean;
} = {}) {
  const {
    serverAlive = true,
    args = [],
    labelLogName = "label.log",
    createLabelLogParent = true,
    failingPaneLabeler = false,
    failingBackfill = false,
  } = options;
  const root = mkdtempSync(join(tmpdir(), "claude-peers-tmux-label-hooks-"));
  roots.push(root);
  const tmuxLog = join(root, "tmux.log");
  const flockLog = join(root, "flock.log");
  const labelLog = join(root, labelLogName);
  const fakeTmux = join(root, "tmux");
  const tmuxArgvLog = join(root, "tmux-argv.log");
  const fakeFlock = join(root, "flock");
  const fakeBun = join(root, "bun");
  writeFileSync(fakeTmux, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${tmuxLog}'\n{ printf 'CALL\\0'; printf '%s\\0' "$@"; printf 'END\\0'; } >> '${tmuxArgvLog}'\n[[ "$*" == *list-sessions* ]] && exit ${serverAlive ? 0 : 1}\nexit 0\n`);
  writeFileSync(fakeFlock, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${flockLog}'\nshift 2\nexec "$@"\n`);
  writeFileSync(fakeBun, failingPaneLabeler
    ? "#!/bin/bash\n[ \"${2:-}\" = \"--all\" ] && exit 0\nprintf 'labeler stdout\\n'\nprintf 'labeler stderr\\n' >&2\nexit 1\n"
    : failingBackfill
      ? "#!/bin/bash\nprintf 'backfill detail\\n' >&2\nexit 7\n"
      : "#!/bin/bash\nexit 0\n");
  chmodSync(fakeTmux, 0o755);
  chmodSync(fakeFlock, 0o755);
  chmodSync(fakeBun, 0o755);
  mkdirSync(join(root, "home"));
  if (createLabelLogParent) mkdirSync(dirname(labelLog), { recursive: true });

  const proc = Bun.spawn(["bash", installer, ...args], {
    env: {
      ...process.env,
      HOME: join(root, "home"),
      CLAUDE_PEERS_TMUX_BIN: fakeTmux,
      CLAUDE_PEERS_FLOCK_BIN: fakeFlock,
      CLAUDE_PEERS_BUN_BIN: fakeBun,
      CLAUDE_PEERS_TMUX_LABELER: labeler,
      CLAUDE_PEERS_TMUX_SOCKET: join(root, "tmux.sock"),
      CLAUDE_PEERS_TMUX_LABEL_LOCK: join(root, "label.lock"),
      CLAUDE_PEERS_TMUX_LABEL_LOG: labelLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const tmuxArgv = readFileSync(tmuxArgvLog).toString("utf8").split("\0");
  const tmuxCalls: string[][] = [];
  let currentCall: string[] | null = null;
  for (const token of tmuxArgv) {
    if (token === "CALL") currentCall = [];
    else if (token === "END" && currentCall) {
      tmuxCalls.push(currentCall);
      currentCall = null;
    } else if (currentCall) currentCall.push(token);
  }
  return {
    code,
    stdout,
    stderr,
    tmux: readFileSync(tmuxLog, "utf8"),
    tmuxCalls,
    flock: existsSync(flockLog) ? readFileSync(flockLog, "utf8") : "",
    labelLog,
  };
}

describe("tmux label hook installation", () => {
  test("installs background output-suppressed indexed hooks without clobbering other hook slots", async () => {
    const result = await runInstaller();
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("set-hook -g after-split-window[90]");
    expect(result.tmux).toContain("set-hook -g after-new-window[90]");
    expect(result.tmux).toContain("set-hook -g after-new-session[90]");
    expect(result.tmux).not.toContain("set-hook -ag");
    expect(result.tmux).toContain("run-shell -b");
    expect(result.tmux).toContain(`>>'${result.labelLog}' 2>&1 || :`);
    expect(result.tmux).toContain(") >/dev/null 2>&1");
    expect(result.tmux.match(/run-shell -b/g)).toHaveLength(3);
    expect(result.tmux.match(/2>&1 \|\| :/g)).toHaveLength(3);
    expect(result.tmux).toContain("#{pane_id}");
    expect(result.flock).toContain("--all");
    expect(result.flock).not.toContain(" -- ");
  });

  test("the installed payload emits nothing, exits zero, and durably logs a failing labeler", async () => {
    const result = await runInstaller({
      failingPaneLabeler: true,
      labelLogName: "label logs/label;[literal].log",
    });
    expect(result.code).toBe(0);
    const hookLine = result.tmux.split("\n").find((line) => line.includes("after-split-window[90]"));
    if (!hookLine) throw new Error("after-split-window[90] hook was not installed");
    const payloadMatch = hookLine.match(/run-shell -b \"(.*)\"$/);
    if (!payloadMatch?.[1]) throw new Error("installed hook payload was not parseable");
    const payload = payloadMatch[1].replace("#{pane_id}", "%99");
    const hookCall = result.tmuxCalls.find((args) => args.includes("after-split-window[90]"));
    expect(hookCall).toHaveLength(6);
    expect(hookCall?.[5]).toBe(`run-shell -b "${payloadMatch[1]}"`);

    const proc = Bun.spawn(["/bin/sh", "-c", payload], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(readFileSync(result.labelLog, "utf8")).toContain("labeler stdout\nlabeler stderr\n");
  });

  test("a missing tmux server is a clean no-op", async () => {
    const result = await runInstaller({ serverAlive: false });
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("list-sessions");
    expect(result.tmux).not.toContain("set-hook");
    expect(result.flock).toBe("");
  });

  test("uninstall removes only the reserved hook slots and never backfills", async () => {
    const result = await runInstaller({ args: ["--uninstall"] });
    expect(result.code).toBe(0);
    expect(result.tmux).toContain("set-hook -gu after-split-window[90]");
    expect(result.tmux).toContain("set-hook -gu after-new-window[90]");
    expect(result.tmux).toContain("set-hook -gu after-new-session[90]");
    expect(result.flock).toBe("");
  });

  test("refuses to install hooks when the durable log cannot be opened", async () => {
    const result = await runInstaller({
      labelLogName: "missing/label.log",
      createLabelLogParent: false,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tmux label log is not appendable");
    expect(result.tmux).not.toContain("set-hook");
  });

  test("preserves a failing backfill status and points the caller to its durable detail", async () => {
    const result = await runInstaller({ failingBackfill: true });
    expect(result.code).toBe(7);
    expect(result.stderr).toContain(`tmux pane-label backfill failed; see ${result.labelLog}`);
    expect(readFileSync(result.labelLog, "utf8")).toContain("backfill detail");
  });

  test.each([
    "label'log",
    'label"log',
    "label\\log",
    "label$HOME.log",
    "label#{session_name}.log",
    "label\nlog",
    "label\rlog",
  ])(
    "rejects a log path that could break or expand nested hook quoting: %j",
    async (labelLogName) => {
      const result = await runInstaller({ labelLogName });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unsupported quoting characters");
      expect(result.tmux).not.toContain("set-hook");
    },
  );
});
