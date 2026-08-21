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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("does NOT overwrite a PID record owned by a DIFFERENT live process", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    // Spawn a real but short-lived child process so the test has a
    // genuine "live owner" pid. We pick an existing system process
    // that's guaranteed to be alive (current process group) — our
    // parent process pid. This is the only stable "alive" PID we
    // can guarantee in a unit test without forking.
    const livePid = process.ppid;
    writeFileSync(
      path,
      JSON.stringify({ pid: livePid, port: 9225, startedAt: Date.now() }),
    );
    // The previous silent-return behavior left the calling bridge
    // believing it owned the file while the on-disk pid was someone
    // else's — clients would then record the wrong pid at shutdown.
    // The fix: writeTilionPidFile MUST throw so the bridge fails fast
    // instead of continuing to serve traffic on a port it doesn't own.
    expect(() => mod.writeTilionPidFile(9225, "default")).toThrow(
      /tilion PID file at .* is owned by live pid/,
    );
    // On-disk content unchanged.
    const contents = JSON.parse(readFileSync(path, "utf8"));
    expect(contents.pid).toBe(livePid);
    rmSync(path);
  });

  it("throw message names the conflict pid and the file path", async () => {
    // Operators need to know WHICH pid is holding the file so they can
    // decide whether to kill it or pick a different session. Verify
    // the error is informative, not just "Error: refused".
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    writeFileSync(
      path,
      JSON.stringify({ pid: process.ppid, port: 9225, startedAt: Date.now() }),
    );
    try {
      mod.writeTilionPidFile(9225, "default");
      expect.fail(
        "expected writeTilionPidFile to throw on contested ownership",
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain(String(process.ppid));
      expect(msg).toContain(path);
    } finally {
      rmSync(path);
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
});
