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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("hand-set borders survive repeated heartbeat passes through the real locked allocator", () => {
  // Live repro 2026-10-11: %22336 set to source.295 was back to `C5 Orch.295`
  // within minutes, and a fresh pane relabelled closeclerk.296 showed
  // `C5 Orch.296` again. Every heartbeat runs this allocator through its lock.
  const root = mkdtempSync(join(tmpdir(), "pane-label-heartbeat-")), socket = join(root, "tmux");
  const tool = new URL("../bin/tmux-label-pane.ts", import.meta.url).pathname;
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, CLAUDE_PEERS_TMUX_SOCKET: socket };
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, tool, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const border = (pane: string) => tmux(["show-options", "-p", "-t", pane, "-v", "@operator_label"]);
  try {
    tmux(["-f", "/dev/null", "new-session", "-d", "-s", "Orch", "-n", "lead", "-x", "200", "-y", "50", "sleep", "120"]);
    const lead = tmux(["display-message", "-p", "-t", "Orch:lead", "#{pane_id}"]);
    // A pane from before the deploy: no allocator record, repaired to its window name.
    const legacy = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "Orch", "-n", "source.295", "sleep", "120"]);
    tmux(["set-option", "-p", "-t", legacy, "@operator_label", "source.295"]);
    // A pane born under the allocator (record stamped), then relabelled by hand.
    const born = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "Orch", "sleep", "120"]);
    cli("--print", lead);
    expect(cli("--print", born)).toMatch(/^Orch\.[0-9]+$/);
    tmux(["set-option", "-p", "-t", born, "@operator_label", "closeclerk.296"]);
    // A seat that claimed its name: the border shows the name, not its counter.
    expect(cli("--claim-seat-name", lead, "Orch.294")).toBe("Orch.294");
    for (let tick = 0; tick < 5; tick++) {
      for (const pane of [lead, legacy, born]) cli("--print", pane);
      cli("--all");
      expect([border(lead), border(legacy), border(born)]).toEqual(["Orch.294", "source.295", "closeclerk.296"]);
    }
    // The seats still answer to their routing names, not the repaired borders.
    expect(cli("--print-seat", legacy)).toBe("Orch.295");
    expect(cli("--print-seat", lead)).toBe("Orch.294");
  } finally {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
