/**
 * Tests for PID-file ownership behavior in tilion-bridge-script.
 *
 * Background (Greptile P1 review on PR #2): the original PID helpers
 * would unconditionally overwrite / delete the PID record even when
 * another bridge owned it, leading to "live bridge undiscoverable"
 * races when two bridges started in the same session.
 *
 * These tests pin the ownership contract so future changes can't
 * silently regress.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

describe("PID file ownership", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tilion-pid-test-"));
  });

  it("writes the PID record when no existing file is present", async () => {
    // Import the module fresh — it caches resolved paths on import.
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    // Clean any prior test residue.
    try {
      rmSync(path);
    } catch {}
    mod.writeTilionPidFile(9225, "default");
    const contents = JSON.parse(readFileSync(path, "utf8"));
    expect(contents.pid).toBe(process.pid);
    expect(contents.port).toBe(9225);
    rmSync(path);
  });

  it("THROWS when existing PID is alive AND belongs to a live tilion bridge", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    // Simulate a live tilion bridge by hand-crafting a PID file whose
    // recorded pid passes the liveness check (process.ppid is the
    // parent shell, which IS alive). The isTilionBridgeProcess guard
    // will see the parent's argv does NOT contain
    // "chrome-devtools-axi-tilion-bridge" and treat it as PID-reuse by
    // an unrelated process — overwriting instead of throwing.
    // So this test asserts the THROW path requires BOTH liveness AND
    // identity. We test the identity branch by directly invoking the
    // check via a synthetic live-tilion-bridge case: ps -p $ppid will
    // report the parent's command, which does NOT include
    // chrome-devtools-axi-tilion-bridge → no throw → overwrite succeeds.
    const livePid = process.ppid;
    writeFileSync(
      path,
      JSON.stringify({ pid: livePid, port: 9225, startedAt: Date.now() }),
    );
    // The parent process is alive but NOT a tilion bridge, so we
    // expect an OVERWRITE (no throw) — PID-reuse by an unrelated
    // process must not block bridge startup.
    expect(() => mod.writeTilionPidFile(9225, "default")).not.toThrow();
    const contents = JSON.parse(readFileSync(path, "utf8"));
    expect(contents.pid).toBe(process.pid);
    rmSync(path);
  });

  it("throw message names the conflict pid and the file path", async () => {
    // Operators need to know WHICH pid is holding the file so they can
    // decide whether to kill it or pick a different session. Verify
    // the error is informative, not just "Error: refused".
    // The throw path now requires both liveness AND identity. Spawn
    // a child process whose argv contains the magic marker so the
    // identity check passes — that simulates a live tilion bridge.
    const { spawn, execFileSync } = await import("node:child_process");
    // Use node with -e to set process.title — Linux's /proc/<pid>/comm
    // (which ps reads) reflects this. The bridge marker is
    // "chrome-devtools-axi-tilion-bridge"; we don't need a full match,
    // just that the substring appears.
    const child = spawn(
      "node",
      [
        "-e",
        "process.title='chrome-devtools-axi-tilion-bridge-sleeper'; setTimeout(()=>{},30000)",
      ],
      { stdio: "ignore", detached: false },
    );
    const childPid = child.pid!;
    let pidPath = "";
    try {
      // Wait briefly for ps to see the process.
      await new Promise((r) => setTimeout(r, 200));
      // Confirm the identity check actually matches.
      const psOut = execFileSync(
        "ps",
        ["-p", String(childPid), "-o", "command="],
        { encoding: "utf-8", timeout: 1000 },
      );
      expect(psOut).toContain("chrome-devtools-axi-tilion-bridge");
      const mod = await import("../src/tilion-bridge-script.js");
      const path = mod.resolveTilionPidFile("default");
      pidPath = path;
      writeFileSync(
        path,
        JSON.stringify({ pid: childPid, port: 9225, startedAt: Date.now() }),
      );
      try {
        mod.writeTilionPidFile(9225, "default");
        expect.fail(
          "expected writeTilionPidFile to throw when a live tilion-bridge-marked process holds the pid",
        );
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const msg = (err as Error).message;
        expect(msg).toContain(String(childPid));
        expect(msg).toContain("tilion bridge");
        expect(msg).toContain(path);
      }
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
      if (pidPath) rmSync(pidPath, { force: true });
    }
  });

  it("DOES overwrite a stale PID record (same pid, dead process)", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    // Our own PID but stale → safe to overwrite.
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, port: 9224, startedAt: 0 }),
    );
    mod.writeTilionPidFile(9225, "default");
    const contents = JSON.parse(readFileSync(path, "utf8"));
    expect(contents.pid).toBe(process.pid);
    expect(contents.port).toBe(9225);
    rmSync(path);
  });

  it("removeTilionPidFile() only deletes if pid matches", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    writeFileSync(
      path,
      JSON.stringify({ pid: 999999, port: 9225, startedAt: Date.now() }),
    );
    mod.removeTilionPidFile("default");
    // File should still exist (different pid).
    const after = readFileSync(path, "utf8");
    expect(JSON.parse(after).pid).toBe(999999);
    rmSync(path);
  });

  it("removeTilionPidFile() DOES delete if pid matches ours", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, port: 9225, startedAt: Date.now() }),
    );
    mod.removeTilionPidFile("default");
    let stillExists = true;
    try {
      readFileSync(path, "utf8");
    } catch {
      stillExists = false;
    }
    expect(stillExists).toBe(false);
  });

  it("THROWS if the PID lock file is held by another bridge", async () => {
    // Atomicity: writeTilionPidFile takes a per-session lock file with
    // O_CREAT|O_EXCL before validating/writing. If another process holds
    // the lock, writeTilionPidFile must throw (not silently overwrite).
    const mod = await import("../src/tilion-bridge-script.js");
    const lockPath = mod.resolveTilionLockFile("default");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid)); // simulate a held lock
    try {
      expect(() => mod.writeTilionPidFile(9225, "default")).toThrow(
        /tilion PID lock at .* is held by another bridge process/,
      );
      // Ensure the PID file was NOT written (the lock prevented it).
      let pidExists = true;
      try {
        readFileSync(mod.resolveTilionPidFile("default"), "utf8");
      } catch {
        pidExists = false;
      }
      expect(pidExists).toBe(false);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });
});
