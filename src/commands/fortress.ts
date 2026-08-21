import { callTilionTool } from "../tilion-client.js";

/**
 * fortress status — show current Fortress persona and fingerprint state
 * Proxies through the tilion-mcp bridge
 */
export async function fortressStatus(): Promise<{
  persona?: string;
  fingerprint_state?: string;
  ua?: string;
  error?: string;
}> {
  try {
    const result = await fortressStatusWithDeadline();
    return result;
  } catch (error) {
    return {
      error: `fortress status failed: ${error}`,
    };
  }
}

/**
 * Resolve fortress status, but never let the command hang. When no tilion-mcp
 * bridge is running (or it is slow to become ready), the underlying bridge
 * poll keeps the process's event loop alive for up to the bridge readiness
 * timeout. We cap our own wait at a short deadline and arm a watchdog that
 * forces a clean, non-zero process exit once the CLI has already produced its
 * graceful error — so `fortress status` always returns promptly instead of
 * blocking on a pending poll timer.
 */
const FORTRESS_STATUS_DEADLINE_MS = 1000;
const FORTRESS_STATUS_WATCHDOG_MS = 2500;

function fortressStatusWithDeadline(): Promise<{
  persona?: string;
  fingerprint_state?: string;
  ua?: string;
}> {
  let settled = false;
  const watchdog = setTimeout(() => {
    if (!settled) process.exit(1);
  }, FORTRESS_STATUS_WATCHDOG_MS);
  watchdog.unref();
  return withTimeout(
    callTilionTool("fortress_status", {}),
    FORTRESS_STATUS_DEADLINE_MS,
    `fortress status timed out waiting for the tilion-mcp bridge on port ${process.env.CHROME_DEVTOOLS_AXI_TMCP_PORT ?? 9223}`,
  )
    .then((value) => {
      // Success: the bridge is healthy and the process can exit on its own.
      settled = true;
      clearTimeout(watchdog);
      // The bridge returns the decoded tool-text from `extractToolText`,
      // which is always a string. The fortress_status tool's text IS a
      // JSON object stringified for transport, so parse it back. If it
      // fails, return an empty object and let downstream consumers
      // see "missing" fields instead of `undefined` from a bad cast.
      let parsed: {
        persona?: string;
        fingerprint_state?: string;
        ua?: string;
      } = {};
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        // Tool returned a non-JSON string (e.g. plain status text).
        // Leave parsed as {} — callers handle missing fields gracefully.
      }
      return parsed;
    })
    .catch((err) => {
      // Error path: the underlying bridge poll may still hold the event loop
      // open (pending setTimeout chain), so we deliberately leave the watchdog
      // armed. It forces a clean, non-zero exit shortly after the graceful
      // error has been produced, instead of relying on the loop emptying.
      throw err;
    });
}

/**
 * Race a promise against a fixed timeout so fortress commands fail fast
 * (and gracefully) instead of hanging on a missing/down tilion-mcp bridge.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * fortress persona set <persona-id> — switch to a specific stealth persona
 * Proxies through the tilion-mcp bridge
 */
export async function fortressPersonaSet(personaId: string): Promise<{
  status: string;
  persona_id?: string;
  error?: string;
}> {
  if (!personaId || personaId.trim().length === 0) {
    return {
      status: "error",
      error: "persona_id required",
    };
  }

  try {
    const result = await callTilionTool("fortress_persona_set", {
      persona_id: personaId,
    });
    // Bridge returns the decoded text (string); persona_set transports
    // a JSON object inside that string. Parse it; if the tool returns
    // plain status text instead, return a default with the parsed
    // persona_id so downstream sees success.
    try {
      const parsed = JSON.parse(result) as {
        status?: string;
        persona_id?: string;
      };
      return {
        status: parsed.status ?? "applied",
        persona_id: parsed.persona_id ?? personaId,
      };
    } catch {
      return { status: "applied", persona_id: personaId };
    }
  } catch (error) {
    return {
      status: "error",
      error: `fortress persona set failed: ${error}`,
    };
  }
}

/**
 * fortress reset — clear all Fortress stealth state (fingerprint, persona, etc)
 * Proxies through the tilion-mcp bridge
 */
export async function fortressReset(): Promise<{
  status: string;
  error?: string;
}> {
  try {
    const result = await callTilionTool("fortress_reset", {});
    // Bridge returns the decoded text (string); reset transports a JSON
    // object inside that string. Parse it; fall back to a default success
    // shape if the tool returns plain status text.
    try {
      const parsed = JSON.parse(result) as { status?: string };
      return { status: parsed.status ?? "ok" };
    } catch {
      return { status: "ok" };
    }
  } catch (error) {
    return {
      status: "error",
      error: `fortress reset failed: ${error}`,
    };
  }
}
