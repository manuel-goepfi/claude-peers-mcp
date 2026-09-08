import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanesWithUnread, pendingUnreadForPeer, tick, loadNudgeBudgetState,
  __resetNudgeBudgetStateForTest, __nudgeAttemptCountForTest } from "../bin/codex-autodrain-poller.ts";

const prefix = `live:${"a".repeat(64)}`;
function fixture() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER, name TEXT, client_type TEXT,
    tmux_pane_id TEXT, thread_id TEXT, seat_key TEXT, receiver_mode TEXT,
    last_hook_seen_at TEXT, unread_episode INTEGER DEFAULT 0)`);
  db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, to_id TEXT, delivered INTEGER)");
  for (const [id,role] of [["native","native"],["alias","alias"]] as const) {
    db.run("INSERT INTO peers VALUES (?,123,'Orch.1','claude','%1','thread',?,'claude-channel',NULL,3)",
      [id,`${prefix}:${role}:${"b".repeat(64)}`]);
  }
  db.run("INSERT INTO messages VALUES (1,'alias',0),(2,'native',0),(3,'alias',1)");
  return db;
}

test("one current native candidate counts alias mail; final boundary rejects changed ownership or drained mail", () => {
  const db = fixture();
  try {
    const native = (id:string) => id === "native";
    const lanes = lanesWithUnread(db,["claude"],native);
    expect(lanes.map(lane=>[lane.id,lane.unread])).toEqual([["native",2]]);
    expect(pendingUnreadForPeer(db,"native",native)).toBe(2);
    expect(pendingUnreadForPeer(db,"alias",native)).toBe(0);
    expect(pendingUnreadForPeer(db,"native",()=>false)).toBe(0);
    // The production verifier cannot prove these synthetic PIDs and refuses them.
    expect(lanesWithUnread(db,["claude"])).toEqual([]);
    expect(pendingUnreadForPeer(db,"native")).toBe(0);
    db.run("UPDATE messages SET delivered=1 WHERE to_id='native'");
    expect(pendingUnreadForPeer(db,"native",native)).toBe(1);
    db.run("UPDATE messages SET delivered=1");
    expect(pendingUnreadForPeer(db,"native",native)).toBe(0);
    expect(lanesWithUnread(db,["claude"],native)).toEqual([]);
  } finally {db.close();}
});

test("durable native attempt budget survives alias-only pending mail and expires only when drained", () => {
  const db = fixture(), root = mkdtempSync(join(tmpdir(),"poller-mailbox-budget-")), path = join(root,"budget.json");
  __resetNudgeBudgetStateForTest();
  try {
    db.run("UPDATE messages SET delivered=1 WHERE to_id='native'");
    writeFileSync(path,JSON.stringify({version:1,peers:{native:{episode:3,attempts:5,last_nudge_at:1000}}}),{mode:0o600});
    expect(loadNudgeBudgetState(path)).toBe(true);
    tick(db,{procs:[],paneByPid:new Map(),paneMap:new Map()},{nudgeableClients:["claude"]});
    expect(__nudgeAttemptCountForTest("native")).toBe(5);
    expect(JSON.parse(readFileSync(path,"utf8")).peers.native.attempts).toBe(5);
    db.run("UPDATE messages SET delivered=1");
    tick(db,{procs:[],paneByPid:new Map(),paneMap:new Map()},{nudgeableClients:["claude"]});
    expect(__nudgeAttemptCountForTest("native")).toBeUndefined();
  } finally {__resetNudgeBudgetStateForTest();db.close();rmSync(root,{recursive:true,force:true});}
});
