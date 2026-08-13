import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isClientProcess } from "../shared/client.ts";
import { findClientPidFromTable, findHookPeerPidsFromTable, findMcpPidFromTable } from "../hooks/codex-drain-peer-inbox.ts";
import { codexDrainRootDecision, codexHookRootDegradedReason, codexHookRootRefusalReason, codexHookSessionDiagnostic, peerName, publishBrokerIdentityToTmux, readPaneLabel, registrationTmuxPaneId, sessionIdFromHookInput, tmuxIdentityMirrorEnabled } from "../hooks/register-peer-session.ts";
import { detectClientFromProcessChain, findBgSpareAncestor, initialReceiverMode, type ProcessInfo } from "../shared/client.ts";
import { findNearestVisibleCodexProcessByStart, findVisibleCodexProcessByPaneId } from "../shared/visible-codex.ts";
import { findCodexAppServerAncestor, findVisibleCodexSession, mcpThreadIdFromRequestMeta, registrationCwd, registrationCwdResult, registrationTtyPid, selectCodexManualDrainPid, selectInboxClaimIdentity, shouldUnregisterPeerOnShutdown, unresolvedAppServerToolDiagnostic } from "../server.ts";

function table(rows: ProcessInfo[]): Map<number, ProcessInfo> {
  return new Map(rows.map((row) => [row.pid, row]));
}

function canCreateTmuxSession(): boolean {
  const session = `claude-peers-probe-${process.pid}-${Date.now()}`;
  const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", session], { stdout: "ignore", stderr: "ignore" });
  if (created.exitCode !== 0) return false;
  Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
  return true;
}

