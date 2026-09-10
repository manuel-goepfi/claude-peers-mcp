# Launcher compatibility and pane-label verification

Manzo authorized resolving the two remaining full-verification failures after
startup-binding repair `9f7e5ca`. Inherited `bench/peer-fleet.ts` edits remain
excluded. No broker, hook or running-session restart is needed for these changes.

## Launcher

Installed Codex help defines `--worktree` as a boolean option for a managed Git
worktree. The launcher did not classify it, so its conservative unknown-option
path could wrap a subsequent noninteractive command in a pane-local app server.
Adding the option only to the help expectation would have hidden this behavior.

The launcher now recognizes the flag without consuming another argument. The
existing no-seat-dependencies passthrough test was strengthened with --worktree:
it failed with exit 127 before the runtime correction and passes afterward.
A separate interactive test verifies the app server is retained and the native
flag is forwarded unchanged. Installed CLI help audit also passes.

## Pane label

The fixture seeds `infra.9` on an open pane in a differently named session.
The established contract preserves the open pane ordinal and updates its prefix,
so the correct result is the new session name followed by `.9`, not `.1`.
This is explicitly covered by the operator-label unit tests and operations guide.
No production naming behavior was changed.

The integration fixture now uses a private tmux socket and no user tmux config.
A PATH wrapper routes unqualified hook calls to that socket even though the
fixture intentionally clears TMUX. Explicit test overrides prevent inherited
tmux binary/socket settings from escaping the fixture. Both broker registration
and the pane's resulting operator label are asserted against the same `.9` name.

## Review and verification

Independent read-only review confirmed the label contract and test behavior and
identified the inherited-override isolation edge; that correction was applied
and the isolated naming test rerun successfully (12 assertions). Targeted launcher
verification passed three tests with eight assertions.

`bun run verify` passed using Bun 1.3.11: typecheck, 1,366 tests across 94 files
(4,663 assertions, zero failures), and clean-install smoke for Claude, Codex and
Gemini with register/discover/send/ack. Full tests took 167.29 seconds under a
two-CPU, 3 GiB scope. The final fixture-override adjustment was also checked by
the targeted isolated test. Diff whitespace validation passed. These results
close the two pre-existing verification failures recorded in the startup-binding
repair; native release-host and legacy capacity admission remain separate gates.
