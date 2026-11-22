import { describe, expect, test } from "bun:test";
import { parseTmuxPanes } from "../shared/tmux.ts";
import { runtimePaneRow, withRuntimePaneSnapshot } from "../shared/runtime-pane-snapshot.ts";
import { ensurePaneOperatorLabel, labelAllUnlabeledPanes, type TmuxLabelRunner } from "../bin/tmux-label-pane.ts";

// A viewer attaches through `new-session -t work -s viewer-3-abc` with
// destroy-unattached set. Both sessions hold the same window, so tmux lists
// every pane of it twice, and the viewer sorts last.
//   session fields: id, grouped, group, created, destroy-unattached
const WORK = ["$0", "1", "work", "1700000000", "off"];
const VIEWER = ["$4", "1", "work", "1700000500", "on"];
const PLAIN = ["$1", "0", "", "1700000100", "off"];

function paneLine(pid: number, session: string, fields: string[], paneId: string): string {
  return [String(pid), session, "1", "lane", "2", paneId, "3", ...fields].join("\t");
}

describe("pane ancestry map picks the home session of a grouped window", () => {
  test("a viewer group resolves to the original session", () => {
    const out = [
      paneLine(100, "work", WORK, "%3"),
      paneLine(200, "plain", PLAIN, "%7"),
      paneLine(100, "viewer-3-abc", VIEWER, "%3"),
    ].join("\n");
    const panes = parseTmuxPanes(out);
    expect(panes.get(100)?.session).toBe("work");
    expect(panes.get(100)?.pane_id).toBe("%3");
  });

  test("a pane in one ungrouped session is unchanged", () => {
    const panes = parseTmuxPanes(paneLine(200, "plain", PLAIN, "%7"));
    expect(panes.get(200)).toEqual({
      session: "plain", window_index: "1", window_name: "lane", pane_index: "2", pane_id: "%7", window_panes: 3,
    });
  });

  test("a group of two real sessions resolves to the session named after the group", () => {
    // `team` was created from `work`, is older by clock skew, and has no
    // destroy-unattached: the group name still identifies the original.
    const team = ["$2", "1", "work", "1699999000", "off"];
    const out = [paneLine(100, "work", WORK, "%3"), paneLine(100, "team", team, "%3")].join("\n");
    expect(parseTmuxPanes(out).get(100)?.session).toBe("work");
  });

  test("legacy 7-field output keeps its existing behaviour", () => {
    const out = "100\twork\t1\tlane\t2\t%3\t3";
    expect(parseTmuxPanes(out).get(100)?.session).toBe("work");
  });
});

describe("runtime pane proof rows pick the home session", () => {
  test("the proof row names the original session and keeps its 5-field shape", () => {
    const read = () => [
      ["900", "100", "%3", "$0", "work", ...WORK.slice(1)].join("\t"),
      ["900", "100", "%3", "$4", "viewer-3-abc", ...VIEWER.slice(1)].join("\t"),
    ].join("\n");
    const row = withRuntimePaneSnapshot(() => runtimePaneRow("/tmp/sock-grouped-test", "%3", read));
    expect(row?.split("\t")).toEqual(["900", "100", "%3", "$0", "work"]);
  });
});

describe("auto labels use the home session, not the viewer", () => {
  function groupedTmux() {
    const calls: string[][] = [];
    const run: TmuxLabelRunner = (args) => {
      calls.push(args);
      // display-message resolves %3 through the attached viewer session.
      if (args[0] === "display-message" && args.at(-1)!.includes("#{socket_path}")) {
        return { ok: true, out: "/tmp/sock\t900\t$4\n" };
      }
      if (args[0] === "display-message") {
        return { ok: true, out: ["%3", "viewer-3-abc", "1", "lane", "2", "", "", "", "", ...VIEWER].join("\t") + "\n" };
      }
      if (args[0] === "list-panes") {
        const format = args.at(-1)!;
        if (format === "#{pane_id}") return { ok: true, out: "%3\n%5\n" };
        if (format.startsWith("#{pane_id}\t#{session_name}\t#{session_id}")) {
          return { ok: true, out: [
            ["%3", "work", ...WORK].join("\t"),
            ["%5", "work", ...WORK].join("\t"),
            ["%3", "viewer-3-abc", ...VIEWER].join("\t"),
            ["%5", "viewer-3-abc", ...VIEWER].join("\t"),
          ].join("\n") };
        }
        if (format.startsWith("#{pane_id}\t#{session_name}\t#{pane_index}")) {
          // Bulk snapshot of the viewer session (`list-panes -s -t $4`).
          return { ok: true, out: [
            ["%5", "viewer-3-abc", "1", "lane", "2", "work.1", "", "", "work.1", ...VIEWER].join("\t"),
            ["%3", "viewer-3-abc", "2", "lane", "2", "", "", "", "", ...VIEWER].join("\t"),
          ].join("\n") };
        }
        // Sibling labels of the window's panes.
        return { ok: true, out: "%5\twork.1\t\t\twork.1\n%3\t\t\t\t\n" };
      }
      if (args[0] === "set-option") return { ok: true, out: "" };
      return { ok: false, out: "" };
    };
    return { run, calls };
  }

  test("a pane seen through a viewer session is labelled <home>.<n>", () => {
    const tmux = groupedTmux();
    expect(ensurePaneOperatorLabel("%3", tmux.run)).toEqual({ status: "labeled", label: "work.2" });
    expect(tmux.calls).toContainEqual(["set-option", "-p", "-t", "%3", "@operator_label", "work.2"]);
    expect(tmux.calls.flat().some((arg) => arg.includes("viewer-3-abc"))).toBe(false);
  });

  test("an auto label already written under the viewer session is repaired", () => {
    const tmux = groupedTmux();
    const base = tmux.run;
    const run: TmuxLabelRunner = (args) => args[0] === "display-message" && !args.at(-1)!.includes("#{socket_path}")
      ? { ok: true, out: ["%3", "viewer-3-abc", "2", "lane", "2", "viewer-3-abc.2", "", "", "viewer-3-abc.2", ...VIEWER].join("\t") }
      : base(args);
    expect(ensurePaneOperatorLabel("%3", run)).toEqual({ status: "labeled", label: "work.2" });
  });

  test("a hand-set border is kept through a viewer session; its routing ordinal uses the home session", () => {
    const tmux = groupedTmux();
    const base = tmux.run;
    const run: TmuxLabelRunner = (args) => args[0] === "display-message" && !args.at(-1)!.includes("#{socket_path}")
      ? { ok: true, out: ["%3", "viewer-3-abc", "2", "lane", "2", "orchestrator", "", "orchestrator", "", ...VIEWER].join("\t") }
      : base(args);
    expect(ensurePaneOperatorLabel("%3", run)).toEqual({ status: "preserved", label: "orchestrator", name: "work.2" });
    expect(tmux.calls.flat().some((arg) => arg.includes("viewer-3-abc"))).toBe(false);
  });

  test("labelling a viewer session's panes writes home-session labels only", () => {
    const tmux = groupedTmux();
    labelAllUnlabeledPanes(tmux.run, "$4");
    const labels = tmux.calls.filter((args) => args[0] === "set-option" && args[4] === "@operator_label").map((args) => args[5]);
    expect(labels).toEqual(["work.2"]);
  });
});