describe("client detection", () => {
  test("explicit override wins", () => {
    const processes = table([{ pid: 10, ppid: 1, comm: "bash", args: "bash" }]);
    expect(detectClientFromProcessChain(10, processes, { CLAUDE_PEERS_CLIENT_TYPE: "codex" })).toBe("codex");
    expect(detectClientFromProcessChain(10, processes, { CLAUDE_PEERS_CLIENT_TYPE: "gemini" })).toBe("gemini");
  });

  test("detects Codex ancestor through wrappers", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "node", args: "node helper" },
      { pid: 10, ppid: 1, comm: "codex", args: "codex" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("codex");
  });

  test("detects Claude parent", () => {
    const processes = table([
      { pid: 20, ppid: 10, comm: "claude", args: "claude --dangerously-load-development-channels" },
      { pid: 10, ppid: 1, comm: "bash", args: "bash" },
    ]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("claude");
  });

  test("detects Gemini launched via the nvm bin shim (node .../bin/gemini)", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "node", args: "node /home/manzo/.nvm/versions/node/v22.22.2/bin/gemini" },
      { pid: 10, ppid: 1, comm: "bash", args: "-bash" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("gemini");
  });

  test("a bare 'gemini' word as a later argument is NOT a launcher", () => {
    const processes = table([
      { pid: 20, ppid: 10, comm: "node", args: "node build.js --theme gemini" },
      { pid: 10, ppid: 1, comm: "bash", args: "-bash" },
    ]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("unknown");
  });

  test("detects Cursor ancestor by its install path, not the generic 'agent' name", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "MainThread", args: "/home/manzo/.local/bin/agent --use-system-ca /home/manzo/.local/share/cursor-agent/versions/2026.07.20-8cc9c0b/index.js" },
      { pid: 10, ppid: 1, comm: "bash", args: "-bash" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("cursor");
    expect(detectClientFromProcessChain(30, processes, { CLAUDE_PEERS_CLIENT_TYPE: "cursor" })).toBe("cursor");
    expect(initialReceiverMode("cursor")).toBe("manual-drain");
  });

  test("detects agy (Google agent CLI) by binary name", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "agy", args: "agy" },
      { pid: 10, ppid: 1, comm: "bash", args: "-bash" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("agy");
    expect(initialReceiverMode("agy")).toBe("manual-drain");
  });

  test("a bare 'agent' binary without the cursor-agent path is NOT Cursor", () => {
    const processes = table([
      { pid: 20, ppid: 10, comm: "agent", args: "/usr/local/bin/agent --serve" },
      { pid: 10, ppid: 1, comm: "bash", args: "-bash" },
    ]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("unknown");
  });

  test("detects Gemini ancestor through wrappers", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "node", args: "node helper" },
      { pid: 10, ppid: 1, comm: "gemini", args: "gemini" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("gemini");
  });

  test("detects Gemini when the CLI is launched through Node", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "node", args: "node /usr/local/lib/node_modules/@google/gemini-cli/dist/gemini.js" },
      { pid: 10, ppid: 1, comm: "bash", args: "bash" },
    ]);
    expect(detectClientFromProcessChain(30, processes, {})).toBe("gemini");
  });

  test("unknown fallback maps to unknown receiver mode", () => {
    const processes = table([{ pid: 20, ppid: 1, comm: "bash", args: "bash" }]);
    expect(detectClientFromProcessChain(20, processes, {})).toBe("unknown");
    expect(initialReceiverMode("unknown")).toBe("unknown");
  });

  test("Codex starts as manual drain until hook heartbeat proves capability", () => {
    expect(initialReceiverMode("codex")).toBe("manual-drain");
  });

  test("Gemini starts as manual drain until hook heartbeat proves capability", () => {
    expect(initialReceiverMode("gemini")).toBe("manual-drain");
  });

  test("every current client disables the background observation poll", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(src).toContain('return clientType === "claude" || clientType === "codex" || clientType === "gemini"');
    expect(src).toContain('|| clientType === "kimi"');
    expect(src).toContain('|| clientType === "unknown"');
    expect(src).toContain("background observation poll disabled");
  });

  test("startup derives git metadata from the registration cwd", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(src).toContain("const cwdResult = registrationCwdResult(serverCwd, myRegisterPid, myClientType)");
    expect(src).toContain("myCwd = cwdResult.cwd");
    expect(src).toContain("myGitRoot = await getGitRoot(myCwd)");
    expect(src).toContain("myAbsoluteGitDir = await getAbsoluteGitDir(myCwd)");
  });

  test("hook-based MCP registration uses the client cwd, not the server cwd", () => {
    const cwdReader = (pid: number) => pid === 10 ? "/home/manzo/Clause5" : null;

    expect(registrationCwd("/home/manzo/claude-peers-mcp", 10, "codex", cwdReader)).toBe("/home/manzo/Clause5");
    expect(registrationCwd("/home/manzo/claude-peers-mcp", 10, "gemini", cwdReader)).toBe("/home/manzo/Clause5");
  });

  test("non-hook clients and missing client cwd fall back safely", () => {
    const cwdReader = () => null;

    expect(registrationCwd("/home/manzo/claude-peers-mcp", 10, "claude", cwdReader)).toBe("/home/manzo/claude-peers-mcp");
    expect(registrationCwd("/home/manzo/claude-peers-mcp", 10, "unknown", cwdReader)).toBe("/home/manzo/claude-peers-mcp");
    expect(registrationCwd("/home/manzo/claude-peers-mcp", 10, "codex", cwdReader)).toBe("/home/manzo/claude-peers-mcp");
    expect(registrationCwdResult("/home/manzo/claude-peers-mcp", 10, "codex", cwdReader)).toEqual({
      cwd: "/home/manzo/claude-peers-mcp",
      source: "process-fallback",
      missingClientCwd: true,
    });
  });

  test("tty lookup uses client PID only for hook-based clients", () => {
    expect(registrationTtyPid(10, "codex", 20)).toBe(10);
    expect(registrationTtyPid(10, "gemini", 20)).toBe(10);
    expect(registrationTtyPid(10, "claude", 20)).toBe(20);
    expect(registrationTtyPid(10, "unknown", 20)).toBe(20);
  });

  test("Codex hook discovers the MCP server from process ancestry without env PID", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "codex", args: "codex" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const pid = findMcpPidFromTable(processes, 10, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other");
    expect(pid).toBe(20);
  });

  test("Codex hook prefers the CLI process as the registered peer pid", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "codex", args: "codex" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const pid = findClientPidFromTable(processes, 30, "codex");
    expect(pid).toBe(10);
  });

  test("Codex hook uses client PID first even when legacy MCP env PID is set", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "codex", args: "codex" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const pids = findHookPeerPidsFromTable(processes, 30, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other", "codex", 20);
    expect(pids).toEqual({ primary: 10, fallbacks: [20] });
  });

  test("Codex hook keeps discovered MCP PID before explicit env PID when they differ", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "codex", args: "codex" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const pids = findHookPeerPidsFromTable(processes, 30, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other", "codex", 99);
    expect(pids).toEqual({ primary: 10, fallbacks: [20, 99] });
  });

  test("Codex app-server hook falls back to the visible tmux Codex pid", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const cwd = (candidate: number) => candidate === 100 || candidate === 200 ? "/home/manzo/Clause5" : "/other";
    const hasIdentity = (candidate: number) => candidate === 200;

    const pids = findHookPeerPidsFromTable(processes, 300, "/ignored", cwd, "codex", null, hasIdentity, (candidate) =>
      candidate === 200 ? "pts/27" : null
    );

    expect(pids).toEqual({ primary: 200, fallbacks: [] });
  });

  test("Codex app-server hook rejects headless inherited-identity Codex processes", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex exec --json" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const cwd = (candidate: number) => candidate === 100 || candidate === 200 ? "/home/manzo/Clause5" : "/other";
    const hasIdentity = (candidate: number) => candidate === 200;

    const pids = findHookPeerPidsFromTable(processes, 300, "/ignored", cwd, "codex", null, hasIdentity, () => null);

    expect(pids).toBeNull();
  });

  test("Codex app-server ancestor is found through the stdio guard wrapper", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [150, { pid: 150, ppid: 100, comm: "bash", args: "/home/manzo/ManzoOps/scripts/infrastructure/monitoring/mcp-stdio-guard.sh bun /home/manzo/claude-peers-mcp/server.ts" }],
      [300, { pid: 300, ppid: 150, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
    ]);

    expect(findCodexAppServerAncestor(300, processes)?.pid).toBe(100);
  });

  test("visible Codex helper can resolve exactly one same-cwd session", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [150, { pid: 150, ppid: 100, comm: "bash", args: "mcp-stdio-guard.sh bun server.ts" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [300, { pid: 300, ppid: 150, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
    ]);

    const visible = findVisibleCodexSession(processes, "/home/manzo/Clause5", {
      getTty: (candidate) => candidate === 200 ? "pts/27" : null,
      cwdOf: (candidate) => candidate === 100 || candidate === 200 ? "/home/manzo/Clause5" : "/other",
      environOf: (candidate) => candidate === 200 ? { CLAUDE_PEER_NAME: "pr.1", TMUX_PANE: "%125" } : {},
    });

    expect(visible?.pid).toBe(200);
    expect(visible?.env.CLAUDE_PEER_NAME).toBe("pr.1");
  });

  test("server app-server fallback refuses ambiguous same-cwd visible Codex sessions", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [201, { pid: 201, ppid: 51, comm: "codex", args: "codex" }],
    ]);

    const visible = findVisibleCodexSession(processes, "/home/manzo/Clause5", {
      getTty: (candidate) => candidate === 200 || candidate === 201 ? `pts/${candidate}` : null,
      cwdOf: (candidate) => candidate === 100 || candidate === 200 || candidate === 201 ? "/home/manzo/Clause5" : "/other",
      environOf: (candidate) => candidate === 200 ? { CLAUDE_PEER_NAME: "pr.1", TMUX_PANE: "%125" } :
        candidate === 201 ? { CLAUDE_PEER_NAME: "c5.1", TMUX_PANE: "%210" } : {},
    });

    expect(visible).toBeNull();
  });

  test("matches an app-server hook to the sole visible Codex process carrying its inherited pane", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 1, comm: "codex", args: "codex resume" }],
      [201, { pid: 201, ppid: 1, comm: "codex", args: "codex resume" }],
    ]);
    const readers = {
      getTty: (candidate: number) => candidate === 200 ? "pts/10" : "pts/11",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: (candidate: number) => candidate === 200
        ? { CLAUDE_PEER_NAME: "orch.4", TMUX_PANE: "%2404" }
        : { CLAUDE_PEER_NAME: "stale-name", TMUX_PANE: "%2432" },
    };

    expect(findVisibleCodexProcessByPaneId(processes, "/home/manzo/Clause5", "%2432", readers))
      .toMatchObject({ pid: 201, env: { TMUX_PANE: "%2432" } });
    expect(findVisibleCodexProcessByPaneId(processes, "/home/manzo/Clause5", "%9999", readers))
      .toBeNull();
  });

  test("collapses a Node launcher and its native Codex child into one pane-local session", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, {
        pid: 200,
        ppid: 50,
        comm: "node",
        args: "node /opt/codex/bin/codex --remote ws://127.0.0.1:42916 --cd /home/manzo/Clause5",
      }],
      [201, {
        pid: 201,
        ppid: 200,
        comm: "codex",
        args: "/opt/codex/vendor/codex --remote ws://127.0.0.1:42916 --cd /home/manzo/Clause5",
      }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers))
      .toMatchObject({ pid: 201, env: { CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" } });
    expect(findVisibleCodexSession(processes, "/home/manzo/Clause5", readers))
      .toMatchObject({ pid: 201 });
  });

  test("collapses a Bun launcher and its native Codex child", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "bun", args: "bun /opt/codex/bin/codex --remote unix://" }],
      [201, { pid: 201, ppid: 200, comm: "codex", args: "/opt/codex/vendor/codex --remote unix://" }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers))
      .toMatchObject({ pid: 201 });
  });

  test("keeps distinct Codex sessions in one pane ambiguous", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex --remote ws://127.0.0.1:42916" }],
      [201, { pid: 201, ppid: 51, comm: "codex", args: "codex --remote ws://127.0.0.1:42917" }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers)).toBeNull();
  });

  test("does not collapse a direct noninteractive Codex child when no TUI candidate exists", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "node", args: "node /opt/codex/bin/codex exec review" }],
      [201, { pid: 201, ppid: 200, comm: "codex", args: "/opt/codex/vendor/codex exec review" }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers)).toBeNull();
    expect(findVisibleCodexSession(processes, "/home/manzo/Clause5", readers)).toBeNull();
  });

  test("keeps a launcher, TUI, and nested Codex command ambiguous", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "node", args: "node /opt/codex/bin/codex --remote unix://" }],
      [201, { pid: 201, ppid: 200, comm: "codex", args: "/opt/codex/vendor/codex --remote unix://" }],
      [202, { pid: 202, ppid: 201, comm: "codex", args: "/opt/codex/vendor/codex exec review" }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers)).toBeNull();
  });

  test("refuses launcher pairs whose visible seat evidence disagrees", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "node", args: "node /opt/codex/bin/codex --remote unix://" }],
      [201, { pid: 201, ppid: 200, comm: "codex", args: "/opt/codex/vendor/codex --remote unix://" }],
    ]);
    const base = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", {
      ...base,
      getTty: (pid) => pid === 200 ? "pts/8" : "pts/9",
    })).toBeNull();
    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", {
      ...base,
      cwdOf: (pid) => pid === 200 ? "/home/manzo/Other" : "/home/manzo/Clause5",
    })).toBeNull();
    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", {
      ...base,
      environOf: (pid) => ({ CLAUDE_PEER_NAME: pid === 200 ? "orch.16" : "orch.17", TMUX_PANE: "%2916" }),
    })).toBeNull();
    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", {
      ...base,
      environOf: (pid) => pid === 200
        ? { CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }
        : { CLAUDE_PEER_NAME: "orch.17", CLAUDE_PEER_TMUX_PANE_ID: "%2916" },
    })).toBeNull();
  });

  test("does not collapse a nested native Codex subprocess into its parent session", () => {
    const processes = new Map<number, ProcessInfo>([
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex --remote ws://127.0.0.1:42916" }],
      [201, { pid: 201, ppid: 200, comm: "codex", args: "codex exec review" }],
    ]);
    const readers = {
      getTty: () => "pts/9",
      cwdOf: () => "/home/manzo/Clause5",
      environOf: () => ({ CLAUDE_PEER_NAME: "orch.17", TMUX_PANE: "%2916" }),
    };

    expect(findVisibleCodexProcessByPaneId(processes, null, "%2916", readers)).toBeNull();
  });

  test("uses the visible pane-border label as the authoritative Codex name", () => {
    expect(peerName("codex", 201, { session: "orch", pane_id: "%2432" }, {
      CLAUDE_PEER_NAME: "stale-launch-name",
    }, "orch.5")).toBe("orch.5");
    expect(peerName("claude", 201, { session: "infra", pane_id: "%312" }, {
      CLAUDE_PEER_NAME: "infra.2",
    }, "infra.3")).toBe("infra.2");
  });

  test("retries the pane label precedence chain before using a stale launch name", () => {
    let reads = 0;
    const label = readPaneLabel("%42", () => {
      reads++;
      return reads === 1
        ? { ok: false, peerResolvedName: null, operatorLabel: null }
        : { ok: true, peerResolvedName: "orch.5", operatorLabel: "stale-human" };
    });

    expect(label).toBe("orch.5");
    expect(reads).toBe(2);
  });

  test("a persistently unlabeled pane retries once but stays quiet", () => {
    let reads = 0;
    const warnings: string[] = [];
    expect(readPaneLabel("%42", () => {
      reads++;
      return { ok: true, peerResolvedName: null, operatorLabel: null };
    }, (message) => warnings.push(message))).toBeNull();
    expect(reads).toBe(2);
    expect(warnings).toEqual([]);
  });

  test("two real pane-label read failures are surfaced before launch-name fallback", () => {
    let reads = 0;
    const warnings: string[] = [];
    expect(readPaneLabel("%42", () => {
      reads++;
      return { ok: false, peerResolvedName: null, operatorLabel: null };
    }, (message) => warnings.push(message))).toBeNull();
    expect(reads).toBe(2);
    expect(warnings).toEqual([
      "tmux pane-label read failed twice pane=%42; falling back to launch identity",
    ]);
  });

  test("server startup never adopts a sole same-cwd lane without hook-owned seat proof", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const startup = src.indexOf("async function main()");
    const proofResolver = src.indexOf("resolveAppServerIdentityForToolCall =", startup);
    const startupBody = src.slice(startup, proofResolver);

    expect(startupBody).toContain("appServerIdentityRequiresThreadProof = true");
    expect(startupBody).not.toContain("findVisibleCodexSession(startupProcesses");
    expect(startupBody).not.toContain("app-server identity resolved via visible TTY");
  });

  test("Codex observer manual check resolves the nearest visible same-cwd session by start time", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [201, { pid: 201, ppid: 51, comm: "codex", args: "codex" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
    ]);

    const visible = findNearestVisibleCodexProcessByStart(processes, "/home/manzo/Clause5", 300, {
      getTty: (candidate) => candidate === 200 || candidate === 201 ? `pts/${candidate}` : null,
      cwdOf: (candidate) => candidate === 100 || candidate === 200 || candidate === 201 ? "/home/manzo/Clause5" : "/other",
      environOf: (candidate) => candidate === 200 ? { CLAUDE_PEER_NAME: "infra.2", TMUX_PANE: "%254" } :
        candidate === 201 ? { CLAUDE_PEER_NAME: "infra.3", TMUX_PANE: "%325" } : {},
      processStartTicks: (candidate) => {
        if (candidate === 200) return 1_000;
        if (candidate === 201) return 1_700;
        if (candidate === 300) return 1_880;
        return null;
      },
    });

    expect(visible?.pid).toBe(201);
    expect(visible?.env.CLAUDE_PEER_NAME).toBe("infra.3");
  });

  test("Codex observer manual check can resolve a proximate TTY session when Codex strips its identity environment", () => {
    const processes = new Map([
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex resume" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
    ]);

    const visible = findNearestVisibleCodexProcessByStart(processes, "/home/manzo/Clause5", 300, {
      getTty: (candidate) => candidate === 200 ? "pts/41" : null,
      cwdOf: (candidate) => candidate === 200 ? "/home/manzo/Clause5" : "/other",
      environOf: () => ({}),
      processStartTicks: (candidate) => candidate === 200 ? 1_700 : candidate === 300 ? 1_880 : null,
    }, 2_000, false);

    expect(visible?.pid).toBe(200);
  });

  test("Codex observer manual check refuses tied or stale start-time matches", () => {
    const processes = new Map([
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [201, { pid: 201, ppid: 51, comm: "codex", args: "codex" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
    ]);
    const readers = {
      getTty: (candidate: number) => candidate === 200 || candidate === 201 ? `pts/${candidate}` : null,
      cwdOf: (candidate: number) => candidate === 200 || candidate === 201 ? "/home/manzo/Clause5" : "/other",
      environOf: (candidate: number) => candidate === 200 ? { CLAUDE_PEER_NAME: "infra.2", TMUX_PANE: "%254" } :
        candidate === 201 ? { CLAUDE_PEER_NAME: "infra.3", TMUX_PANE: "%325" } : {},
    };

    expect(findNearestVisibleCodexProcessByStart(processes, "/home/manzo/Clause5", 300, {
      ...readers,
      processStartTicks: (candidate) => candidate === 300 ? 2_000 : 1_900,
    })).toBeNull();
    expect(findNearestVisibleCodexProcessByStart(processes, "/home/manzo/Clause5", 300, {
      ...readers,
      processStartTicks: (candidate) => {
        if (candidate === 200) return 1;
        if (candidate === 201) return 2;
        if (candidate === 300) return 3_000;
        return null;
      },
    })).toBeNull();

  });

  test("every tool verifies an unresolved app-server seat before registration or execution", () => {
    const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const handler = src.indexOf("mcp.setRequestHandler(CallToolRequestSchema");
    const reconciliationGuard = src.indexOf("if (appServerIdentityRequiresThreadProof)", handler);
    const threadExtraction = src.indexOf("mcpThreadIdFromRequestMeta(req.params._meta)", reconciliationGuard);
    const reconciliation = src.indexOf("await resolveAppServerIdentityForToolCall(threadId)", threadExtraction);
    const loudFailure = src.indexOf("unresolvedAppServerToolDiagnostic(name, resolution.reason)", reconciliation);
    const registration = src.indexOf("await ensureRegistered()", handler);
    const checkCase = src.indexOf('case "check_messages"');
    const identityGuard = src.indexOf("const claimIdentity = selectInboxClaimIdentity", checkCase);
    const brokerClaim = src.indexOf("const batch = await claimCurrentInbox()", identityGuard);
    const bodyRender = src.indexOf("renderInboundBatch(batch.messages)", brokerClaim);
    const brokerAck = src.indexOf('await ackClaimedInbox(batch, "check_messages")', bodyRender);

    expect(handler).toBeGreaterThan(0);
    expect(reconciliationGuard).toBeGreaterThan(handler);
    expect(threadExtraction).toBeGreaterThan(reconciliationGuard);
    expect(reconciliation).toBeGreaterThan(threadExtraction);
    expect(loudFailure).toBeGreaterThan(reconciliation);
    expect(registration).toBeGreaterThan(loudFailure);
    expect(checkCase).toBeGreaterThan(0);
    expect(identityGuard).toBeGreaterThan(checkCase);
    expect(brokerClaim).toBeGreaterThan(identityGuard);
    expect(bodyRender).toBeGreaterThan(brokerClaim);
    expect(brokerAck).toBeGreaterThan(bodyRender);
    expect(src.slice(checkCase, bodyRender)).not.toContain('"/poll-messages"');
    expect(src).not.toContain("drainVisibleCodexPidForManualCheck");
  });

  test("Codex hook session_id and MCP _meta.threadId expose the same opaque thread key", () => {
    const threadId = "019fc273-a35b-78f0-9a70-f63b5905540f";
    expect(sessionIdFromHookInput({ session_id: threadId, hook_event_name: "SessionStart" })).toBe(threadId);
    expect(sessionIdFromHookInput({ session_id: threadId, hook_event_name: "Stop" })).toBe(threadId);
    expect(mcpThreadIdFromRequestMeta({ threadId })).toBe(threadId);
    expect(sessionIdFromHookInput({ session_id: "" })).toBeNull();
    expect(sessionIdFromHookInput({ session_id: "   " })).toBeNull();
    expect(sessionIdFromHookInput({ session_id: `  ${threadId}  ` })).toBe(threadId);
    expect(mcpThreadIdFromRequestMeta({})).toBeNull();
  });

  test("Codex hook diagnostics match a durable root transcript without touching the filesystem", () => {
    const threadId = "019fc273-a35b-78f0-9a70-f63b5905540f";
    expect(codexHookSessionDiagnostic({
      session_id: threadId,
      hook_event_name: "SessionStart",
      source: "resume",
      transcript_path: `/definitely/not/materialized/rollout-2026-08-06T20-16-02-${threadId}.jsonl`,
    })).toEqual({
      eventName: "SessionStart",
      source: "resume",
      sessionId: threadId,
      transcript: "present",
      rootMatch: "yes",
    });
  });

  test("Codex hook diagnostics expose inherited and absent transcript evidence", () => {
    const rootThreadId = "019fc273-a35b-78f0-9a70-f63b5905540f";
    const hiddenThreadId = "019fd84b-4556-7fd2-8e21-3fac2582d757";
    expect(codexHookSessionDiagnostic({
      session_id: hiddenThreadId,
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: `C:\\Codex\\sessions\\rollout-${rootThreadId}.jsonl`,
    })).toMatchObject({ transcript: "present", rootMatch: "no" });
    expect(codexHookSessionDiagnostic({
      session_id: hiddenThreadId,
      hook_event_name: "SessionStart",
      source: "startup",
    })).toMatchObject({ transcript: "absent", rootMatch: "unknown" });
    expect(codexHookSessionDiagnostic({
      session_id: hiddenThreadId,
      hook_event_name: "Session Start with spaces",
      source: { untrusted: true },
      transcript_path: "/tmp/not-a-rollout.jsonl",
    })).toMatchObject({ eventName: "unknown", source: "unknown", transcript: "present", rootMatch: "unknown" });
  });

  test("Codex root proof rejects child and internal-session lifecycle payloads", () => {
    const rootThreadId = "019fc273-a35b-78f0-9a70-f63b5905540f";
    const hiddenSessionId = "019fd84b-4556-7fd2-8e21-3fac2582d757";
    const rootTranscript = `/not-yet-created/rollout-${rootThreadId}.jsonl`;

    expect(codexHookRootRefusalReason({
      session_id: rootThreadId,
      hook_event_name: "SessionStart",
      transcript_path: rootTranscript,
    }, "SessionStart")).toBeNull();
    expect(codexHookRootRefusalReason({
      session_id: rootThreadId,
      hook_event_name: "SubagentStart",
      transcript_path: rootTranscript,
    }, "SessionStart")).toBe("event-mismatch");
    expect(codexHookRootRefusalReason({
      session_id: hiddenSessionId,
      hook_event_name: "SessionStart",
    }, "SessionStart")).toBe("missing-transcript-path");
    expect(codexHookRootRefusalReason({
      session_id: hiddenSessionId,
      hook_event_name: "SessionStart",
      transcript_path: "/memory/rollout-not-a-uuid.jsonl",
    }, "SessionStart")).toBeNull();
    expect(codexHookRootDegradedReason({
      session_id: hiddenSessionId,
      hook_event_name: "SessionStart",
      transcript_path: "/memory/rollout-not-a-uuid.jsonl",
    })).toBe("unparseable-transcript-path");
    expect(codexHookRootRefusalReason({
      session_id: hiddenSessionId,
      hook_event_name: "SessionStart",
      transcript_path: rootTranscript,
    }, "SessionStart")).toBe("transcript-session-mismatch");
    // A subagent turn carries the ROOT's session_id plus serialized
    // agent_id/agent_type — the one imposter session/transcript comparison
    // cannot catch, refused on the field Codex provides for it.
    expect(codexHookRootRefusalReason({
      session_id: rootThreadId,
      hook_event_name: "UserPromptSubmit",
      transcript_path: rootTranscript,
      agent_id: "agent-1",
      agent_type: "review",
    }, "UserPromptSubmit")).toBe("subagent-context");
  });

  test("Codex drain decision routes a transcript-less root by exact thread join instead of refusing", () => {
    const rootThreadId = "019fc273-a35b-78f0-9a70-f63b5905540f";
    const rootTranscript = `/not-yet-created/rollout-${rootThreadId}.jsonl`;

    // Codex omits transcript_path when the thread has no materialized rollout
    // (persistence off / rollout IO pending) — measured on live root lanes.
    // The drain must not refuse: the thread-routed claim is its proof.
    expect(codexDrainRootDecision({
      session_id: rootThreadId,
      hook_event_name: "UserPromptSubmit",
    }, "UserPromptSubmit")).toEqual({ action: "thread-only" });
    expect(codexDrainRootDecision({
      session_id: rootThreadId,
      hook_event_name: "Stop",
    }, "Stop")).toEqual({ action: "thread-only" });
    // A matching transcript is still the strongest proof and keeps full recovery.
    expect(codexDrainRootDecision({
      session_id: rootThreadId,
      hook_event_name: "UserPromptSubmit",
      transcript_path: rootTranscript,
    }, "UserPromptSubmit")).toEqual({ action: "proven", degraded: null });
    // Positive evidence of another thread still refuses outright.
    expect(codexDrainRootDecision({
      session_id: "019fd84b-4556-7fd2-8e21-3fac2582d757",
      hook_event_name: "UserPromptSubmit",
      transcript_path: rootTranscript,
    }, "UserPromptSubmit")).toEqual({ action: "refuse", reason: "transcript-session-mismatch" });
    // Subagent context refuses even with the root's id and a matching transcript.
    expect(codexDrainRootDecision({
      session_id: rootThreadId,
      hook_event_name: "UserPromptSubmit",
      transcript_path: rootTranscript,
      agent_type: "review",
    }, "UserPromptSubmit")).toEqual({ action: "refuse", reason: "subagent-context" });
    // An unparseable-but-present path stays fail-open, flagged degraded.
    expect(codexDrainRootDecision({
      session_id: rootThreadId,
      hook_event_name: "UserPromptSubmit",
      transcript_path: "/memory/rollout-not-a-uuid.jsonl",
    }, "UserPromptSubmit")).toEqual({ action: "proven", degraded: "unparseable-transcript-path" });
  });

  test("an unresolved app-server seat names the blocked tool and the safe recovery boundary", () => {
    const diagnostic = unresolvedAppServerToolDiagnostic("whoami", "durable seat missing");
    expect(diagnostic).toContain("did not run whoami");
    expect(diagnostic).toContain("durable seat missing");
    expect(diagnostic).toContain("MCP replies and mailbox reads are disabled");
    expect(diagnostic).toContain("Inbound pane-hook delivery may still work");
  });

  test("an MCP transport never unregisters the live TUI row it adopted from the hook", () => {
    expect(shouldUnregisterPeerOnShutdown("peer-1", false)).toBe(true);
    expect(shouldUnregisterPeerOnShutdown("peer-1", true)).toBe(false);
    expect(shouldUnregisterPeerOnShutdown(null, false)).toBe(false);
  });

  test("manual check_messages uses only an exact registered Codex client pid", () => {
    expect(selectCodexManualDrainPid("codex", 48_327, 99_999)).toBe(48_327);
    expect(selectCodexManualDrainPid("codex", 99_999, 99_999)).toBeNull();
    expect(selectCodexManualDrainPid("claude", 48_327, 99_999)).toBeNull();
  });

  test("inbox claims prefer thread identity and otherwise fail closed for an unbound Codex app-server", () => {
    expect(selectInboxClaimIdentity("codex", 99_999, 99_999, "thread-123")).toEqual({
      kind: "thread",
      thread_id: "thread-123",
    });
    expect(selectInboxClaimIdentity("codex", 48_327, 99_999, null)).toEqual({ kind: "pid", pid: 48_327 });
    expect(selectInboxClaimIdentity("codex", 99_999, 99_999, null)).toBeNull();
    expect(selectInboxClaimIdentity("claude", 48_327, 99_999, null)).toEqual({ kind: "pid", pid: 48_327 });
    expect(selectInboxClaimIdentity("claude", 1, 99_999, null)).toBeNull();
  });

  test("Codex app-server hook refuses ambiguous same-cwd visible Codex sessions", () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, comm: "codex", args: "codex app-server --listen unix://" }],
      [200, { pid: 200, ppid: 50, comm: "codex", args: "codex" }],
      [201, { pid: 201, ppid: 51, comm: "codex", args: "codex" }],
      [300, { pid: 300, ppid: 100, comm: "bun", args: "bun hooks/codex-drain-peer-inbox.ts" }],
    ]);
    const cwd = (candidate: number) => candidate === 100 || candidate === 200 || candidate === 201 ? "/home/manzo/Clause5" : "/other";
    const hasIdentity = (candidate: number) => candidate === 200 || candidate === 201;

    const pids = findHookPeerPidsFromTable(processes, 300, "/ignored", cwd, "codex", null, hasIdentity, (candidate) =>
      candidate === 200 || candidate === 201 ? `pts/${candidate}` : null
    );

    expect(pids).toBeNull();
  });

  (canCreateTmuxSession() ? test : test.skip)("register hook mirrors broker identity into tmux peer fields without changing operator label", () => {
    const session = `claude-peers-register-hook-${process.pid}-${Date.now()}`;
    const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", session], { stdout: "ignore", stderr: "ignore" });
    expect(created.exitCode).toBe(0);

    try {
      const paneIdResult = Bun.spawnSync(["tmux", "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const paneId = new TextDecoder().decode(paneIdResult.stdout).trim();
      expect(paneId).toMatch(/^%/);

      Bun.spawnSync(["tmux", "set-option", "-p", "-t", paneId, "@operator_label", "human.pr"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      Bun.spawnSync(["tmux", "set-option", "-p", "-t", paneId, "@peer_id", "stale-peer"], {
        stdout: "ignore",
        stderr: "ignore",
      });

      const result = publishBrokerIdentityToTmux({
        id: "fresh-peer",
        name: "pr.1",
        resolved_name: "pr.1",
        client_type: "codex",
        receiver_mode: "codex-hook",
      }, {
        session,
        window_index: "0",
        window_name: "0",
        pane_id: paneId,
      }, {}, { CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "1" });

      const readOption = (name: string): string => {
        const result = Bun.spawnSync(["tmux", "show-options", "-p", "-t", paneId, "-v", name], {
          stdout: "pipe",
          stderr: "ignore",
        });
        return new TextDecoder().decode(result.stdout).trim();
      };

      expect(result.ok).toBe(true);
      expect(result.target).toBe(paneId);
      expect(readOption("@operator_label")).toBe("human.pr");
      expect(readOption("@peer_id")).toBe("fresh-peer");
      expect(readOption("@peer_label")).toBe("pr.1");
      expect(readOption("@peer_resolved_name")).toBe("pr.1");
      expect(readOption("@peer_client_type")).toBe("codex");
      expect(readOption("@peer_receiver_mode")).toBe("codex-hook");
      const writableOptions = [
        "@operator_label",
        "@peer_id",
        "@peer_label",
        "@peer_resolved_name",
        "@peer_client_type",
        "@peer_receiver_mode",
      ];
      const beforeDisabledPublish = Object.fromEntries(writableOptions.map((option) => [option, readOption(option)]));

      const skipped = publishBrokerIdentityToTmux({
        id: "must-not-write",
        name: "test-leak",
        resolved_name: "test-leak",
        client_type: "codex",
        receiver_mode: "codex-hook",
      }, {
        session,
        window_index: "0",
        window_name: "0",
        pane_id: paneId,
      }, {
        TMUX_PANE: paneId,
      }, {
        CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "0",
      });
      expect(skipped).toEqual({ ok: true, target: null, failedOptions: [], skipped: true });
      expect(Object.fromEntries(writableOptions.map((option) => [option, readOption(option)]))).toEqual(beforeDisabledPublish);
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
  });

  test("register hook mirror opt-out accepts every supported false spelling", () => {
    for (const value of ["0", "false", "no", "off", " FALSE "]) {
      expect(tmuxIdentityMirrorEnabled({ CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: value })).toBe(false);
    }
    expect(tmuxIdentityMirrorEnabled({ CLAUDE_PEERS_TMUX_IDENTITY_MIRROR: "1" })).toBe(true);
    expect(tmuxIdentityMirrorEnabled({})).toBe(true);
  });

  test("register hook publishes the broker identity returned by registration", () => {
    const src = readFileSync(new URL("../hooks/register-peer-session.ts", import.meta.url), "utf8");
    expect(src).toContain('const reg = await post<RegisterResponse>("/register"');
    expect(src).toContain("publishBrokerIdentityToTmux(reg, meta.tmux, meta.identity_env)");
    expect(src).toContain("receiver_mode: RECEIVER_MODE");
  });

  test("register hook pane fallback uses the selected visible client env", () => {
    expect(registrationTmuxPaneId(null, { TMUX_PANE: "%visible" })).toBe("%visible");
    expect(registrationTmuxPaneId(null, {})).toBeNull();
    expect(registrationTmuxPaneId({
      session: "pr",
      window_index: "1",
      window_name: "node",
      pane_id: "%walked",
    }, { TMUX_PANE: "%visible" })).toBe("%walked");
  });

  test("register hook passes selected identity env into tmux fallback", () => {
    const src = readFileSync(new URL("../hooks/register-peer-session.ts", import.meta.url), "utf8");
    expect(src).toContain("const tmux = detectTmuxPane(pid, identityEnv)");
    expect(src).toContain("tmux_pane_id: registrationTmuxPaneId(meta.tmux, meta.identity_env)");
    expect(src).toContain("publishBrokerIdentityToTmux(reg, meta.tmux, meta.identity_env)");
    expect(src).not.toContain("tmux_pane_id: meta.tmux?.pane_id ?? (process.env.TMUX_PANE ?? null)");
  });

  test("register hook metadata refresh preserves operator summaries", () => {
    const src = readFileSync(new URL("../hooks/register-peer-session.ts", import.meta.url), "utf8");
    expect(src).toContain('summary: ""');
    expect(src).not.toContain("startup registered");
  });

  test("register hook exits nonzero when no client ancestor can be resolved", () => {
    const hookPath = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync(["bun", hookPath], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CLIENT_TYPE: "gemini",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toContain("no gemini ancestor found");
  });

  test("Codex register hook fails loudly when session_id is missing", () => {
    const hookPath = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        ...process.env,
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
      },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", source: "resume" })),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain("refusing an unbound Codex registration");
  });

  test.each([
    ["thread-spawn child", {
      session_id: "019fc273-a35b-78f0-9a70-f63b5905540f",
      hook_event_name: "SubagentStart",
      transcript_path: "/tmp/rollout-019fc273-a35b-78f0-9a70-f63b5905540f.jsonl",
    }, "event-mismatch"],
    ["ephemeral internal session", {
      session_id: "019fd84b-4556-7fd2-8e21-3fac2582d757",
      hook_event_name: "SessionStart",
    }, "missing-transcript-path"],
  ])("Codex register hook skips a %s before resolving or mutating a seat", (_label, payload, reason) => {
    const hookPath = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
        PATH: "/definitely-missing",
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(stderr).toContain(`skipping unproven Codex registration reason=${reason}`);
    if (reason === "missing-transcript-path") {
      expect(stderr).toContain("possible=internal-session-or-root-rollout-io correlate=codex-warning-log");
    }
    expect(stderr).not.toContain("unexpected failure");
  });

  test("Codex register hook logs and fails open when an upstream transcript filename is unparseable", () => {
    const hookPath = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
        PATH: "/definitely-missing",
      },
      stdin: new TextEncoder().encode(JSON.stringify({
        session_id: "019fc273-a35b-78f0-9a70-f63b5905540f",
        hook_event_name: "SessionStart",
        transcript_path: "/future-codex/thread-transcript.jsonl",
      })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("root proof degraded reason=unparseable-transcript-path; continuing fail-open");
    expect(stderr).not.toContain("skipping unproven Codex registration");
  });

  test("Codex register hook reports an unexpected metadata failure as nonzero", () => {
    const hookPath = new URL("../hooks/register-peer-session.ts", import.meta.url).pathname;
    const proc = Bun.spawnSync([process.execPath, hookPath], {
      env: {
        CLAUDE_PEERS_CLIENT_TYPE: "codex",
        PATH: "/definitely-missing",
      },
      stdin: new TextEncoder().encode(JSON.stringify({
        session_id: "019fc273-a35b-78f0-9a70-f63b5905540f",
        hook_event_name: "SessionStart",
        source: "resume",
        transcript_path: "/tmp/rollout-019fc273-a35b-78f0-9a70-f63b5905540f.jsonl",
      })),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain("unexpected failure");
  });

  test("broker systemd startup is bounded by timeout", () => {
    const serverSrc = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const hookSrc = readFileSync(new URL("../hooks/register-peer-session.ts", import.meta.url), "utf8");

    expect(serverSrc).toContain('["timeout", SYSTEMD_START_TIMEOUT_SECONDS, "systemctl"');
    expect(hookSrc).toContain('["timeout", SYSTEMD_START_TIMEOUT_SECONDS, "systemctl"');
  });

  test("Gemini hook discovers the MCP server from process ancestry without env PID", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "gemini", args: "gemini" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bun", args: "bun hooks/gemini-drain-peer-inbox.sh" }],
    ]);
    const pid = findMcpPidFromTable(processes, 10, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other", "gemini");
    expect(pid).toBe(20);
  });

  test("Gemini hook prefers the CLI process as the registered peer pid", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "gemini", args: "gemini" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bash", args: "bash /home/manzo/claude-peers-mcp/hooks/gemini-drain-peer-inbox.sh" }],
    ]);
    const pid = findClientPidFromTable(processes, 30, "gemini");
    expect(pid).toBe(10);
  });

  test("Gemini hook process name is not mistaken for the Gemini CLI ancestor", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "gemini", args: "gemini" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bash", args: "bash /home/manzo/claude-peers-mcp/hooks/gemini-drain-peer-inbox.sh" }],
    ]);
    const pid = findMcpPidFromTable(processes, 30, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other", "gemini");
    expect(pid).toBe(20);
  });

  test("Gemini hook discovers the MCP server when the CLI ancestor is a Node shim", () => {
    const processes = new Map([
      [10, { pid: 10, ppid: 1, comm: "node", args: "node /usr/local/lib/node_modules/@google/gemini-cli/dist/gemini.js" }],
      [20, { pid: 20, ppid: 10, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" }],
      [30, { pid: 30, ppid: 10, comm: "bash", args: "bash /home/manzo/claude-peers-mcp/hooks/gemini-drain-peer-inbox.sh" }],
    ]);
    const pid = findMcpPidFromTable(processes, 30, "/repo", (candidate) => candidate === 20 ? "/repo" : "/other", "gemini");
    expect(pid).toBe(20);
  });
});

