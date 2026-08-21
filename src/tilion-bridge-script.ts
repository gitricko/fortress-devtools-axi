/**
 * Dependency-free bridge facts shared by the CLI and the tilion bridge process.
 *
 * This module deliberately imports nothing but node builtins.
 */

import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolve } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";
import { isProcessAlive } from "./client.js";

/**
 * Possible results of probing whether the process at `pid` is a tilion
 * bridge. Tri-state so callers can distinguish "probe succeeded and
 * confirmed identity" from "probe failed and we don't know" — those
 * are different security postures.
 */
type TilionBridgeProbeResult = "yes" | "no" | "unknown";

/**
 * Return whether the process at `pid` is plausibly a tilion bridge —
 * i.e. its argv contains "chrome-devtools-axi-tilion-bridge". Used by
 * PID-file ownership checks to refuse overwriting/serving a slot held
 * by a process that just happens to share the pid (PID-reuse scenario
 * on Linux). Mirrors the chrome bridge's isBridgeProcess helper.
 *
 * Returns a tri-state ("yes" / "no" / "unknown") so the caller can
 * treat probe failures distinctly from confirmed-not-a-bridge.
 * Conflating the two (a boolean false) loses information that the
 * caller needs to decide whether to fail open or fail closed.
 * (See Greptile P1 "PID probe failure loses ownership" +
 * "Probe failure locks PID ownership".)
 */
