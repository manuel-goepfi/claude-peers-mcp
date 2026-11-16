// Body of the fake Codex TUI from tests/helpers/fake-codex.ts: stay alive for
// argv[2] seconds, then exit.
setTimeout(() => {}, Number(process.argv[2]) * 1000);
