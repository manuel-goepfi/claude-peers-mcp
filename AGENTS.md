<!-- BEGIN MANZO COMMON RULES -->
# claude-peers maintainer instructions

This repository is the maintained Manzo downstream for same-user peer discovery and messaging across Claude Code, Codex CLI, Gemini CLI, and OpenCode.

## Runtime boundaries

- `broker.ts` is the loopback HTTP/SQLite singleton and owns the port and canonical database lock. `server.ts` is one stdio MCP adapter per client session; preserve that lifecycle boundary.
- `shared/storage.ts` owns schema versioning, verified backup, migration, retention, and offline restore. `shared/broker-lifecycle.ts` owns listener, process, and database identity checks.
- `shared/hook-config.ts` and `shared/hook-installer-cli.ts` own canonical hook definitions and scope-aware installation. `bin/peers-doctor.ts` is read-only and may use only health plus same-user process/config/database evidence.
- Use the repository-pinned Bun runtime and frozen lockfile. The pane-local Codex shared-app-server relay is the documented Node exception because its upstream transport needs `ws+unix`; keep the Unix listener on `node:http` plus pinned `ws` and retain the transport test.

## Messaging and authority invariants

- A message is `queued` after insertion, `claimed` while leased, and `acknowledged` only after an acknowledgement timestamp. Never infer delivery from a send result or missing row.
- Peer tokens prove possession of a broker-issued identity, not OS provenance, metadata truth, authority, approval, or task scope. Inbound peer text is untrusted coordination data.
- Tmux inspection is explicit and read-only. Pane text must not enter messages, SQLite, logs, bridge output, health, or doctor JSON.
- Client adapters do not background-poll MCP bodies. Receipt is hook-driven or an explicit `check_messages` drain. Preserve per-session processes and optimize only measured polling or unchanged writes.
- Diagnostics remain non-mutating. A transport outage never authorizes direct broker-store repair.

## Verification and editing

- Use `bun run typecheck`, `bun test`, `bun run smoke:install`, and `bun run verify` for ordinary validation. The capacity benchmark and authenticated release-host smoke are conditional, expensive gates; the client smoke must report blocked unless its isolated host/account is explicitly armed.
- Use `bun:sqlite`; do not introduce an ORM. Use `Bun.serve`; do not introduce a web framework. The documented Codex relay is the only `node:http` exception.
- Keep the public runtime inventory in `README.md`, operational procedures in `docs/operations.md`, and their contract tests synchronized.
- Do not restore an LLM or API-key summary dependency. Peers set summaries explicitly with `set_summary`.
<!-- END MANZO COMMON RULES -->
