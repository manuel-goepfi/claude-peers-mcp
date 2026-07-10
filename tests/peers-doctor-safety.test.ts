import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doctor = new URL("../bin/peers-doctor.sh", import.meta.url).pathname;
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function doctorHome(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "claude-peers-doctor-"));
  roots.add(home);

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      UserPromptSubmit: [],
      Stop: [],
      SessionStart: [],
    },
  }));

  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  const pgrep = join(fakeBin, "pgrep");
  writeFileSync(pgrep, "#!/bin/sh\nexit 1\n");
  chmodSync(pgrep, 0o755);

  return { home, path: `${fakeBin}:${process.env.PATH ?? ""}` };
}

async function runDoctor(port: number): Promise<{ exitCode: number; output: string }> {
  const fixture = doctorHome();
  const proc = Bun.spawn(["bash", doctor], {
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: fixture.path,
      CLAUDE_PEERS_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

describe("peers doctor safety", () => {
  test("source has no mutating broker endpoint call", () => {
    const source = readFileSync(doctor, "utf8");
    const curlCommands = source.split("\n").filter((line) => /\bcurl\b/.test(line) && !line.trimStart().startsWith("#"));
    expect(curlCommands).toHaveLength(1);
    expect(curlCommands[0]).toContain('"${BROKER_URL}/health"');
  });

  test("healthy broker receives only one coarse health read", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        return Response.json({
          status: "ok",
          peers: 2,
          capabilities: {
            hookDrain: {
              claimByPid: true,
              ackByPid: true,
              hookHeartbeatByPid: true,
            },
          },
        });
      },
    });

    try {
      const port = server.port!;
      const result = await runDoctor(port);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("broker /health responding");
      expect(result.output).toContain("read-only safety mode");
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    } finally {
      server.stop(true);
    }
  });

  test("unreachable broker is a critical failure after one health read", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        return new Response("unavailable", { status: 503 });
      },
    });

    try {
      const port = server.port!;
      const result = await runDoctor(port);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`broker /health not responding on 127.0.0.1:${port}`);
      expect(requests).toEqual([{ method: "GET", path: "/health" }]);
    } finally {
      server.stop(true);
    }
  });
});
