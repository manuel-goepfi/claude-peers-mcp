/**
 * An explicit seat name (@peer_seat_name) is always the routing name the label
 * allocator reports, and releasing it always takes it off the border.
 *
 * A border can show the seat name while the auto record (@operator_label_auto)
 * still holds the pane's birth ordinal: rename-lane used to write the border
 * before claiming, and panes renamed that way keep that state. Against such a
 * record the border reads as hand-set, which used to route the seat by its
 * ordinal (role.1 in session infra answered as infra.1) and kept the name on
 * the border after a release. Runs against a throwaway tmux server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTO_LABEL_OPTION,
  claimPaneSeatName,
  ensurePaneOperatorLabel,
  resolvePaneSeatName,
  type TmuxLabelRunner,
} from "../bin/tmux-label-pane.ts";

describe.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("explicit seat names on a scratch tmux server", () => {
  const root = mkdtempSync(join(tmpdir(), "seat-name-wins-"));
  const socket = join(root, "tmux");
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
  const run: TmuxLabelRunner = (args) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { env, stdout: "pipe", stderr: "ignore", timeout: 3000 });
    return { ok: result.exitCode === 0, out: new TextDecoder().decode(result.stdout) };
  };
  const tmux = (...args: string[]) => run(args).out.trim();
  const option = (pane: string, name: string) => tmux("show-options", "-p", "-t", pane, "-v", name);
  const newPane = () => {
    const before = new Set(tmux("list-panes", "-s", "-t", "infra", "-F", "#{pane_id}").split("\n"));
    tmux("split-window", "-d", "-t", "infra", "sleep", "120");
    tmux("select-layout", "-t", "infra", "tiled");
    return tmux("list-panes", "-s", "-t", "infra", "-F", "#{pane_id}").split("\n").find((id) => !before.has(id))!;
  };
  const label = (pane: string) => ensurePaneOperatorLabel(pane, run, socket);

  beforeAll(() => {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "infra", "-x", "250", "-y", "80", "sleep", "120");
  });

  afterAll(() => {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  test("a border showing the seat name against an older auto record routes by the seat name", () => {
    const pane = newPane();
    const birth = label(pane);
    expect(birth.status).toBe("labeled");
    const ordinal = "label" in birth ? birth.label : "";
    expect(ordinal).toMatch(/^infra\.[0-9]+$/);
    // The state the old rename-lane order left: border first, then the claim.
    tmux("set-option", "-p", "-t", pane, "@operator_label", "role.1");
    expect(claimPaneSeatName(pane, "role.1", run, socket).status).toBe("claimed");
    expect(option(pane, AUTO_LABEL_OPTION)).toBe(ordinal);

    expect(label(pane)).toEqual({ status: "preserved", label: "role.1" });

    // Releasing returns the border to the pane's own birth ordinal.
    expect(claimPaneSeatName(pane, "", run, socket).status).toBe("released");
    expect(option(pane, "@operator_label")).toBe(ordinal);
    expect(resolvePaneSeatName(pane, run, socket)).toEqual({ status: "preserved", label: ordinal });
  });

  test("a hand-set border that differs from the seat name stays, and the seat routes by its name", () => {
    const pane = newPane();
    label(pane);
    tmux("set-option", "-p", "-t", pane, "@operator_label", "my box");
    expect(claimPaneSeatName(pane, "role.2", run, socket).status).toBe("claimed");
    expect(label(pane)).toEqual({ status: "preserved", label: "my box", name: "role.2" });
    // Release leaves a border that never showed the name alone.
    expect(claimPaneSeatName(pane, "", run, socket).status).toBe("released");
    expect(option(pane, "@operator_label")).toBe("my box");
  });

  test("a claim through the allocator still moves the border and a release clears it", () => {
    const pane = newPane();
    label(pane);
    expect(claimPaneSeatName(pane, "role.3", run, socket).status).toBe("claimed");
    expect(option(pane, "@operator_label")).toBe("role.3");
    expect(claimPaneSeatName(pane, "", run, socket).status).toBe("released");
    expect(option(pane, "@operator_label")).toMatch(/^infra\.[0-9]+$/);
  });
});
