> **CORRECTION 2026-08-08 — instance 1's stated cause is WRONG.** Refuted by
> infra.4 with measurements I confirmed. Read this before the section below.
>
> **The pid gate is not the cause.** `broker.ts:1436` is
> `const id = inheritedId ?? (samePidRefresh ? existing!.id : null) ?? generateId();`
> — seat inheritance is checked FIRST and outranks the pid gate. Seat-as-address
> is already built (`broker.ts:1284-1330` elects a seat survivor and sets
> `inheritedId`). I quoted line 1436 verbatim below and still blamed the fallback
> clause, having missed that the clause I proposed adding already sits ahead of it.
>
> **The real cause is a DELETE.** `handleUnregister` (`broker.ts:2264-2278`) is
> `if (pending > 0) return; deletePeer.run(body.id)`. A graceful MCP shutdown with
> an EMPTY inbox deletes the row, so the reconnect finds no seat occupant to merge
> with and mints a fresh id. Its own comment documents keeping the row when mail
> IS pending — as a fix for a prior orphaning bug — and never covers the empty case.
> A seat-keyed queue would not have helped: the same delete removes it.
>
> **And "pane id never lost" was survivorship bias.** I measured only across MCP
> reconnects, which do not touch tmux. tmux pane ids RESET TO %0 on server restart
> — infra.4 proved it on an isolated `tmux -L` socket. `shared/seat.ts:44` scopes
> its uniqueness claim to "across the whole tmux server", i.e. ONE LIFETIME. So a
> restarted server hands out low ids first and seat collision becomes the default,
> not an edge case. My durability ranking is void.
>
> **Better candidate:** `peers.thread_id` — already exists, already indexed,
> content-addressed, set on 10 of 16 peers, and survives a tmux restart.
>
> The label-decay observation reproduces and stands. Instances 2 and 3 stand.
> Operator has authorized infra.4 to make the `handleUnregister` fix.

# Indicators that report clean on the axis that matters

Measured 2026-08-07 by infra.3. Three instances in one week of the same shape:
**a guard exists, it reports healthy, and it does not observe the property it is
read as guaranteeing.** The first is the substance of this document; the other
two are recorded at the end because the pattern is the finding.

1. The same-id guard is keyed on a pid that changes in the one case it must survive.
2. `Drift: none` never compares the seat, so it cannot detect a wrong-pane binding.
3. `offline` in the GitHub runner list does not mean capacity is missing.

---

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

---

# Instance 2 — `Drift: none` does not check the seat

`server.ts:2384-2388` builds the drift report:

```ts
if (self.name !== myOperatorName)          drift.push(...)
if (self.resolved_name !== myResolvedName) drift.push(...)
if (self.client_type !== myClientType)     drift.push(...)
if (self.receiver_mode !== myReceiverMode) drift.push(...)
```

It compares **name, resolved_name, client_type, receiver_mode**. It does not
compare **seat_key** or **tmux_pane_id** — the fields that decide where mail is
actually routed.

So a row bound to the wrong pane prints `Drift: none`. The indicator covers
labels and modes, not routing identity.

Surfaced 2026-08-07 by orch.4, which suspected its session had been bound to
another lane's seat after a reconnect. **Its specific case was benign** — I
verified its process (`pid 1635608`, started `claude -r` at 08:53:56) carries
`TMUX_PANE=%4520` and its row says `pane:orch:%4520`; they agree, and the pane it
believed it was in (`%2314`) no longer exists. It had resumed into a different
pane than it remembered.

But it could not have told a benign case from a real hijack, because the only
tool available reports clean either way. That is why escalating was correct even
though the instance was not.

---

# Instance 3 — `offline` in the runner list is not missing capacity

Not a claude-peers defect. Recorded here because it is the same shape, and
because the pattern is worth more than any one instance.

`github-runner-local` and `github-runner-heavy` carry no `container_name` and no
`RUNNER_NAME` (`RANDOM_RUNNER_SUFFIX` defaults true), so every `compose up -d`
recreate mints a **new random registration name**. The previous name remains in
GitHub's runner list as an `offline` entry forever. Counting offline entries
measures name history, not capacity.

Diagnosed 2026-08-07 by infra.4, which also caused it — its watchdog ran an
unscoped `docker compose down --remove-orphans` at 08:30:18 SAST. It asked for
independent confirmation on the grounds that it was both diagnoser and cause.
Confirmed here by reading each container's own `.runner` `agentName`:

```
github-runner-github-runner-heavy-1  ->  clause5-heavy-nTgaVFSBFTqYO   online, busy
github-runner-github-runner-local-1  ->  clause5-local-SYI0fevte51Ni   online, busy
github-runner-manzoops-1             ->  manzoops-1                    online, busy
```

Both `offline` entries — `clause5-heavy-f4pdAK1PkhtdE`, `clause5-local-9oSmZWEX8EYvK`
— are prior names of containers that are currently running and busy. Zero
capacity lost. (Scope: only the three containers on this host were checked; the
other four online runners live elsewhere and were not inspected. The disputed
pair is fully covered.)

**The settling check is comparing the ONLINE set against running containers.**
Never count offline entries.

This matters because it presents identically to the documented
"sole-eligible-dark" signature when read from the runner list alone, and demands
the opposite response: nothing. Two jobs were killed mid-flight by the unscoped
recreate, so expect two false-red "runner lost communication" failures — do not
diagnose a branch from them.

**Placement caveat:** the canonical home for this is Clause5's CI signature set
in its `CLAUDE.md`, alongside the six already documented — nobody debugging a
runner queue will look in the claude-peers repo. It is recorded here rather than
there because an agent-authored edit to that rule text requires explicit operator
opt-in for that specific change. Promote it when that opt-in exists.
