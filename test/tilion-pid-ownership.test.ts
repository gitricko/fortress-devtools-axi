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

  it("does NOT overwrite a PID record owned by a different live process", async () => {
    const mod = await import("../src/tilion-bridge-script.js");
    const path = mod.resolveTilionPidFile("default");
    // Pretend another bridge owns it.
    writeFileSync(
      path,
      JSON.stringify({ pid: 999999, port: 9225, startedAt: Date.now() }),
    );
    // Try to write ours.
    mod.writeTilionPidFile(9225, "default");
    const contents = JSON.parse(readFileSync(path, "utf8"));
    // Should still be the original record, not ours.
    expect(contents.pid).toBe(999999);
    rmSync(path);
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