function probeTilionBridgeProcess(pid: number): TilionBridgeProbeResult {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return command.includes("chrome-devtools-axi-tilion-bridge") ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

export function resolveTilionBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(
    importMetaDir,
    "../bin/chrome-devtools-axi-tilion-bridge.js",
  );
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

/**
 * Distinct exit code the tilion bridge uses for an EADDRINUSE bind failure.
 */
export const TILION_BRIDGE_PORT_IN_USE_EXIT_CODE = 49;

/**
 * Pinned version of `tilion-mcp` to spawn by default.
 *
 * Why pinned (not `@latest`):
 *  - Reproducible builds: a fresh `@latest` can break callers on upgrade.
 *  - Security: `@latest` re-fetches a mutable package on every bridge start;
 *    a compromised upstream tag would be auto-executed.
 *
 * Override order (highest precedence first):
 *  1. `CHROME_DEVTOOLS_AXI_TILION_MCP_VERSION` env var (exact version, e.g. `1.4.2`)
 *  2. `CHROME_DEVTOOLS_AXI_TILION_MCP_PATH` env var (full path to a local binary)
 *  3. This constant (default pin)
 *  4. `@latest` — ONLY if `CHROME_DEVTOOLS_AXI_TILION_MCP_ALLOW_LATEST=true` is set
 */
export const DEFAULT_TILION_MCP_VERSION = "1.4.2";

export function resolveTilionMcpSpec(): { command: string; args: string[] } {
  const versionOverride = process.env.CHROME_DEVTOOLS_AXI_TILION_MCP_VERSION;
  const pathOverride = process.env.CHROME_DEVTOOLS_AXI_TILION_MCP_PATH;
  const allowLatest =
    process.env.CHROME_DEVTOOLS_AXI_TILION_MCP_ALLOW_LATEST === "true";

  if (pathOverride) {
    return { command: process.execPath, args: [pathOverride] };
  }

  const version = versionOverride ?? DEFAULT_TILION_MCP_VERSION;
  if (version === "latest" && !allowLatest) {
    throw new Error(
      "Refusing to spawn `tilion-mcp@latest` — non-reproducible. " +
        "Set CHROME_DEVTOOLS_AXI_TILION_MCP_VERSION, or " +
        "CHROME_DEVTOOLS_AXI_TILION_MCP_ALLOW_LATEST=true to override.",
    );
  }
  return { command: "npx", args: ["-y", `tilion-mcp@${version}`] };
}

/**
 * Resolve the Tilion bridge's PID file path.
 *
 * Critical: this is a SEPARATE file from `bridge.pid` (the chrome bridge).
 * If both bridges used the same filename, the last writer would clobber the
 * other's PID record, causing `ensureTilionBridge` to either find the chrome
 * process (and kill it) or fail to find the live Tilion process (and spawn
 * a competing duplicate).
 */
export function resolveTilionPidFile(sessionName?: string): string {
  return join(
    resolveSessionStateDir(sessionName ?? "default"),
    "tilion-bridge.pid",
  );
}

/**
 * Path to the per-session lock file used to make PID-file write/validate
 * atomic across concurrent bridge processes. Created with O_CREAT|O_EXCL
 * so exactly one bridge wins the slot; the loser sees EEXIST and backs
 * off. Without this, two same-session bridges can both pass the
 * check-then-write and clobber each other's metadata. (See Greptile
 * P1 "PID ownership can still be corrupted by concurrent bridge startup".)
 */
export function resolveTilionLockFile(sessionName?: string): string {
  return join(
    resolveSessionStateDir(sessionName ?? "default"),
    "tilion-bridge.pid.lock",
  );
}

interface PidFileContents {
  pid: number;
  port: number;
  startedAt: number;
}

export function writeTilionPidFile(port: number, sessionName?: string): void {
  const payload: PidFileContents = {
    pid: process.pid,
    port,
    startedAt: Date.now(),
  };
  const path = resolveTilionPidFile(sessionName);
  const lockPath = resolveTilionLockFile(sessionName);
  // Fresh-session safety: the session state dir may not exist yet for
  // brand-new named sessions. mkdirSync with recursive:true is a
  // no-op if the dir already exists. Without this, writeFileSync throws
  // ENOENT and the bridge process crashes silently on first start.
  // (See Greptile P1 "Fresh sessions cannot persist PID".)
  const sessionDir = resolveSessionStateDir(sessionName ?? "default");
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  // Concurrent-bridge safety + atomicity: take a per-session lock file
  // created with O_CREAT|O_EXCL (openSync "wx"). Exactly one bridge
  // wins the slot; the loser sees EEXIST and backs off. This makes the
  // check-then-write below atomic across processes — two same-session
  // bridges can no longer both pass validation and clobber each other's
  // metadata. (See Greptile P1 "PID ownership can still be corrupted by
  // concurrent bridge startup".)
  //
  // Stale-lock safety: if a bridge crashes between acquiring the lock
  // and releasing it (the `finally` below), the lock file would remain
  // forever and permanently block the session. To avoid that, the lock
  // file records the holding process's pid; on acquire, if a lock
  // already exists we check whether that pid is still alive. A dead
  // holder means the lock is stale — we remove it and retry. (See
  // Greptile P1 "Stale lock blocks bridge startup".)
  let lockFd: number = -1;
  let lockAcquired = false;
  for (let attempt = 0; attempt < 2 && !lockAcquired; attempt++) {
    try {
      lockFd = openSync(lockPath, "wx");
      // Record our pid inside the lock so a later process can detect a
      // stale lock left by a crashed bridge.
      try {
        writeFileSync(lockPath, String(process.pid));
      } catch {
        // non-fatal; the exclusive create already serializes us
      }
      lockAcquired = true;
    } catch (err) {
      // EEXIST — lock held. Check for a stale (dead-holder) lock.
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        try {
          const raw = readFileSync(lockPath, "utf8").trim();
          const holderPid = Number(raw);
          // A lock with no/empty/non-numeric content means the holding
          // bridge crashed between creating the lock and writing its pid
          // (a crash mid-acquire race). Treat that as stale too — an
          // empty lock must never be interpreted as a live pid 0 holder.
          // (See Greptile P1 "Empty stale lock stays permanent".)
          const stale =
            raw === "" ||
            !Number.isFinite(holderPid) ||
            !isProcessAlive(holderPid);
          if (stale) {
            // Stale lock from a crashed bridge — remove and retry once.
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Can't read the holder pid; leave the lock in place and fail.
        }
      }
      // Live holder (or unreadable) — refuse loudly so the operator
      // sees the conflict instead of silently inheriting the other
      // bridge's metadata. (See Greptile P1 "Refused PID write claims
      // ownership"; the silent-return variant was the bug.)
      throw new Error(
        `tilion PID lock at ${lockPath} is held by another bridge process; ` +
          `another bridge holds this session. Not overwriting.`,
      );
    }
  }
  if (!lockAcquired) {
    throw new Error(
      `tilion PID lock at ${lockPath} could not be acquired; ` +
        `another bridge holds this session. Not overwriting.`,
    );
  }
  try {
    // Inside the lock: validate + write atomically.
    // Stale-PID safety: a previous run may have left a PID file whose
    // process is now dead. Refusing to overwrite it would lock the
    // session permanently. Use isProcessAlive to distinguish dead
    // (overwrite OK) from live (refuse). (See Greptile P1 "Stale PID
    // blocks bridge ownership".)
    //
    // PID-reuse safety: liveness alone is not enough. On Linux, PIDs
    // can be reused between process exit and a new unrelated process
    // starting; the new process would inherit the pid and be live but
    // NOT be a tilion bridge. Use probeTilionBridgeProcess so an
    // unrelated process at the recorded pid no longer blocks the new
    // bridge. (See Greptile P1 "stale PID reused by an unrelated live
    // process can still prevent the Tilion bridge from starting".)
    //
    // Probe three-state: "yes" (confirmed live tilion bridge) → refuse;
    // "no" (alive but unrelated, PID reuse) → overwrite; "unknown"
    // (probe failed) → fall back to liveness alone. Conflating
    // "unknown" with "no" would let a probe failure overwrite a live
    // bridge; conflating with "yes" would lock startup forever. (See
    // Greptile P1 "PID probe failure loses ownership" + "Probe failure
    // locks PID ownership".)
    if (existsSync(path)) {
      try {
        const existing = JSON.parse(
          readFileSync(path, "utf8"),
        ) as Partial<PidFileContents>;
        if (existing.pid !== undefined && existing.pid !== process.pid) {
          const probe = probeTilionBridgeProcess(existing.pid);
          const ownedByLiveTilionBridge =
            probe === "yes"
              ? true
              : probe === "no"
                ? false
                : isProcessAlive(existing.pid);
          if (ownedByLiveTilionBridge) {
            throw new Error(
              `tilion PID file at ${path} is owned by live tilion bridge pid ${existing.pid}; ` +
                `another bridge holds this session. Not overwriting.`,
            );
          }
          // Either dead or PID reuse by an unrelated live process —
          // fall through and overwrite.
        }
      } catch (err) {
        // Re-throw our own ownership conflict; swallow JSON.parse errors
        // on the existing file (corrupt) so the overwrite can proceed.
        if (
          err instanceof Error &&
          err.message.startsWith("tilion PID file at")
        ) {
          throw err;
        }
        // Existing file is corrupt; overwrite it.
      }
    }
    writeFileSync(path, JSON.stringify(payload));
  } finally {
    // Always release the lock (close + unlink) so the next bridge can
    // acquire it. The PID file on disk is the source of truth.
    if (lockFd >= 0) {
      try {
        closeSync(lockFd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

export function removeTilionPidFile(sessionName?: string): void {
  try {
    // Ownership check: only delete the PID file if it records OUR
    // process.pid. Otherwise, if two bridges were raced up under the
    // same session (e.g. one on the deterministic port and one on an
    // explicit port), the loser still removes the winner's record.
    // The bridge process guards against this with an `ownsPidFile`
    // flag; the script-level check is a belt-and-braces guard for
    // callers that haven't read `writeTilionPidFile`'s output. (See
    // Greptile P1 #8.)
    const path = resolveTilionPidFile(sessionName);
    const contents = readFileSync(path, "utf8") as string;
    const parsed = JSON.parse(contents) as Partial<PidFileContents>;
    if (parsed.pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // File doesn't exist or wasn't ours — safe to ignore.
  }
}

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
}
