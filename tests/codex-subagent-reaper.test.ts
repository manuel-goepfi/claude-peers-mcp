import { describe, expect, test } from "bun:test";
import { jsonRpcConnection, type RpcConnection } from "../bin/codex-thread-stop.ts";
import { classifyThread, parseReaperArgs, REAPER_EXIT, runCodexSubagentReaper } from "../bin/codex-subagent-reaper.ts";
import { FakeCodexAppServer, type FakeThread } from "./fixtures/fake-codex-app-server.ts";

const SOCKET_A = "/run/user/1000/codex-test/account-a.sock";
const SOCKET_B = "/run/user/1000/codex-test/account-b.sock";

const LANE_A = "01a11200-0000-7000-8000-00000000000a";
const LANE_B = "01a11200-0000-7000-8000-00000000000b";
const LANE_ERR = "01a11200-0000-7000-8000-0000000000e0";
const PARENT_GONE = "01a11200-0000-7000-8000-0000000000f0";
const ORPHAN_OLD = "01a11200-0000-7000-8000-000000000001";
const ORPHAN_YOUNG = "01a11200-0000-7000-8000-000000000002";
const ORPHAN_ACTIVE = "01a11200-0000-7000-8000-000000000003";
const CHILD_OF_LANE_A = "01a11200-0000-7000-8000-000000000004";
const CHILD_OF_LANE_B = "01a11200-0000-7000-8000-000000000005";
const ORPHAN_ERR = "01a11200-0000-7000-8000-000000000006";
const SUBAGENT_NO_PARENT = "01a11200-0000-7000-8000-000000000007";
const UNKNOWN_SOURCE = "01a11200-0000-7000-8000-000000000008";
const ORPHAN_NO_AGE = "01a11200-0000-7000-8000-000000000009";
const ORPHAN_ODD_STATUS = "01a11200-0000-7000-8000-00000000000a";
const UNREADABLE = "01a11200-0000-7000-8000-00000000000b";

const NOW_MS = Date.UTC(2026, 9, 6, 18, 0, 0);
const minutesAgo = (minutes: number) => Math.floor((NOW_MS - minutes * 60_000) / 1000);

function connectTo(servers: Record<string, FakeCodexAppServer>, connects: string[] = []): (socket: string) => Promise<RpcConnection> {
  return async (socket) => {
    connects.push(socket);
    const fake = servers[socket];
    if (!fake) throw new Error(`connect ENOENT ${socket}`);
    let listener: ((text: string) => void) | null = null;
    return jsonRpcConnection({
      send(text) {
        const frames = fake.handle(text);
        queueMicrotask(() => { for (const frame of frames) listener?.(frame); });
      },
      onMessage(next) { listener = next; },
      onClose() {},
      close() {},
    }, 2_000);
  };
}

/**
 * Server A carries every case; server B carries a lane whose subagent runs on
 * A (cross-server parent). PARENT_GONE is loaded nowhere.
 */
function fleet(overrides: Record<string, FakeThread> = {}) {
  const a = new FakeCodexAppServer({
    [LANE_A]: { status: "idle", updatedAt: minutesAgo(600) },
    [LANE_ERR]: { status: "systemError", updatedAt: minutesAgo(600) },
    [ORPHAN_OLD]: { status: "idle", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(120) },
    [ORPHAN_YOUNG]: { status: "idle", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(5) },
    [ORPHAN_ACTIVE]: { status: "active", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(120), turns: [{ id: "turn-busy", status: "inProgress" }] },
    [ORPHAN_ERR]: { status: "systemError", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(120) },
    [CHILD_OF_LANE_A]: { status: "idle", parentThreadId: LANE_A, updatedAt: minutesAgo(300) },
    [CHILD_OF_LANE_B]: { status: "idle", parentThreadId: LANE_B, updatedAt: minutesAgo(300) },
    ...overrides,
  });
  const b = new FakeCodexAppServer({ [LANE_B]: { status: "idle", updatedAt: minutesAgo(10) } });
  return { a, b, servers: { [SOCKET_A]: a, [SOCKET_B]: b } };
}

