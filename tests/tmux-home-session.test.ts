import { describe, expect, test } from "bun:test";
import {
  chooseHomeSession,
  homeSessionName,
  mayBeForeignSession,
  parseSessionCandidate,
  resolvePaneHomeSession,
  type SessionCandidate,
} from "../shared/tmux-home-session.ts";

function session(name: string, id: string, grouped: string, group: string, created: string, destroy: string): SessionCandidate {
  return parseSessionCandidate(name, [id, grouped, group, created, destroy])!;
}

const work = session("work", "$0", "1", "work", "1700000000", "off");
const viewer = session("viewer-3-abc", "$4", "1", "work", "1700000500", "on");

describe("chooseHomeSession", () => {
  test("a viewer group picks the original session, in either order", () => {
    expect(chooseHomeSession([work, viewer])?.name).toBe("work");
    expect(chooseHomeSession([viewer, work])?.name).toBe("work");
  });

  test("a pane in one ungrouped session keeps it", () => {
    const plain = session("plain", "$1", "0", "", "1700000100", "off");
    expect(chooseHomeSession([plain])).toEqual(plain);
    expect(mayBeForeignSession(plain)).toBe(false);
  });

  test("a group of two real sessions picks the one named after the group", () => {
    const team = session("team", "$2", "1", "work", "1699999000", "off");
    expect(chooseHomeSession([team, work])?.name).toBe("work");
  });

  test("a renamed original (no session matches the group) falls back to the oldest non-viewer", () => {
    const renamed = session("renamed", "$0", "1", "work", "1700000000", "off");
    const later = session("later", "$6", "1", "work", "1700000900", "off");
    expect(chooseHomeSession([viewer, later, renamed])?.name).toBe("renamed");
  });

  test("equal creation times fall back to the lower session id", () => {
    const a = session("a", "$7", "1", "gone", "1700000000", "off");
    const b = session("b", "$3", "1", "gone", "1700000000", "off");
    expect(chooseHomeSession([a, b])?.name).toBe("b");
  });

  test("a viewer is still chosen when it is the only session", () => {
    expect(chooseHomeSession([viewer])?.name).toBe("viewer-3-abc");
    expect(chooseHomeSession([])).toBeNull();
  });

  test("keep-last and keep-group count as destroy-unattached", () => {
    expect(session("v", "$9", "1", "work", "1", "keep-group").viewer).toBe(true);
    expect(session("v", "$9", "1", "work", "1", "keep-last").viewer).toBe(true);
  });

  test("short field lists never rank", () => {
    expect(parseSessionCandidate("work", ["$0", "1", "work"])).toBeNull();
  });
});

describe("resolvePaneHomeSession and homeSessionName", () => {
  const rows = [
    "%3\twork\t$0\t1\twork\t1700000000\toff",
    "%3\tviewer-3-abc\t$4\t1\twork\t1700000500\ton",
    "%7\tplain\t$1\t0\t\t1700000100\toff",
  ].join("\n");

  test("reads every session of the pane and picks its home", () => {
    expect(resolvePaneHomeSession("%3", () => rows)?.name).toBe("work");
    expect(resolvePaneHomeSession("%7", () => rows)?.name).toBe("plain");
    expect(resolvePaneHomeSession("%9", () => rows)).toBeNull();
    expect(resolvePaneHomeSession("%3", () => null)).toBeNull();
  });

  test("a displayed original or ungrouped session needs no second read", () => {
    const run = () => { throw new Error("unexpected tmux read"); };
    expect(homeSessionName("%3", work, run)).toBe("work");
  });

  test("a displayed viewer maps to the home session, or stays when tmux fails", () => {
    expect(homeSessionName("%3", viewer, () => rows)).toBe("work");
    expect(homeSessionName("%3", viewer, () => null)).toBe("viewer-3-abc");
  });
});
