/**
 * Fortress-specific commands (status, persona set, reset).
 * These wrap tilion-mcp calls for stealth operations.
 */

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TILION_MCP_PORT = process.env.CHROME_DEVTOOLS_AXI_TMCP_PORT || "9223";
const TILION_MCP_BASE_URL = `http://127.0.0.1:${TILION_MCP_PORT}`;

export interface FortressStatusResponse {
  persona?: string;
  fingerprint_state?: string;
  ua?: string;
  error?: string;
}

export interface FortressPersonaSetRequest {
  persona_id: string;
}

export interface FortressPersonaSetResponse {
  status: string;
  persona_id?: string;
  error?: string;
}

export interface FortressResetResponse {
  status: string;
  error?: string;
}

/**
 * Call tilion-mcp HTTP endpoint with proper error handling.
 */
async function callTilionMcp(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${TILION_MCP_BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    throw new Error(
      `tilion-mcp call failed at ${url}: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * fortress status — show current Fortress persona and fingerprint state
 */
export async function fortressStatus(): Promise<FortressStatusResponse> {
  try {
    const result = await callTilionMcp("GET", "/fortress/status");
    return result as FortressStatusResponse;
  } catch (error) {
    return {
      error: `fortress status failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * fortress persona set <persona-id> — switch to a specific stealth persona
 */
export async function fortressPersonaSet(
  personaId: string,
): Promise<FortressPersonaSetResponse> {
  if (!personaId || personaId.trim().length === 0) {
    return {
      status: "error",
      error: "persona_id required",
    };
  }

  try {
    const result = await callTilionMcp("POST", "/fortress/persona/set", {
      persona_id: personaId,
    });
    return result as FortressPersonaSetResponse;
  } catch (error) {
    return {
      status: "error",
      error: `fortress persona set failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * fortress reset — clear all Fortress stealth state (fingerprint, persona, etc)
 */
export async function fortressReset(): Promise<FortressResetResponse> {
  try {
    const result = await callTilionMcp("POST", "/fortress/reset");
    return result as FortressResetResponse;
  } catch (error) {
    return {
      status: "error",
      error: `fortress reset failed: ${getErrorMessage(error)}`,
    };
  }
}
