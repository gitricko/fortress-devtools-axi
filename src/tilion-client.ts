import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSessionName, resolveTilionSessionPort, resolveTilionSessionPidFile } from "./sessions.js";
import { writePidFile, removePidFile, getErrorMessage } from "./bridge.js";
import { httpGet, httpPost, isProcessAlive, readPidFile } from "./client.js";
import { resolveTilionBridgeScript, TILION_BRIDGE_PORT_IN_USE_EXIT_CODE } from "./tilion-bridge-script.js";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

interface SpawnedBridge {
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

/**
 * Ensure the tilion bridge is running, starting it if needed.
 */
export async function ensureTilionBridge(): Promise<number> {
  const sessionName = resolveSessionName();
  const port = resolveTilionSessionPort(sessionName);
  const pidFile = resolveTilionSessionPidFile(sessionName);

  // Check existing bridge via PID file
  const pidInfo = readPidFile(pidFile);
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    if (
      await checkTilionBridgeHealth(pidInfo.port, sessionName)
    ) {
      return pidInfo.port;
    }
    await terminateTilionBridgeProcess(pidInfo.pid);
  }

  // Start a new bridge
  const child = spawnTilionBridgeProcess(port, sessionName);

  // Poll for health
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const timeoutMs = 30000;
  const deadline = Date.now() + timeoutMs;
  let sawShallowReady = false;
  while (Date.now() < deadline) {
    if (await checkTilionBridgeHealth(port, sessionName)) {
      return port;
    }
    if (childExited) {
      if (await checkTilionBridgeHealth(port, sessionName)) {
        return port;
      }
      throw buildTilionBridgeEarlyExitError(sessionName, port, exitCode, exitSignal);
    }
    if (!sawShallowReady && (await checkTilionBridgeHealth(port, sessionName))) {
      sawShallowReady = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (sawShallowReady) {
    throw new Error("Bridge is running but the attached target appears to have gone away");
  }

  throw new Error("Tilion bridge failed to start within timeout");
}

function checkTilionBridgeHealth(
  port: number,
  sessionName: string
): Promise<boolean> {
  return httpGet(port, "/health", 5000).then(
    (resp: string) => {
      const data = JSON.parse(resp);
      return data.status === "ok" && data.session === sessionName;
    },
    () => false
  );
}

/**
 * Race a promise against a fixed timeout so callers fail fast when the
 * tilion-mcp bridge is absent or slow to start (instead of waiting the
 * full 30s ensureTilionBridge timeout).
 *
 * Note: this only short-circuits the *Promise*. Synchronous work inside
 * the wrapped promise (e.g. execSync) will still block the event loop
 * until it returns or the host kills the process. Callers that need to
 * bound synchronous subprocesses should pair this with execSync({ timeout })
 * or child_process.kill from a setTimeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Call a tilion-mcp tool through the bridge.
 */
export async function callTilionTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  // Short top-level timeout so a missing/down bridge returns a graceful
  // error in ~1s instead of hanging the CLI for 30s on bridge startup.
  //
  // Exit watchdog: when the timeout fires, the inner ensureTilionBridge
  // polling is still running for up to 30s. Without this watchdog, a CLI
  // like `chrome-devtools-axi fortress persona-set` would print the
  // timeout error and then block until the polling finishes — leaving
  // the process alive long past its useful work. Exit 2 so callers can
  // distinguish a bridge failure from a tool-call failure (exit 1).
  //
  // Ordering matters: REJECT first, then schedule the exit. The previous
  // version called process.exit() before reject() could propagate, which
  // meant the surrounding try/catch in fortressStatus/persona-set never
  // got to format its FORTRESS_ERROR message — users saw only the raw
  // watchdog stderr. Deferring the exit to a setImmediate gives the
  // rejection a chance to land in the awaiting catch before the process
  // goes away.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setImmediate> | undefined;
  // Tracks whether the watchdog timeout has actually fired. The finally
  // block must NOT clear the pending exit if it has — otherwise the
  // process keeps running with `ensureTilionBridge`'s polling alive for
  // the full 30s. (See #9 in Greptile review.)
  let watchdogFired = false;
  try {
    const port = await Promise.race([
      Promise.resolve(ensureTilionBridge()),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          watchdogFired = true;
          reject(
            new Error(
              "tilion-mcp bridge did not become ready within 1500ms (is tilion-mcp installed and runnable?)",
            ),
          );
          // Exit on the NEXT tick (after the rejection has propagated
          // through the Promise.race and any surrounding try/catch can log
          // the formatted error). The finally block will NOT cancel this
          // because `watchdogFired` is true.
          exitTimer = setImmediate(() => {
            process.stderr.write(
              "[tilion-client] bridge startup exceeded budget; exiting process to avoid hang\n",
            );
            process.exit(2);
          });
        }, 1500);
      }),
    ]);
    try {
      const resp = await httpPost(port, "/call", { name, args });
      const data = JSON.parse(resp);
      if (data.error) {
        throw new Error(data.error);
      }
      return data.result ?? "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Tilion tool call failed: ${message}`);
    }
  } finally {
    // Only cancel the watchdog / exit if the timeout has NOT fired.
    // If it has fired, the exit was scheduled for a reason — keep it.
    if (!watchdogFired) {
      if (watchdog) clearTimeout(watchdog);
      if (exitTimer) clearImmediate(exitTimer);
    }
  }
}