async function reap(args: string[], servers: Record<string, FakeCodexAppServer>, knownSockets = [SOCKET_A, SOCKET_B]) {
  const parsed = parseReaperArgs(args);
  if (!parsed.ok) throw new Error(parsed.error);
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runCodexSubagentReaper(parsed.options, {
    connect: connectTo(servers),
    // Never enumerate the host's real app-server sockets from a test.
    knownSockets: () => knownSockets,
    canonical: (path) => path,
    now: () => NOW_MS,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  });
  return { code, lines, errors, text: lines.join("\n") };
}

const archivedIds = (fake: FakeCodexAppServer) => fake.mutatingCalls().filter((call) => call.method === "thread/archive").map((call) => call.threadId);

describe("codex-subagent-reaper --apply", () => {
  test("(a) an idle orphan past the grace period is archived and verified unloaded", async () => {
    const { a, b, servers } = fleet();
    const run = await reap(["--apply"], servers);
    expect(run.code).toBe(REAPER_EXIT.ok);
    expect(archivedIds(a)).toEqual([ORPHAN_OLD]);
    expect(a.loadedIds()).not.toContain(ORPHAN_OLD);
    expect(run.text).toContain(`archived ${ORPHAN_OLD}`);
    expect(b.mutatingCalls()).toEqual([]);
  });

  test("(b) an orphan updated inside the grace period is kept", async () => {
    const { a, servers } = fleet();
    const run = await reap(["--apply"], servers);
    expect(archivedIds(a)).not.toContain(ORPHAN_YOUNG);
    expect(a.loadedIds()).toContain(ORPHAN_YOUNG);
    expect(run.text).toMatch(new RegExp(`keep +${ORPHAN_YOUNG}.*inside the 30m grace period`));
    // A shorter grace period makes the same thread eligible.
    const short = fleet();
    await reap(["--apply", "--grace-min", "2"], short.servers);
    expect(archivedIds(short.a)).toContain(ORPHAN_YOUNG);
  });

  test("(c) a subagent whose parent is loaded, on this or another app-server, is kept", async () => {
    const { a, servers } = fleet();
    const run = await reap(["--apply"], servers);
    expect(archivedIds(a)).not.toContain(CHILD_OF_LANE_A);
    expect(archivedIds(a)).not.toContain(CHILD_OF_LANE_B);
    expect(a.loadedIds()).toEqual(expect.arrayContaining([CHILD_OF_LANE_A, CHILD_OF_LANE_B]));
    expect(run.text).toContain(`parent ${LANE_B} is loaded`);
  });

  test("(d) an active orphan is kept and its turn is not touched", async () => {
    const { a, servers } = fleet();
    const run = await reap(["--apply"], servers);
    expect(archivedIds(a)).not.toContain(ORPHAN_ACTIVE);
    expect(a.threads.get(ORPHAN_ACTIVE)!.turns![0]!.status).toBe("inProgress");
    expect(run.text).toMatch(new RegExp(`keep +${ORPHAN_ACTIVE}.*status active`));
  });

  test("(e) a systemError lane thread is reported, never archived; lane threads are never archived", async () => {
    const { a, servers } = fleet();
    const run = await reap(["--apply"], servers);
    expect(archivedIds(a)).not.toContain(LANE_ERR);
    expect(archivedIds(a)).not.toContain(LANE_A);
    expect(archivedIds(a)).not.toContain(ORPHAN_ERR);
    expect(a.loadedIds()).toEqual(expect.arrayContaining([LANE_ERR, LANE_A, ORPHAN_ERR]));
    expect(run.text).toMatch(new RegExp(`report +${LANE_ERR}.*lane thread in systemError`));
    expect(run.text).toMatch(new RegExp(`report +${ORPHAN_ERR}.*systemError`));
    // Exactly one archive in the whole fleet run: the idle, old orphan.
    expect(a.mutatingCalls().map((call) => [call.method, call.threadId])).toEqual([["thread/archive", ORPHAN_OLD]]);
  });

  test("a parent that comes back between the survey and the archive cancels that archive", async () => {
    const { a, b, servers } = fleet();
    const original = a.handle.bind(a);
    let surveyed = false;
    a.handle = (text: string) => {
      const frames = original(text);
      const message = JSON.parse(text) as { method?: string; params?: { threadId?: string } };
      if (!surveyed && message.method === "thread/read" && message.params?.threadId === ORPHAN_OLD) {
        surveyed = true;
        b.threads.set(PARENT_GONE, { status: "idle", updatedAt: minutesAgo(0) });
      }
      return frames;
    };
    const run = await reap(["--apply"], servers);
    expect(run.code).toBe(REAPER_EXIT.ok);
    expect(archivedIds(a)).toEqual([]);
    expect(run.text).toContain(`skipped ${ORPHAN_OLD}: parent ${PARENT_GONE} is loaded`);
  });

  test("an archive that does not unload is a failure (exit 1)", async () => {
    const { a, servers } = fleet({ [ORPHAN_OLD]: { status: "idle", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(120), failArchive: 1 } });
    const run = await reap(["--apply"], servers);
    expect(run.code).toBe(REAPER_EXIT.failed);
    expect(a.loadedIds()).toContain(ORPHAN_OLD);
    expect(run.text).toContain(`FAILED  ${ORPHAN_OLD}`);
  });

  test("an unreachable known app-server refuses the whole run: no archive anywhere", async () => {
    const { a, servers } = fleet();
    const run = await reap(["--apply"], servers, [SOCKET_A, SOCKET_B, "/run/user/1000/codex-test/account-c.sock"]);
    expect(run.code).toBe(REAPER_EXIT.refused);
    expect(run.errors.join("\n")).toContain("unreachable");
    expect(a.mutatingCalls()).toEqual([]);
  });
});

