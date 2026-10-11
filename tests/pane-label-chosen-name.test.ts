/**
 * The top pane border (@operator_label) shows the seat's chosen name.
 *
 * Live defect, 2026-10-11: the allocator coerced every `<x>.<n>` label onto the
 * pane's session, so a border the launch clerk set to `broker.29` in session
 * `infra` was rewritten to `infra.29` on registration, and a coordinator seat
 * named `C5 Orch.294` kept showing its birth counter `C5 Orch.307`. A label set
 * by hand is now final, and the allocator's own labels follow the explicit seat
 * name, falling back to the session counter only without one.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTO_LABEL_OPTION,
  claimPaneSeatName,
  ensurePaneOperatorLabel,
  labelAllUnlabeledPanes,
  resolvePaneSeatName,
  type TmuxLabelRunner,
} from "../bin/tmux-label-pane.ts";

interface FakePane {
  session: string;
  window: string;
  command?: string;
  options?: Record<string, string>;
}

function fakeTmux(panes: Record<string, FakePane>) {
  const state = new Map(Object.entries(panes).map(([id, pane]) => [id, {
    ...pane,
    options: new Map(Object.entries(pane.options ?? {})),
  }]));
  const writes: string[][] = [];
  const render = (id: string, format: string) => {
    const pane = state.get(id)!;
    return format.replace(/#\{([^}]+)\}/g, (_, key: string) => {
      if (key.startsWith("@")) return pane.options.get(key) ?? "";
      switch (key) {
        case "pane_id": return id;
        case "session_name": return pane.session;
        case "pane_index": return "1";
        case "window_name": return pane.window;
        case "window_panes": return "1";
        case "pane_current_command": return pane.command ?? "claude";
        default: return "";
      }
    });
  };
  const run: TmuxLabelRunner = (args) => {
    const target = args.includes("-t") ? args[args.indexOf("-t") + 1]! : null;
    switch (args[0]) {
      case "display-message":
        return state.has(target!) ? { ok: true, out: `${render(target!, args.at(-1)!)}\n` } : { ok: false, out: "" };
      case "list-panes": {
        const ids = [...state.keys()].filter((id) => !args.includes("-s") || state.get(id)!.session === target);
        return { ok: true, out: ids.map((id) => render(id, args.at(-1)!)).join("\n") };
      }
      case "show-options": {
        const value = state.get(target!)?.options.get(args.at(-1)!);
        return value === undefined ? { ok: false, out: "" } : { ok: true, out: `${value}\n` };
      }
      case "set-option": {
        const pane = state.get(target!);
        if (!pane) return { ok: false, out: "" };
        writes.push(args);
        if (args.includes("-u")) pane.options.delete(args.at(-1)!);
        else pane.options.set(args.at(-2)!, args.at(-1)!);
        return { ok: true, out: "" };
      }
      default:
        return { ok: false, out: "" };
    }
  };
  const option = (id: string, name: string) => state.get(id)!.options.get(name);
  return { run, writes, option };
}

describe("a hand-set border label is final", () => {
  test("registration keeps broker.29 in session infra instead of coercing it to infra.29", () => {
    const tmux = fakeTmux({
      "%22036": { session: "infra", window: "broker.29", options: {
        "@operator_label": "broker.29", "@peer_label": "infra.29", "@peer_seat_name": "infra.29",
      } },
    });
    expect(ensurePaneOperatorLabel("%22036", tmux.run)).toEqual({ status: "preserved", label: "broker.29", name: "infra.29" });
    expect(tmux.writes).toEqual([]);
  });

  test("a non-ordinal label such as REVIEW-1996 is not replaced by a counter", () => {
    const tmux = fakeTmux({
      "%5": { session: "C5_lanes", window: "claude", options: { "@operator_label": "REVIEW-1996" } },
    });
    expect(ensurePaneOperatorLabel("%5", tmux.run)).toEqual({ status: "preserved", label: "REVIEW-1996" });
    expect(tmux.writes).toEqual([]);
  });

  test("a label changed by hand after the allocator wrote it is kept", () => {
    const tmux = fakeTmux({
      "%7": { session: "C5 Orch", window: "coordinator.294", options: {
        "@operator_label": "coordinator.294", [AUTO_LABEL_OPTION]: "C5 Orch.307", "@peer_seat_name": "C5 Orch.294",
      } },
    });
    expect(ensurePaneOperatorLabel("%7", tmux.run)).toEqual({ status: "preserved", label: "coordinator.294", name: "C5 Orch.294" });
    expect(tmux.writes).toEqual([]);
  });

  test("the bulk backfill leaves hand-set labels alone", () => {
    const tmux = fakeTmux({
      "%1": { session: "infra", window: "broker.29", options: { "@operator_label": "broker.29" } },
      "%2": { session: "infra", window: "disk", options: { "@operator_label": "REVIEW-7" } },
    });
    expect(labelAllUnlabeledPanes(tmux.run)).toEqual({ visited: 2, labeled: 0, failed: 0 });
    expect(tmux.writes).toEqual([]);
  });
});

describe("an allocator label follows the seat's chosen name", () => {
  test("the coordinator's birth counter gives way to its seat name", () => {
    const tmux = fakeTmux({
      "%7": { session: "C5 Orch", window: "claude", options: {
        "@operator_label": "C5 Orch.307", [AUTO_LABEL_OPTION]: "C5 Orch.307", "@peer_seat_name": "C5 Orch.294",
      } },
    });
    expect(ensurePaneOperatorLabel("%7", tmux.run)).toEqual({ status: "labeled", label: "C5 Orch.294" });
    expect(tmux.option("%7", "@operator_label")).toBe("C5 Orch.294");
    expect(tmux.option("%7", AUTO_LABEL_OPTION)).toBe("C5 Orch.294");
  });

  test("a legacy counter label with no record also gives way to the seat name", () => {
    const tmux = fakeTmux({
      "%7": { session: "C5 Orch", window: "claude", options: {
        "@operator_label": "C5 Orch.307", "@peer_seat_name": "C5 Orch.294",
      } },
    });
    expect(ensurePaneOperatorLabel("%7", tmux.run)).toEqual({ status: "labeled", label: "C5 Orch.294" });
  });

  test("set_name moves an allocator label to the new seat name", () => {
    const tmux = fakeTmux({
      "%9": { session: "infra", window: "claude", options: {
        "@operator_label": "infra.30", [AUTO_LABEL_OPTION]: "infra.30",
      } },
    });
    const claim = claimPaneSeatName("%9", "infra.29", tmux.run);
    expect(claim).toEqual({ status: "claimed", name: "infra.29", label: { status: "labeled", label: "infra.29" } });
    expect(tmux.option("%9", "@operator_label")).toBe("infra.29");
  });

  test("releasing the seat name gives the name up on the border too", () => {
    const tmux = fakeTmux({
      "%1": { session: "C5 Orch", window: "claude", options: { "@operator_label": "C5 Orch.300" } },
      "%7": { session: "C5 Orch", window: "claude", options: {
        "@operator_label": "C5 Orch.294", [AUTO_LABEL_OPTION]: "C5 Orch.294",
        "@peer_label": "C5 Orch.294", "@peer_seat_name": "C5 Orch.294",
      } },
    });
    const claim = claimPaneSeatName("%7", "", tmux.run);
    expect(claim).toEqual({ status: "released", label: { status: "labeled", label: "C5 Orch.301" } });
    expect(tmux.option("%7", "@operator_label")).toBe("C5 Orch.301");
  });

  test("set_name does not override a hand-set label", () => {
    const tmux = fakeTmux({
      "%9": { session: "infra", window: "broker.29", options: { "@operator_label": "broker.29" } },
    });
    const claim = claimPaneSeatName("%9", "infra.29", tmux.run);
    expect(claim).toEqual({ status: "claimed", name: "infra.29", label: { status: "preserved", label: "broker.29", name: "infra.29" } });
    expect(tmux.option("%9", "@operator_label")).toBe("broker.29");
  });
});

describe("routing names stay stable", () => {
  test("a hand-repaired border never renames a seat that has no explicit name", () => {
    const tmux = fakeTmux({
      "%3": { session: "infra", window: "disk.23", options: { "@operator_label": "disk.23" } },
      "%4": { session: "infra", window: "REVIEW-7", options: { "@operator_label": "REVIEW-7" } },
    });
    expect(resolvePaneSeatName("%3", tmux.run)).toEqual({ status: "preserved", label: "infra.23" });
    expect(resolvePaneSeatName("%4", tmux.run)).toEqual({ status: "preserved", label: "REVIEW-7" });
    expect(tmux.option("%3", "@operator_label")).toBe("disk.23");
  });

  test("a window named on purpose does not replace the ordinal of a seat with no explicit name", () => {
    const tmux = fakeTmux({ "%9": { session: "C5_lanes", window: "lane-88" } });
    expect(ensurePaneOperatorLabel("%9", tmux.run)).toEqual({ status: "labeled", label: "C5_lanes.1" });
  });

  test("machine fallback labels are still repaired, not kept as hand-set", () => {
    for (const label of ["infra.%24", "claude", "42"]) {
      const tmux = fakeTmux({ "%9": { session: "infra", window: "bash", options: { "@operator_label": label } } });
      expect(ensurePaneOperatorLabel("%9", tmux.run)).toEqual({ status: "labeled", label: "infra.1" });
    }
  });

  test("an older-session ordinal still follows a session rename", () => {
    const tmux = fakeTmux({ "%9": { session: "C5 Marketing", window: "bash", options: { "@operator_label": "marketing.4" } } });
    expect(ensurePaneOperatorLabel("%9", tmux.run)).toEqual({ status: "labeled", label: "C5 Marketing.4" });
  });
});