describe("findBgSpareAncestor", () => {
  test("detects a --bg-spare claude ancestor", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 1, comm: "claude", args: "claude --bg-spare /tmp/cc-daemon-1000/x/spare/17e52" },
    ]);
    expect(findBgSpareAncestor(30, processes)?.pid).toBe(20);
  });

  test("regular session chain returns null", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun /home/manzo/claude-peers-mcp/server.ts" },
      { pid: 20, ppid: 10, comm: "claude", args: "claude --dangerously-skip-permissions" },
      { pid: 10, ppid: 1, comm: "bash", args: "bash" },
    ]);
    expect(findBgSpareAncestor(30, processes)).toBeNull();
  });

  test("does not match --bg-spare as a substring of another flag", () => {
    const processes = table([
      { pid: 30, ppid: 20, comm: "bun", args: "bun server.ts" },
      { pid: 20, ppid: 1, comm: "claude", args: "claude --bg-spare-pool-size 2" },
    ]);
    expect(findBgSpareAncestor(30, processes)).toBeNull();
  });

  test("terminates on ppid self-cycle", () => {
    const processes = table([
      { pid: 30, ppid: 30, comm: "bun", args: "bun server.ts" },
    ]);
    expect(findBgSpareAncestor(30, processes)).toBeNull();
  });
});

describe("node-shim codex TUI detection", () => {
  test("classifies `node .../bin/codex --remote` as a codex client", () => {
    // The codexd relaunch shape that kept lanes off the bus: the TUI runs
    // under the npm bin shim, so comm/firstArg say "node", and the ancestor
    // walk found no codex client at all ("no codex ancestor found").
    const row = { pid: 1, ppid: 0, comm: "node", args: "node /home/x/.nvm/versions/node/v22/bin/codex --remote unix:// --cd /repo resume t" };
    expect(isClientProcess(row, "codex")).toBe(true);
    // A node process running something else stays non-codex.
    expect(isClientProcess({ pid: 2, ppid: 0, comm: "node", args: "node /srv/app/server.js" }, "codex")).toBe(false);
    // And the shim never leaks into other client types.
    expect(isClientProcess(row, "claude")).toBe(false);
  });
});
