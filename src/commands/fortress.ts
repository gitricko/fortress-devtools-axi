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
const FORTRESS_STATUS_WATCHDOG_MS = 2500;
const FORTRESS_STATUS_DEADLINE_MS = 1000;

/**
 * Explicit success statuses the Fortress tool is expected to return.
 * The CLI's error path checks ONLY `status === "error"`, so anything
 * NOT in this set is a success-by-default — meaning a tool returning
 * {"status":"failed"} or {"status":"rejected"} would pass CLI
 * validation and the CLI would exit 0 with a misleading "completed"
 * message. Centralising the success set here means the wrappers
 * catch failure statuses before they reach the CLI.
 *
 * If the tool ever returns a new success value, add it here.
 */
const FORTRESS_SUCCESS_STATUSES = new Set([
  "ok",
  "applied",
  "completed",
  "success",
]);

/** Is `status` a recognized SUCCESS status from the Fortress tool? */
function isFortressSuccessStatus(status: unknown): boolean {
  return typeof status === "string" && FORTRESS_SUCCESS_STATUSES.has(status);
}

/** Is `status` a recognized FAILURE status (anything not in success set)? */
function isFortressFailureStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    !FORTRESS_SUCCESS_STATUSES.has(status) &&
    status !== "indeterminate"
  );
}

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
      // JSON object stringified for transport, so parse it back. If
      // parsing fails OR the parsed object is missing the fields we
      // expect, surface that explicitly — silently returning {} makes
      // downstream consumers treat a malformed response as a healthy
      // empty status. (See Greptile P1 "Fortress status converts
      // malformed payloads into healthy-looking defaults".)
      let parsed: {
        persona?: string;
        fingerprint_state?: string;
        ua?: string;
        healthy?: boolean;
        error?: string;
      };
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch (err) {
        return {
          healthy: false,
          error: `fortress_status returned non-JSON payload: ${(err as Error).message}`,
        };
      }
      // Validate that the response looks like a fortress_status shape.
      // A missing `persona` field in a successful response is suspicious
      // — surface it instead of letting downstream see `undefined`.
      if (typeof parsed.persona !== "string") {
        return {
          healthy: false,
          error:
            "fortress_status response missing required `persona` field; " +
            "the bridge may have forwarded a different tool's result",
          ...parsed,
        };
      }
      // Reject failure statuses. The CLI only checks `status === "error"`,
      // so a tool returning {"persona":"...","status":"failed"} would
      // otherwise be reported as healthy. (See Greptile P1 "Failure
      // statuses pass validation".)
      if (
        "status" in parsed &&
        typeof parsed.status === "string" &&
        !isFortressSuccessStatus(parsed.status) &&
        parsed.status !== "indeterminate"
      ) {
        return {
          healthy: false,
          error: `fortress_status reported failure status: ${parsed.status}`,
          ...parsed,
        };
      }
      return { healthy: true, ...parsed };
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
    // plain non-JSON text, treat it as an indeterminate result and
    // surface that to the caller rather than silently synthesising
    // success. (See Greptile P1 "Invalid payload becomes successful result".)
    let parsed: { status?: string; persona_id?: string };
    try {
      parsed = JSON.parse(result) as typeof parsed;
    } catch {
      return {
        status: "indeterminate",
        persona_id: personaId,
        error:
          "fortress persona set returned a non-JSON payload; result not verified",
      };
    }
    if (typeof parsed.status !== "string") {
      return {
        status: "indeterminate",
        persona_id: parsed.persona_id ?? personaId,
        error:
          "fortress persona set response missing required `status` field; " +
          "operation may not have completed as expected",
      };
    }
    // Validate that status is a recognized success. The CLI's error
    // path checks ONLY `status === "error"`, so a tool returning
    // {"status":"failed"} or {"status":"rejected"} would otherwise
    // pass through as a successful persona change. Surface the
    // failure here so the CLI exits non-zero. (See Greptile P1
    // "Failure statuses pass validation".)
    if (!isFortressSuccessStatus(parsed.status)) {
      return {
        status: "error",
        persona_id: parsed.persona_id ?? personaId,
        error: `fortress persona set reported failure status: ${parsed.status}`,
      };
    }
    return {
      status: parsed.status,
      persona_id: parsed.persona_id ?? personaId,
    };
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
    // object inside that string. If it returns plain non-JSON text,
    // surface that as indeterminate rather than synthesising success.
    let parsed: { status?: string };
    try {
      parsed = JSON.parse(result) as typeof parsed;
    } catch {
      return {
        status: "indeterminate",
        error:
          "fortress reset returned a non-JSON payload; result not verified",
      };
    }
    // Don't synthesize `status: "ok"` when parsed JSON omits the status
    // field — same rationale as persona_set.
    if (typeof parsed.status !== "string") {
      return {
        status: "indeterminate",
        error:
          "fortress reset response missing required `status` field; " +
          "operation may not have completed as expected",
      };
    }
    if (!isFortressSuccessStatus(parsed.status)) {
      return {
        status: "error",
        error: `fortress reset reported failure status: ${parsed.status}`,
      };
    }
    return { status: parsed.status };
  } catch (error) {
    return {
      status: "error",
      error: `fortress reset failed: ${error}`,
    };
  }
}