describe("codex-subagent-reaper dry run", () => {
  test("(f) without --apply nothing is archived, and the plan names the candidate", async () => {
    expect(parseReaperArgs([])).toEqual({ ok: true, options: { apply: false, graceMs: 30 * 60_000 } });
    const { a, b, servers } = fleet();
    const run = await reap([], servers);
    expect(run.code).toBe(REAPER_EXIT.ok);
    expect(a.mutatingCalls()).toEqual([]);
    expect(b.mutatingCalls()).toEqual([]);
    expect(a.loadedIds()).toContain(ORPHAN_OLD);
    expect(run.text).toMatch(new RegExp(`archive +${ORPHAN_OLD}`));
    expect(run.text).toContain("dry run");
    const explicit = await reap(["--dry-run"], fleet().servers);
    expect(explicit.text).toContain("1 to archive");
  });

  test("argument parsing", () => {
    expect(parseReaperArgs(["--apply", "--grace-min", "45"])).toEqual({ ok: true, options: { apply: true, graceMs: 45 * 60_000 } });
    expect(parseReaperArgs(["--apply", "--dry-run"]).ok).toBe(false);
    expect(parseReaperArgs(["--grace-min", "0"]).ok).toBe(false);
    expect(parseReaperArgs(["--grace-min"]).ok).toBe(false);
    expect(parseReaperArgs(["--grace-min", "1.5"]).ok).toBe(false);
    expect(parseReaperArgs(["--everything"]).ok).toBe(false);
  });

  test("classification rule", () => {
    const loaded = new Set([LANE_A]);
    const base = { socket: SOCKET_A, threadId: ORPHAN_OLD, status: "idle", parentThreadId: PARENT_GONE, updatedAt: NOW_MS - 120 * 60_000, sourceKind: "subagent" as const };
    const grace = 30 * 60_000;
    expect(classifyThread(base, loaded, NOW_MS, grace).action).toBe("archive");
    expect(classifyThread({ ...base, parentThreadId: LANE_A }, loaded, NOW_MS, grace).action).toBe("keep");
    expect(classifyThread({ ...base, status: "active" }, loaded, NOW_MS, grace).action).toBe("keep");
    expect(classifyThread({ ...base, status: "unknown" }, loaded, NOW_MS, grace).action).toBe("report");
    expect(classifyThread({ ...base, updatedAt: null }, loaded, NOW_MS, grace).action).toBe("report");
    expect(classifyThread({ ...base, updatedAt: NOW_MS - 29 * 60_000 }, loaded, NOW_MS, grace).action).toBe("keep");
    const lane = { ...base, parentThreadId: null, sourceKind: "top-level" as const };
    expect(classifyThread(lane, loaded, NOW_MS, grace).action).toBe("keep");
    expect(classifyThread({ ...lane, status: "systemError" }, loaded, NOW_MS, grace).action).toBe("report");
    expect(classifyThread({ ...lane, status: "unknown" }, loaded, NOW_MS, grace).action).toBe("report");
    // Never "lane thread" unless the source says so.
    expect(classifyThread({ ...lane, sourceKind: "subagent" }, loaded, NOW_MS, grace)).toMatchObject({ action: "report" });
    expect(classifyThread({ ...lane, sourceKind: "unknown" }, loaded, NOW_MS, grace)).toMatchObject({ action: "report" });
  });
});

