/**
 * Dependency-free bridge facts shared by the CLI and the tilion bridge process.
 *
 * This module deliberately imports nothing but node builtins.
 */

import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { resolveSessionStateDir } from "./sessions.js";

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
  writeFileSync(resolveTilionPidFile(sessionName), JSON.stringify(payload));
}

export function removeTilionPidFile(sessionName?: string): void {
  try {
    unlinkSync(resolveTilionPidFile(sessionName));
  } catch {
    // ignore — file may not exist on a quick restart
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
