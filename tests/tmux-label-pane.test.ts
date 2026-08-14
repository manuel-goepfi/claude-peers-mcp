import { describe, expect, test } from "bun:test";
import {
  ensurePaneOperatorLabel,
  labelAllUnlabeledPanes,
  type TmuxLabelRunner,
} from "../bin/tmux-label-pane.ts";

function fakeTmux(options: {
  snapshot: string;
  siblings?: string;
  allPanes?: string;
  setSucceeds?: boolean;
}) {
  const calls: string[][] = [];
  const run: TmuxLabelRunner = (args) => {
    calls.push(args);
    if (args[0] === "display-message") return { ok: true, out: options.snapshot };
    if (args[0] === "list-panes" && args.includes("#{pane_id}")) {
      return { ok: true, out: options.allPanes ?? "%3728\n" };
    }
    if (args[0] === "list-panes") return { ok: true, out: options.siblings ?? "" };
    if (args[0] === "set-option") return { ok: options.setSucceeds !== false, out: "" };
    return { ok: false, out: "" };
  };
  return { run, calls };
}

describe("tmux birth-time operator labels", () => {
  test("the live infra:1.4 shape becomes infra.5, not pane-index infra.4", () => {
    const tmux = fakeTmux({
      snapshot: "%3728\tinfra\t4\tgrok\t5\t\t\n",
      siblings: [
        "%3292\tinfra.1\tinfra.1",
        "%3337\tinfra.2\tinfra.2",
        "%3604\tinfra.3\tinfra.3",
        "%3659\tinfra.4\tinfra.4",
        "%3728\t\t",
      ].join("\n"),
    });

    expect(ensurePaneOperatorLabel("%3728", tmux.run)).toEqual({ status: "labeled", label: "infra.5" });
    expect(tmux.calls).toContainEqual(["set-option", "-p", "-t", "%3728", "@operator_label", "infra.5"]);
    expect(tmux.calls.flat()).not.toContain("@peer_label");
    expect(tmux.calls.flat()).not.toContain("@peer_resolved_name");
  });

  test("an existing operator label is sticky and performs no write", () => {
    const tmux = fakeTmux({ snapshot: "%9\tinfra\t1\tgrok\t2\tinfra.7\tinfra.7\n" });
    expect(ensurePaneOperatorLabel("%9", tmux.run)).toEqual({ status: "preserved", label: "infra.7" });
    expect(tmux.calls.some((args) => args[0] === "set-option")).toBe(false);
  });

  test("a recognized legacy peer label is promoted only into @operator_label", () => {
    const tmux = fakeTmux({ snapshot: "%9\tinfra\t1\tgrok\t2\t\tinfra.4#2\n" });
    expect(ensurePaneOperatorLabel("%9", tmux.run)).toEqual({ status: "labeled", label: "infra.4" });
    expect(tmux.calls).toContainEqual(["set-option", "-p", "-t", "%9", "@operator_label", "infra.4"]);
  });

  test("a deliberate one-pane window name is donated while generic grok is not", () => {
    const named = fakeTmux({ snapshot: "%10\treview\t0\tREVIEW-1996\t1\t\t\n" });
    expect(ensurePaneOperatorLabel("%10", named.run)).toEqual({ status: "labeled", label: "REVIEW-1996" });

    const generic = fakeTmux({ snapshot: "%11\tinfra\t4\tgrok\t1\t\t\n" });
    expect(ensurePaneOperatorLabel("%11", generic.run)).toEqual({ status: "labeled", label: "infra.1" });
  });

  test("install-time backfill visits every pane but preserves already-stamped panes", () => {
    const calls: string[][] = [];
    const run: TmuxLabelRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-panes" && args.includes("#{pane_id}")) return { ok: true, out: "%1\n%2\n" };
      if (args[0] === "display-message" && args.includes("%1")) {
        return { ok: true, out: "%1\tinfra\t1\tgrok\t2\tinfra.1\tinfra.1\n" };
      }
      if (args[0] === "display-message") return { ok: true, out: "%2\tinfra\t2\tgrok\t2\t\t\n" };
      if (args[0] === "list-panes") return { ok: true, out: "%1\tinfra.1\tinfra.1\n%2\t\t\n" };
      if (args[0] === "set-option") return { ok: true, out: "" };
      return { ok: false, out: "" };
    };

    expect(labelAllUnlabeledPanes(run)).toEqual({ visited: 2, labeled: 1, failed: 0 });
    expect(calls.filter((args) => args[0] === "set-option")).toEqual([
      ["set-option", "-p", "-t", "%2", "@operator_label", "infra.2"],
    ]);
  });
});