describe("codex-subagent-reaper: ambiguous threads are kept and reported", () => {
  function ambiguousFleet() {
    const { a, b, servers } = fleet({
      // Subagent-typed source but no parent id: not a lane thread, not provably orphaned.
      [SUBAGENT_NO_PARENT]: { status: "idle", updatedAt: minutesAgo(600), source: { subAgent: "review" } },
      [UNKNOWN_SOURCE]: { status: "idle", updatedAt: minutesAgo(600), source: { internal: "memory_consolidation" } },
      [ORPHAN_NO_AGE]: { status: "idle", parentThreadId: PARENT_GONE, updatedAt: null },
      [ORPHAN_ODD_STATUS]: { status: "unknownFutureStatus", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(600) },
      [UNREADABLE]: { status: "idle", parentThreadId: PARENT_GONE, updatedAt: minutesAgo(600) },
    });
    const original = a.handle.bind(a);
    a.handle = (text: string) => {
      const message = JSON.parse(text) as { id?: string; method?: string; params?: { threadId?: string } };
      if (message.method === "thread/read" && message.params?.threadId === UNREADABLE) {
        return [JSON.stringify({ id: message.id, error: { code: -32001, message: "thread/read timed out" } })];
      }
      return original(text);
    };
    return { a, b, servers };
  }

  test("each ambiguous thread is reported, none is archived, and only the provable orphan goes", async () => {
    const { a, servers } = ambiguousFleet();
    const run = await reap(["--apply"], servers);
    expect(run.code).toBe(REAPER_EXIT.ok);
    expect(archivedIds(a)).toEqual([ORPHAN_OLD]);
    expect(a.loadedIds()).toEqual(expect.arrayContaining([SUBAGENT_NO_PARENT, UNKNOWN_SOURCE, ORPHAN_NO_AGE, ORPHAN_ODD_STATUS, UNREADABLE]));
    expect(run.text).toMatch(new RegExp(`report +${SUBAGENT_NO_PARENT}.*subagent-typed thread with no parent id`));
    expect(run.text).toMatch(new RegExp(`report +${UNKNOWN_SOURCE}.*unknown thread source`));
    expect(run.text).toMatch(new RegExp(`report +${ORPHAN_NO_AGE}.*no updatedAt`));
    expect(run.text).toMatch(new RegExp(`report +${ORPHAN_ODD_STATUS}.*unknown status unknownFutureStatus`));
    expect(run.text).toMatch(new RegExp(`report +${UNREADABLE}.*unreadable`));
    expect(run.text).not.toMatch(new RegExp(`${SUBAGENT_NO_PARENT}.*: lane thread$`, "m"));
  });
});
