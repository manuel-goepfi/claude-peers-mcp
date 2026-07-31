import { describe, expect, test } from "bun:test";
import {
  durableSeatKey,
  mergeSeatPids,
  parseSeatPids,
  seatKeyBackfillSql,
  seatKeyPaneUpgradeSql,
  seatPidsAlive,
  serializeSeatPids,
  MAX_SEAT_PIDS,
} from "../shared/seat.ts";
import { Database } from "bun:sqlite";

describe("durableSeatKey", () => {
  test("prefers the tmux pane", () => {
    expect(durableSeatKey({ tmux_session: "infra", tmux_pane_id: "%1132", tty: "pts/21" }))
      .toBe("pane:infra:%1132");
  });

  test("falls back to the tty when there is no pane", () => {
    expect(durableSeatKey({ tmux_session: null, tmux_pane_id: null, tty: "pts/21" })).toBe("tty:pts/21");
  });

  test("a session without a pane id is not a pane seat", () => {
    expect(durableSeatKey({ tmux_session: "infra", tmux_pane_id: null, tty: null })).toBeNull();
  });

  test("returns null for a headless lane so anonymous lanes never merge", () => {
    // Two background lanes in one cwd are genuinely different seats; merging
    // them would cross-deliver their mail.
    expect(durableSeatKey({ tmux_session: null, tmux_pane_id: null, tty: null })).toBeNull();
    expect(durableSeatKey({})).toBeNull();
  });

  test("treats empty strings as absent", () => {
    // An empty SESSION is absent, but the pane still identifies the seat.
    expect(durableSeatKey({ tmux_session: "", tmux_pane_id: "%1", tty: "" })).toBe("pane:%1");
    // Everything empty really is no seat.
    expect(durableSeatKey({ tmux_session: "", tmux_pane_id: "", tty: "" })).toBeNull();
  });

  test("a pane with no session is still a pane seat", () => {
    // Real case: Cursor strips the env it gives MCP servers, so a cursor lane
    // recovers its pane from the client process but never its session name.
    // Demanding both dropped it to a tty: seat — excluded from pane-based merge and
    // addressable only by name/id. Pane ids are unique across the tmux server, so
    // the session prefix is descriptive, not identifying.
    expect(durableSeatKey({ tmux_pane_id: "%1126" })).toBe("pane:%1126");
    expect(durableSeatKey({ tmux_session: null, tmux_pane_id: "%1126", tty: "pts/51" })).toBe("pane:%1126");
  });

  test("a known session still produces the descriptive three-part key", () => {
    expect(durableSeatKey({ tmux_session: "infra", tmux_pane_id: "%312" })).toBe("pane:infra:%312");
  });

  test("matches the format activePeerKey advertises as a selector", () => {
    // send_to_peer accepts {seat_key}; the two producers must agree.
    expect(durableSeatKey({ tmux_session: "pr", tmux_pane_id: "%125" })).toBe("pane:pr:%125");
  });
});

