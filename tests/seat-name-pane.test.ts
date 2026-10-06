/**
 * Pane-level explicit seat names (@peer_seat_name).
 *
 * The pane carries the explicit name so it outlives broker restarts and is what
 * every registration and heartbeat re-reads. The auto label (@operator_label)
 * stays the allocator's business and is never confused with it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimPaneSeatName,
  readPaneSeatName,
  resolvePaneSeatName,
  type TmuxLabelRunner,
} from "../bin/tmux-label-pane.ts";
import {
  PANE_SEAT_FORMAT,
  cleanSeatName,
  effectiveSeatName,
  parsePaneSeatRows,
  seatNameHolder,
} from "../shared/seat-name.ts";

const row = (paneId: string, seat: string, label: string, command: string) =>
  [paneId, "Orch", `win-${paneId.slice(1)}`, seat, label, command].join("\t");

describe("seat-name helpers", () => {
  test("an explicit name outranks the auto label", () => {
    expect(effectiveSeatName("Orch.142", "Orch.140")).toBe("Orch.142");
    expect(effectiveSeatName(null, "Orch.140")).toBe("Orch.140");
    expect(effectiveSeatName("  ", "Orch.140")).toBe("Orch.140");
  });

  test("names with control characters or over 128 bytes are rejected", () => {
    expect(cleanSeatName("ok name")).toBe("ok name");
    expect(cleanSeatName("bad\nname")).toBeNull();
    expect(cleanSeatName("x".repeat(129))).toBeNull();
  });

  test("holders: explicit names always, auto labels only while an agent runs", () => {
    const rows = parsePaneSeatRows([
      row("%1", "Orch.135", "Orch.142", "claude"),   // explicit name; its auto label is irrelevant
      row("%2", "", "Orch.140", "claude"),           // live agent under its auto label
      row("%3", "", "Orch.141", "bash"),             // idle shell keeps a stale label
      row("%4", "", "", "claude"),
    ].join("\n"));
    expect(seatNameHolder(rows, "%9", "Orch.135")?.paneId).toBe("%1");
    expect(seatNameHolder(rows, "%9", "Orch.142")).toBeNull();
    expect(seatNameHolder(rows, "%9", "Orch.140")?.paneId).toBe("%2");
    expect(seatNameHolder(rows, "%9", "Orch.141")).toBeNull();
    // A pane never collides with itself (a relaunch re-claims its own name).
    expect(seatNameHolder(rows, "%1", "Orch.135")).toBeNull();
  });
});

describe("claimPaneSeatName with a fake runner", () => {
  function fakeTmux(rows: string[]): { run: TmuxLabelRunner; options: Map<string, string> } {
    const options = new Map<string, string>();
    const run: TmuxLabelRunner = (args) => {
      if (args[0] === "list-panes" && args.includes(PANE_SEAT_FORMAT)) {
        return { ok: true, out: rows.map((line) => {
          const fields = line.split("\t");
          const own = options.get(fields[0]!);
          if (own !== undefined) fields[3] = own;
          return fields.join("\t");
        }).join("\n") };
      }
      if (args[0] === "set-option") {
        const pane = args[args.indexOf("-t") + 1]!;
        if (args.includes("-u")) options.delete(pane);
        else options.set(pane, args.at(-1)!);
        return { ok: true, out: "" };
      }
      if (args[0] === "show-options") {
        const pane = args[args.indexOf("-t") + 1]!;
        return options.has(pane) ? { ok: true, out: `${options.get(pane)}\n` } : { ok: false, out: "" };
      }
      return { ok: false, out: "" };
    };
    return { run, options };
  }

  test("planted collision: a claim onto a running agent's auto label is refused with the holder", () => {
    const { run, options } = fakeTmux([row("%10", "", "Orch.142", "claude"), row("%11", "", "Orch.140", "bash")]);
    const result = claimPaneSeatName("%11", "Orch.142", run);
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.holder).toContain("pane %10");
    expect(options.has("%11")).toBe(false);
  });

  test("a free name is stamped and read back; the auto label is untouched", () => {
    const { run } = fakeTmux([row("%10", "", "Orch.142", "claude"), row("%11", "", "Orch.140", "bash")]);
    expect(claimPaneSeatName("%11", "Orch.135", run)).toEqual({ status: "claimed", name: "Orch.135" });
    expect(readPaneSeatName("%11", run)).toBe("Orch.135");
    expect(resolvePaneSeatName("%11", run)).toEqual({ status: "preserved", label: "Orch.135" });
  });

  test("an empty claim releases the pane back to its auto label", () => {
    const { run } = fakeTmux([row("%11", "", "Orch.140", "bash")]);
    claimPaneSeatName("%11", "Orch.135", run);
    expect(claimPaneSeatName("%11", "", run)).toEqual({ status: "released" });
    expect(readPaneSeatName("%11", run)).toBeNull();
  });

  test("invalid names and vanished panes fail closed", () => {
    const { run } = fakeTmux([row("%11", "", "Orch.140", "bash")]);
    expect(claimPaneSeatName("%11", "bad\nname", run)).toEqual({ status: "failed", reason: "invalid-seat-name" });
    expect(claimPaneSeatName("%99", "Orch.135", run)).toEqual({ status: "failed", reason: "pane-gone" });
  });
});

test.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("CLI on a scratch tmux server: claim, refuse with holder, print-seat", () => {
  const root = mkdtempSync(join(tmpdir(), "seat-name-cli-")), socket = join(root, "tmux");
  const tool = new URL("../bin/tmux-label-pane.ts", import.meta.url).pathname;
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, CLAUDE_PEERS_TMUX_SOCKET: socket };
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, tool, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
  };
  try {
    // Two panes running a non-shell command stand in for two live agent seats.
    tmux(["-f", "/dev/null", "new-session", "-d", "-s", "Orch", "-x", "200", "-y", "50", "sleep", "120"]);
    tmux(["split-window", "-d", "-t", "Orch", "sleep", "120"]);
    const [first, second] = tmux(["list-panes", "-s", "-t", "Orch", "-F", "#{pane_id}"]).split("\n") as [string, string];
    expect(cli("--print", first).out).toBe("Orch.1");
    expect(cli("--print", second).out).toBe("Orch.2");

    // The second seat's role is Orch.1, which the first pane auto-holds.
    const refused = cli("--claim-seat-name", second, "Orch.1");
    expect(refused.code).toBe(3);
    expect(refused.err).toContain(`pane ${first}`);
    expect(cli("--print-seat", second).out).toBe("Orch.2");

    // Rename the holder first, then the claim succeeds.
    expect(cli("--claim-seat-name", first, "Orch.7").code).toBe(0);
    const claimed = cli("--claim-seat-name", second, "Orch.1");
    expect(claimed.code).toBe(0);
    expect(claimed.out).toBe("Orch.1");
    expect(cli("--print-seat", second).out).toBe("Orch.1");
    expect(cli("--print-seat", first).out).toBe("Orch.7");
    // The auto labels are unchanged; only the explicit layer moved.
    expect(cli("--print", second).out).toBe("Orch.2");
    expect(tmux(["show-options", "-p", "-t", second, "-v", "@peer_seat_name"])).toBe("Orch.1");

    // Release returns print-seat to the auto label.
    expect(cli("--claim-seat-name", second, "").code).toBe(0);
    expect(cli("--print-seat", second).out).toBe("Orch.2");

    // The auto-labeller never hands out a role name a pane claimed explicitly:
    // with Orch.3 claimed, a new pane must not become Orch.3 (it allocates above
    // every taken ordinal, explicit names included).
    expect(cli("--claim-seat-name", second, "Orch.3").code).toBe(0);
    tmux(["split-window", "-d", "-t", "Orch", "sleep", "120"]);
    const third = tmux(["list-panes", "-s", "-t", "Orch", "-F", "#{pane_id}"]).split("\n").find((id) => id !== first && id !== second)!;
    expect(cli("--print", third).out).toBe("Orch.8");
  } finally {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
