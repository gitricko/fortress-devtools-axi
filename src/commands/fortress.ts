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
    const result = await withTimeout(
      callTilionTool("fortress_status", {}),
      1000,
      `fortress status timed out waiting for the tilion-mcp bridge on port ${process.env.CHROME_DEVTOOLS_AXI_TMCP_PORT ?? 9223}`
    );
    return result as unknown as {
      persona?: string;
      fingerprint_state?: string;
      ua?: string;
    };
  } catch (error) {
    return {
      error: `fortress status failed: ${error}`,
    };
  }
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
export async function fortressPersonaSet(
  personaId: string,
): Promise<{
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
    return result as unknown as {
      status: string;
      persona_id?: string;
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
    return result as unknown as {
      status: string;
    };
  } catch (error) {
    return {
      status: "error",
      error: `fortress reset failed: ${error}`,
    };
  }
}