describe("parseSeatPids", () => {
  test("round-trips a normal list", () => {
    expect(parseSeatPids(serializeSeatPids([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["malformed JSON", "{not json"],
    ["a JSON object", '{"pid":5}'],
    ["a bare number", "42"],
  ])("degrades to empty on %s rather than throwing", (_label, raw) => {
    expect(parseSeatPids(raw as string | null | undefined)).toEqual([]);
  });

  test("drops non-integer, negative, and duplicate members", () => {
    expect(parseSeatPids('[10,"x",-3,0,10,2.5,20]')).toEqual([10, 20]);
  });

  test("caps a hostile oversized list", () => {
    const huge = JSON.stringify(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(parseSeatPids(huge)).toHaveLength(MAX_SEAT_PIDS);
  });
});

describe("mergeSeatPids", () => {
  const alive = (live: number[]) => (pid: number) => live.includes(pid);

  test("puts the registrant first and keeps live predecessors", () => {
    expect(mergeSeatPids([100, 200], 300, alive([100, 200, 300]))).toEqual([300, 100, 200]);
  });

  test("drops dead predecessors so a seat cannot live on a ghost", () => {
    expect(mergeSeatPids([100, 200], 300, alive([200, 300]))).toEqual([300, 200]);
  });

  test("never duplicates the registrant already in the set", () => {
    expect(mergeSeatPids([300, 100], 300, alive([300, 100]))).toEqual([300, 100]);
  });

  test("bounds growth across many re-registrations", () => {
    let pids: number[] = [];
    for (let i = 1; i <= 50; i++) pids = mergeSeatPids(pids, i, () => true);
    expect(pids).toHaveLength(MAX_SEAT_PIDS);
    expect(pids[0]).toBe(50);
  });
});

describe("seatPidsAlive", () => {
  test("a seat is alive while ANY of its processes is", () => {
    // The Claude case: MCP server (dead, killed at compact) + TUI (alive).
    expect(seatPidsAlive([111, 222], 111, (pid) => pid === 222)).toBe(true);
  });

  test("a seat with every process gone is dead", () => {
    expect(seatPidsAlive([111, 222], 111, () => false)).toBe(false);
  });

  test("legacy rows with no recorded set fall back to the row pid", () => {
    expect(seatPidsAlive([], 999, (pid) => pid === 999)).toBe(true);
    expect(seatPidsAlive([], 999, () => false)).toBe(false);
  });
});

describe("seatKeyBackfillSql", () => {
  function seed(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE peers (
      id TEXT PRIMARY KEY, tmux_session TEXT, tmux_pane_id TEXT, tty TEXT, seat_key TEXT
    )`);
    return db;
  }

  test("derives the same keys durableSeatKey would", () => {
    const db = seed();
    const rows = [
      ["pane", "infra", "%1132", "pts/21", null],
      ["paneonly", null, "%1126", "pts/51", null],
      ["ttyonly", null, null, "pts/9", null],
      ["headless", null, null, null, null],
      ["emptystrings", "", "", "", null],
    ];
    for (const r of rows) db.run("INSERT INTO peers VALUES (?,?,?,?,?)", r as never);
    db.run(seatKeyBackfillSql());

    const got = Object.fromEntries(
      (db.query("SELECT id, seat_key FROM peers").all() as Array<{ id: string; seat_key: string | null }>)
        .map((r) => [r.id, r.seat_key]),
    );
    expect(got.pane).toBe("pane:infra:%1132");
    expect(got.ttyonly).toBe("tty:pts/9");
    // A pane with no session backfills as a pane seat, not a tty seat — the SQL and
    // durableSeatKey must agree, or a row means one thing to registration and
    // another to resolution.
    expect(got.paneonly).toBe("pane:%1126");
    expect(got.paneonly).toBe(durableSeatKey({ tmux_pane_id: "%1126", tty: "pts/51" }));
    expect(got.headless).toBeNull();
    expect(got.emptystrings).toBeNull();

    // The SQL and the TS must not drift apart.
    expect(got.pane).toBe(durableSeatKey({ tmux_session: "infra", tmux_pane_id: "%1132", tty: "pts/21" }));
    expect(got.ttyonly).toBe(durableSeatKey({ tty: "pts/9" }));
    db.close();
  });

  test("upgrades a stale tty: key to a pane: key, one direction only", () => {
    // Rows written before pane-only seats existed carry tty:pts/N even though they
    // have a pane, and would keep that weaker identity until the lane relaunched —
    // excluded from pane-based merge. Every live cursor lane was in that state.
    const db = seed();
    db.run("INSERT INTO peers VALUES ('stale',NULL,'%1126','pts/51','tty:pts/51')");
    db.run("INSERT INTO peers VALUES ('staleSess','infra','%312','pts/21','tty:pts/21')");
    db.run("INSERT INTO peers VALUES ('nopane',NULL,NULL,'pts/9','tty:pts/9')");
    db.run("INSERT INTO peers VALUES ('already','infra','%400','pts/1','pane:infra:%400')");
    db.run(seatKeyPaneUpgradeSql());

    const got = Object.fromEntries(
      (db.query("SELECT id, seat_key FROM peers").all() as Array<{ id: string; seat_key: string | null }>)
        .map((r) => [r.id, r.seat_key]),
    );
    expect(got.stale).toBe("pane:%1126");            // pane, no session
    expect(got.staleSess).toBe("pane:infra:%312");   // pane + session
    expect(got.nopane).toBe("tty:pts/9");            // no pane → untouched
    expect(got.already).toBe("pane:infra:%400");     // already a pane key → untouched

    // Idempotent: running it again changes nothing.
    db.run(seatKeyPaneUpgradeSql());
    const again = (db.query("SELECT seat_key FROM peers WHERE id='stale'").get() as { seat_key: string }).seat_key;
    expect(again).toBe("pane:%1126");
    db.close();
  });

  test("never overwrites a seat_key that is already set", () => {
    const db = seed();
    db.run("INSERT INTO peers VALUES ('x','infra','%1','pts/1','pane:pinned:%99')");
    db.run(seatKeyBackfillSql());
    expect((db.query("SELECT seat_key FROM peers WHERE id='x'").get() as { seat_key: string }).seat_key)
      .toBe("pane:pinned:%99");
    db.close();
  });
});
