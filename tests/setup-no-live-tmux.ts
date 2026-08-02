import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * Same class of escape, different variable — and this one deleted the operator's
 * peer hooks.
 *
 * The installer resolves its user-scope config from CLAUDE_CONFIG_DIR and only
 * falls back to $HOME when that is unset. Installer tests sandbox HOME to a temp
 * dir (30 call sites) but spawn with `...process.env`, so on any shell that sets
 * CLAUDE_CONFIG_DIR the child ignored the sandbox and resolved to the REAL config.
 * The scope transfer then removed peer hooks from it.
 *
 * Measured 2026-08-01, and it is the root cause of a full day of lost mail:
 * ~/.claude-b/settings.json lost SessionStart + Stop + UserPromptSubmit and every
 * account-B lane went deaf. Running the 4-file installer glob three times wrote
 * three backups of that live file within four seconds — one per run. It also made
 * the suite unreproducible between machines: a shell WITHOUT the variable measured
 * 27 pass / 0 fail on the same commit where a shell WITH it measured 16 / 11, and
 * two of us spent an afternoon each believing the other had mismeasured.
 *
 * Deleted here rather than at the 30 spawn sites: one place covers every existing
 * caller and every future one, which is the only version of this fix that stays
 * fixed. Tests that genuinely exercise the variable (e.g. "honors CLAUDE_CONFIG_DIR
 * for alternate user profiles") set it explicitly on the child they spawn, so they
 * are unaffected.
 */
delete process.env.CLAUDE_CONFIG_DIR;

/**
 * CLAUDE_PEER_NAME leaks the operator's seat label into every spawned server, so a
 * test registration can adopt the live lane's name and make it ambiguous to
 * send_to_peer {name}. Same shape as the TMUX_PANE wedge above; cheap to prevent.
 */
delete process.env.CLAUDE_PEER_NAME;

/**
 * INVOCATION_ID is systemd's ambient marker. The broker uses it as the default
 * owner-mode signal, so inheriting the operator's service context can make a
 * supposedly direct test broker claim to be systemd-owned. Tests that exercise
 * systemd set both owner mode and invocation identity explicitly on the child.
 */
delete process.env.INVOCATION_ID;

/**
 * Same escape, larger blast radius — latent today, so fixed before it fires.
 *
 * The broker resolves its database as `CLAUDE_PEERS_DB ?? $HOME/.claude-peers.db`
 * (broker.ts:87, shared/broker-service.ts:26) and its port as
 * `CLAUDE_PEERS_PORT ?? 7899`. Sandboxing HOME covers the fallback but NOT the
 * override: an ambient CLAUDE_PEERS_DB would send every test write into the real
 * message store, and an ambient CLAUDE_PEERS_PORT would point a spawned server at
 * the LIVE broker on 7899 — writing real peer rows and real messages.
 *
 * That is precisely how CLAUDE_CONFIG_DIR ate the operator's peer hooks: an
 * override the sandbox did not think to clear, defeating a HOME redirect that
 * looked airtight. Neither variable is set on this host right now, which is the
 * best moment to close it — the bug above was also latent until the day someone
 * ran the suite from a shell that happened to set the variable.
 *
 * tests/helpers/test-broker.ts already pins CLAUDE_PEERS_PORT="0" for its own
 * broker; this covers every OTHER spawner, including ones added later.
 */
// PORT is deleted (its fallback, 7899, is refused by the test broker which pins
// "0"); DB is REDIRECTED for the reason above — its fallback is a real home path.
delete process.env.CLAUDE_PEERS_PORT;

/**
 * Every remaining path override, because scrubbing "the important ones" is how
 * this bug keeps surviving.
 *
 * Adversarial review found the previous list incomplete and proved it: a full
 * suite run wrote /home/manzo/.claude-peers-autodrain.heartbeat — the operator's
 * live file — because the heartbeat path falls back to $HOME only when its
 * override is unset, and the override was never cleared. Same shape as
 * CLAUDE_CONFIG_DIR, third time in two days.
 *
 * The rule that generalises: ANY env var naming a writable target must be handled
 * here, not just the ones implicated in the last incident — and handled by
 * REDIRECTING it to a sandbox, never by deleting it. A HOME sandbox protects only
 * the fallback branch; an override defeats it, and deleting the override hands
 * control back to a fallback that may not honour $HOME at all.
 */
// ⚠ REDIRECT, do not delete. Deleting an override hands control to its fallback,
// and these fallbacks are the operator's real home — several resolve via
// homedir() (bin/codex-autodrain-poller.ts:79) which ignores $HOME entirely, so a
// HOME sandbox cannot save them. They are also module-level consts evaluated at
// IMPORT time, so the value must be in place before any test file imports.
//
// Deleting them is strictly worse than leaving them: it GUARANTEES the live path.
// Proven — after a delete-only scrub, one suite still recreated
// /home/manzo/.claude-peers-autodrain.heartbeat on every run.
const sandbox = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
process.env.CLAUDE_PEERS_DB = join(sandbox, "peers.db");
process.env.CLAUDE_PEERS_AUTODRAIN_HEARTBEAT = join(sandbox, "autodrain.heartbeat");
process.env.CLAUDE_PEERS_BROKER_LOG = join(sandbox, "broker.log");
process.env.CLAUDE_PEERS_BACKUP = join(sandbox, "backup");
process.env.CLAUDE_PEERS_BRIDGE_TOKEN_FILE = join(sandbox, "bridge-token");
