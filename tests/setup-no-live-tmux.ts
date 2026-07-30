/**
 * Test preload: keep the suite off the operator's real tmux panes.
 *
 * A claude-peers server mirrors its identity onto its OWN pane, resolved from
 * TMUX_PANE. Tests spawn servers with `...process.env`, so they inherit whichever
 * pane the suite was launched from — and then write @peer_id / @peer_label /
 * @peer_resolved_name onto that live pane.
 *
 * That is not hypothetical. tests/lifecycle.test.ts serves a fixture identity
 * {id: "wedge-peer", name: "wedge"}; it landed on the operator's pane, whose
 * border format renders @peer_resolved_name. The seat displayed "wedge" for hours
 * while its real name was infra.2, and since the border is where the operator
 * reads a lane's routable name, the seat became unaddressable — `msg wedge`
 * matched nothing. Ten full-suite runs re-stamped it each time.
 *
 * Unsetting both here fixes every spawner at once, including ones added later:
 * TMUX_PANE so no pane is targeted, TMUX so no tmux client resolves at all.
 * Tests that need tmux behaviour inject their own readers/writers or set these
 * explicitly on the child they spawn.
 */
// The decisive one: the server resolves its pane from the PROCESS TREE, so a test
// server spawned from inside a live session finds the operator's pane even with a
// scrubbed environment. Only an explicit opt-out keeps it off.
process.env.CLAUDE_PEERS_TMUX_IDENTITY_MIRROR = "0";
delete process.env.TMUX_PANE;
delete process.env.TMUX;
