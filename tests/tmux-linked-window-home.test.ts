/**
 * A window linked into a second session must name one session on every path.
 *
 * With `link-window` a pane is in two ungrouped sessions. `list-panes -a`
 * lists it under both (and the ranking picks the older), while
 * `display-message -t %N` names whichever session tmux picks, here the newer
 * one. Registration, runtime proofs and the label allocator must all agree.
 * Runs against a throwaway tmux server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TMUX_PANES_FORMAT, parseTmuxPanes } from "../shared/tmux.ts";
import { HOME_SESSION_FIELDS, homeSessionName, parseSessionCandidate } from "../shared/tmux-home-session.ts";
import { runtimePaneRow, withRuntimePaneSnapshot } from "../shared/runtime-pane-snapshot.ts";
import { ensurePaneOperatorLabel, type TmuxLabelRunner } from "../bin/tmux-label-pane.ts";

describe.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("linked window on a scratch tmux server", () => {
  const root = mkdtempSync(join(tmpdir(), "linked-window-home-"));
  const socket = join(root, "tmux");
  const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return { ok: result.exitCode === 0, out: new TextDecoder().decode(result.stdout) };
  };
  const tmux = (args: string[]) => {
    const result = run(args);
    if (!result.ok) throw new Error(`tmux ${args.join(" ")} failed`);
    return result.out.trim();
  };
  const runner: TmuxLabelRunner = run;
  let pane = "";
  let panePid = 0;

  beforeAll(async () => {
    tmux(["-f", "/dev/null", "new-session", "-d", "-s", "work", "-x", "200", "-y", "50", "sleep", "120"]);
    // session_created has one-second resolution; make `scratch` strictly newer.
    await Bun.sleep(1100);
    tmux(["new-session", "-d", "-s", "scratch", "-x", "200", "-y", "50", "sleep", "120"]);
    tmux(["link-window", "-s", "work:0", "-t", "scratch:5"]);
    [pane, panePid] = tmux(["list-panes", "-t", "work", "-F", "#{pane_id}\t#{pane_pid}"]).split("\t") as [string, number];
    panePid = Number(panePid);
  });

  afterAll(() => {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  test("tmux itself disagrees: display-message names the newer session", () => {
    expect(tmux(["display-message", "-p", "-t", pane, "#{session_name}"])).toBe("scratch");
  });

  test("display-message and list-panes resolve the same home session", () => {
    const listed = parseTmuxPanes(tmux(["list-panes", "-a", "-F", TMUX_PANES_FORMAT])).get(panePid)?.session;
    const [displayedName, ...fields] = tmux(["display-message", "-p", "-t", pane, `#{session_name}\t${HOME_SESSION_FIELDS}`]).split("\t");
    const displayed = parseSessionCandidate(displayedName!, fields)!;
    const viaDisplay = homeSessionName(pane, displayed, (args) => { const r = run(args); return r.ok ? r.out : null; });
    expect(listed).toBe("work");
    expect(viaDisplay).toBe("work");
  });

  test("the runtime pane proof row names the home session", () => {
    const row = withRuntimePaneSnapshot(() => runtimePaneRow(socket, pane));
    expect(row?.split("\t")[4]).toBe("work");
  });

  test("the auto label is allocated in the home session", () => {
    const result = ensurePaneOperatorLabel(pane, runner, socket);
    expect(result.status === "labeled" || result.status === "preserved").toBe(true);
    expect("label" in result ? result.label : null).toBe("work.1");
  });
});
