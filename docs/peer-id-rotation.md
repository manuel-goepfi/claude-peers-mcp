# Peer IDs rotate, and the protection against it cannot survive an MCP reconnect

Measured 2026-08-07 by infra.3.

## The claim

A peer's broker id is not stable. It changes on MCP-server reconnect, silently,
without changing the seat. Any id written into prose — a kickoff document, a
handover note, a message body, a summary — goes stale with no notification and no
error until someone tries to use it.

## Evidence

A long-running Claude lane that had not restarted all week:

```
before   d4y7xpxd
after    xhuvvo1g
seat     pane:infra:%3035   (unchanged)
drift    none
```

`SELECT COUNT(*) FROM peers WHERE id='d4y7xpxd'` returns **0**. The old row is
deleted, not superseded. 73 messages still reference it — 27 sent, 46 received.

Other observations the same week:

| lane | ids burned | note |
|---|---|---|
| infra.9 | 12 in one session | every reply came from a different id |
| e2e-luna-active | 3 in ~2h | `9loyt7uk` -> `1rhbw2n7` -> stale |
| infra.3 (this lane) | 2 | no restart, no seat change |
| `wkjhc33t` | — | 3 live lanes waited 23h for kickoff from a dead id |

launch.1's own handover broadcast carried a stale id for itself and corrected it
a message later: *"that id is stale (the broker reconnect reissued it)"*.

## Mechanism

`broker.ts:1430` already contains a guard designed to prevent exactly this:

```ts
const samePidRefresh = Boolean(existing && inheritedId === null &&
  existing.cwd === body.cwd &&
  nullableStableValueCompatible(existing.git_root, body.git_root) &&
  nullableStableValueCompatible(existing.absolute_git_dir, body.absolute_git_dir ?? null) &&
  ttyCompatibleForSamePid(existing.tty, body.tty) &&
  (...client type...));
const id = inheritedId ?? (samePidRefresh ? existing!.id : null) ?? generateId();
```

Its comment states the intent plainly: *"a live peer re-registering (e.g. 401
recovery after a broker restart) must KEEP its broker id so mail addressed to
that id still resolves."* It even records a prior incident where a fresh
`generateId()` on re-register let the dedup-delete wipe the old id's undelivered
mail.

**The gate is keyed on pid.** `existing` is looked up by pid, and every other
clause compares against that row.

An MCP-server reconnect starts a **new server process with a new pid**. The
`existing`-by-pid lookup misses, `samePidRefresh` is false, and `generateId()`
mints a new id while the old row is dedup-deleted.

So the guard cannot survive the event that most commonly triggers
re-registration. It protects a broker restart where the MCP process persists;
it does not protect an MCP reconnect, which is the case observed here.

## Blast radius, honestly stated

**Zero mail was lost in the observed instance.** All 73 messages referencing the
dead id are `delivered=1`; zero orphaned. The rotation happened at a benign
moment. This is a latent hazard that did not fire, not a measured loss — and the
code comment shows it *has* fired before.

The routing layer is correct and does the right thing unaided. `regtest-luna`
received a message whose body said "reply to d4y7xpxd", ignored it, and replied
to the live `from` id off the envelope. The round trip closed in ~40s. The
documented rule — route by `from`, never by body content — works.

**What breaks is prose.** Envelopes refresh; documents do not. Every failure
above is an id that was written down and later read back:

- 3 lanes idle 23h against `wkjhc33t`
- two sends of mine rejected: `Peer 9loyt7uk not found`, `1rhbw2n7 is stale`
- a fleet handover broadcast that had to correct its own id

## Convention

**Never embed a peer id in prose.** Not in kickoff documents, handover notes,
summaries, or message bodies.

Address by **name** or **seat**, and let the envelope carry identity. `send_to_peer`
takes `name`, `tmux_target`, or `seat_key` for this reason. A seat outlived the
id rotation in every case above; the id did not.

When an id must appear — a bug report, a measurement — write it with its
observation time and treat it as a timestamped sample, not an address.

## Open question for whoever owns broker.ts

Should the same-id gate widen beyond pid? `seat_key` is the obvious candidate:
it survived every rotation observed here.

But this is **not a recommendation**, because the same comment block records that
tmux location fields were *deliberately removed* from the gate — a bg lane's
`pane_id` is null until resolved and can shift on re-attach, and gating on it
caused the very mail-wipe this guard now prevents. Any widening has to explain
why it does not reintroduce that.

An alternative worth weighing: keep the gate as-is and make rotation **loud**
instead of silent — emit the old and new id on rotation so a stale reference is
diagnosable from a log rather than from a failed send hours later.