export async function stopTilionBridge(): Promise<boolean> {
  // Read the TILION-specific PID file, not the shared chrome bridge one.
  const sessionName = resolveSessionName();
  const pidFile = resolveTilionSessionPidFile(sessionName);
  const pidInfo = readPidFile(pidFile);
  if (!pidInfo) return false;
  if (!isProcessAlive(pidInfo.pid)) return false;
  await terminateTilionBridgeProcess(pidInfo.pid);
  return true;
}

function spawnTilionBridgeProcess(port: number, sessionName: string): SpawnedBridge {
  const bridgeScript = resolveTilionBridgeScript(import.meta.dirname);
  const script = existsSync(bridgeScript.replace(/\.js$/, ".ts"))
    ? bridgeScript.replace(/\.js$/, ".ts")
    : bridgeScript;
  const runner = script.endsWith(".ts") ? "tsx" : "node";

  const child = spawn(
    runner === "tsx" ? "npx" : "node",
    runner === "tsx" ? ["tsx", script] : [script],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        CHROME_DEVTOOLS_AXI_PORT: String(port),
        CHROME_DEVTOOLS_AXI_SESSION: sessionName,
      },
      detached: true,
    },
  );
  child.unref();
  return child;
}

function buildTilionBridgeEarlyExitError(
  sessionName: string,
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const how =
    signal != null
      ? `was killed by ${signal}`
      : `exited with code ${code ?? "unknown"}`;
  const message = `Tilion bridge for session "${sessionName}" ${how} before becoming ready on port ${port}`;

  if (code === TILION_BRIDGE_PORT_IN_USE_EXIT_CODE) {
    return new Error(`${message}. Port ${port} is already in use.`);
  }

  return new Error(`${message}. Check that tilion-mcp can start: npx tilion-mcp@latest --help`);
}

function terminateTilionBridgeProcess(pid: number): void {
  // PID-reuse safety: before sending a signal, verify the process at
  // `pid` is actually a chrome-devtools-axi-tilion-bridge. PIDs can be
  // reused on Linux between process exit and a new unrelated process
  // starting, so blindly signaling any live PID could terminate the
  // wrong process. The chrome bridge does the same check via
  // isBridgeProcess. (See Greptile P1 "Reused PID kills unrelated
  // process".)
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 1000,
    });
    if (!command.includes("chrome-devtools-axi-tilion-bridge")) {
      // PID reused by an unrelated process — refuse to signal.
      return;
    }
  } catch {
    // ps failed (pid not found, or timed out) — refuse to signal.
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}
