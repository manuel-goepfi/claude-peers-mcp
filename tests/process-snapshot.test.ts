import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedCommand } from "../shared/bounded-command.ts";
import { readLinuxProcessSnapshot, readProcessSnapshot } from "../shared/process-snapshot.ts";

function stat(pid: number, ppid: number, start = "12345", comm = "fixture"): string {
  return `${pid} (${comm}) ${["S", String(ppid), ...Array(17).fill("0"), start].join(" ")}\n`;
}

function processFixture(root: string, pid: number, ppid: number, cmdline: string): string {
  const directory = join(root, String(pid));
  mkdirSync(directory);
  writeFileSync(join(directory, "stat"), stat(pid, ppid));
  writeFileSync(join(directory, "cmdline"), cmdline);
  return directory;
}

test("procfs snapshot preserves ancestry and argv while excluding incomplete records", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-process-snapshot-"));
  try {
    processFixture(root, 100, 1, "bash\0-c\0echo two words\0");
    const child = processFixture(root, 200, 100, "codex\0resume\0thread-id\0");
    writeFileSync(join(child, "stat"), stat(200, 100, "54321", "name with ) parentheses"));
    processFixture(root, 300, 100, "");
    const malformed = processFixture(root, 400, 1, "must-not-appear\0");
    writeFileSync(join(malformed, "stat"), stat(400, 1, "not-a-start-time"));
    const gone = processFixture(root, 500, 1, "gone\0");
    rmSync(join(gone, "cmdline"));
    const mismatched = processFixture(root, 600, 1, "wrong-pid\0");
    writeFileSync(join(mismatched, "stat"), stat(601, 1));
    mkdirSync(join(root, "self"));
    writeFileSync(join(root, "700"), "numeric files are not processes");
    expect(readLinuxProcessSnapshot(root).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 100, ppid: 1, args: "bash -c echo two words" },
      { pid: 200, ppid: 100, args: "codex resume thread-id" },
      { pid: 300, ppid: 100, args: "[fixture]" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a PID reuse or reparent during argv read is excluded until a fresh snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-process-reuse-"));
  try {
    for (const kind of ["reuse", "reparent"] as const) {
      const directory = processFixture(root, 100, 1, "codex\0resume\0");
      const rows = readLinuxProcessSnapshot(root, path => {
        const text = readFileSync(path, "utf8");
        if (path.endsWith("/cmdline")) {
          writeFileSync(join(directory, "stat"), stat(100, kind === "reparent" ? 2 : 1,
            kind === "reuse" ? "99999" : "12345"));
        }
        return text;
      });
      expect(rows).toEqual([]);
      expect(readLinuxProcessSnapshot(root)).toEqual([
        { pid: 100, ppid: kind === "reparent" ? 2 : 1, args: "codex resume" },
      ]);
      rmSync(directory, { recursive: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded Linux child reads a fixture and rejects corrupt or failed output", () => {
  const root = mkdtempSync(join(tmpdir(), "peers-process-child-"));
  try {
    processFixture(root, 100, 1, "codex\0resume\0");
    expect(readProcessSnapshot((command, options) => boundedCommand([...command, root], options), "linux"))
      .toEqual([{ pid: 100, ppid: 1, args: "codex resume" }]);
    for (const out of ["not-json", "{}", '[{"pid":1,"ppid":0}]', '[{"pid":-1,"ppid":0,"args":"bad"}]']) {
      expect(readProcessSnapshot(() => ({ ok: true, out }), "linux")).toBeNull();
    }
    expect(readProcessSnapshot(() => ({ ok: false, out: "[]" }), "linux")).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-Linux hosts retain the bounded ps snapshot format", () => {
  expect(readProcessSnapshot((command, options) => {
    expect(command).toEqual(["ps", "-eo", "pid=,ppid=,args="]);
    expect(options.timeoutMs).toBe(3000);
    return { ok: true, out: " 12 1 bash -c two words\n 13 12 codex resume\nmalformed\n" };
  }, "darwin")).toEqual([
    { pid: 12, ppid: 1, args: "bash -c two words" },
    { pid: 13, ppid: 12, args: "codex resume" },
  ]);
});
