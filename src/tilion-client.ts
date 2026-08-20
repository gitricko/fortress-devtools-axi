import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSessionName, resolveTilionSessionPort, resolveTilionSessionPidFile } from "./sessions.js";
import { writePidFile, removePidFile, getErrorMessage } from "./bridge.js";
import { httpGet, httpPost, isProcessAlive, readPidFile } from "./client.js";
import { resolveTilionBridgeScript, TILION_BRIDGE_PORT_IN_USE_EXIT_CODE } from "./tilion-bridge-script.js";
import { spawn } from "node:child_process";
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
  const port = await withTimeout(
    ensureTilionBridge(),
    1500,
    "tilion-mcp bridge did not become ready within 1500ms (is tilion-mcp installed and runnable?)",
  );
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
}

export async function stopTilionBridge(): Promise<boolean> {
  const pidInfo = readPidFile();
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
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}
