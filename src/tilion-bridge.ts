import { BridgeContentBlock, BridgeCallPayload } from "./tilion-bridge-script.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client";
import { Server } from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { resolveSessionName, resolveTilionSessionPort } from "./sessions.js";
import { getErrorMessage, buildTransportArgs } from "./bridge.js";
import { isProcessAlive } from "./client.js";
import { isRequestAllowed } from "./bridge.js";
import {
  writeTilionPidFile,
  removeTilionPidFile,
  resolveTilionMcpSpec,
  TILION_BRIDGE_PORT_IN_USE_EXIT_CODE,
} from "./tilion-bridge-script.js";

/**
 * Probe interface for tilion-mcp prerequisites.
 */
export async function probeTilionPrerequisites(): Promise<void> {
  // Implementation for checking tilion-mcp availability
}

export async function runTilionBridge(
  port: number = resolveTilionSessionPort(),
): Promise<void> {
  // Probe tilion-mcp prerequisites before spawning
  await probeTilionPrerequisites();

  // Build transport args for tilion-mcp
  const mcpArgs = buildTransportArgs();
  // Resolve the tilion-mcp spec (pinned version, env-overridable — see
  // resolveTilionMcpSpec for the override order and rationale).
  const tilionSpec = resolveTilionMcpSpec();

  const transport = new StdioClientTransport({
    command: tilionSpec.command,
    args: [...tilionSpec.args, ...mcpArgs.slice(2)],
  });
  const client = new Client({ name: "tilion-mcp-bridge", version: "1.0.0" });
  await client.connect(transport);

  const sessionName = resolveSessionName();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Handle /health, /tools, /call requests similar to chrome bridge
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      try {
        const deep = req.url?.includes("deep=1");
        if (deep) {
          // Deep health check implementation
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", session: sessionName }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: "Not connected" }));
      }
      return;
    }

    if (req.method === "GET" && req.url === "/tools") {
      // List available tools
      try {
        // For tilion, we'll implement a basic listing
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: [] }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to list tools" }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      // DNS-rebinding protection: the sibling chrome bridge enforces Host /
      // Origin checks on every request. Mirror that here — without it, a
      // malicious page could rebind its origin to the predictable local
      // bridge port and submit arbitrary tool calls (fortress reset,
      // persona-set, etc.) bypassing any browser-side sandbox.
      if (!isRequestAllowed(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "forbidden: bridge requests must originate from loopback",
          }),
        );
        return;
      }
      // Handle tool calls
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const result = await client.callTool({
            name: payload.name,
            arguments: payload.args,
          });
          // Extract text from result. MCP tool results may have
          // `isError: true` indicating a TOOL-level failure (the call
          // itself succeeded but the tool reported an error). Surface
          // that as a 500 so the client wrapper can distinguish
          // bridge-level failures from tool-level failures. Without
          // this, persona-set returning {"isError": true, "content":
          // "persona not found"} would be reported as a SUCCESSFUL
          // persona change. (See Greptile P1 #7.)
          const text = extractToolText(result.content);
          if (result.isError === true) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: text || "tool reported an error" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: text }));
          }
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: getErrorMessage(error) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, "127.0.0.1", () => {
    // Use the tilion-specific PID file (tilion-bridge.pid), NOT the shared
    // chrome bridge's `bridge.pid`. The two bridges have different PID
    // records so ensureTilionBridge can find this process without
    // clobbering the chrome bridge's PID (and vice-versa).
    // If ownership is contested by a live bridge, writeTilionPidFile
    // throws — we let the throw propagate so the bridge exits with a
    // clear conflict message rather than continuing to serve traffic
    // on a port it doesn't own. (See Greptile P1 "Refused PID write
    // claims ownership".)
    writeTilionPidFile(port, sessionName);
    // Mark ownership so the exit handler knows it may safely remove
    // the PID file. If `listen` later errors (EADDRINUSE), we never
    // reach here and the loser process will not delete the winner's
    // record. See #7 in Greptile review.
    ownsPidFile = true;
  });
  // EADDRINUSE handling: another process (e.g. chrome bridge on a
  // nearby port, or a sibling tilion bridge on the deterministic port)
  // is already bound. Exit with a distinct code so the client can
  // distinguish "port busy" from generic startup failure.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[tilion-bridge] port ${port} already in use; another bridge owns it\n`,
      );
      process.exit(TILION_BRIDGE_PORT_IN_USE_EXIT_CODE);
    }
    throw err;
  });

  // Shutdown handling
  let shuttingDown = false;
  // Tracks whether THIS process successfully bound the port and wrote
  // the PID file. Only that process is allowed to remove the PID file
  // on exit — otherwise, if two CLI processes race to bind the same
  // deterministic port and the loser still calls removeTilionPidFile
  // unconditionally on exit, it would delete the WINNER's PID record,
  // making the running bridge undiscoverable to later commands.
  let ownsPidFile = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (ownsPidFile) removeTilionPidFile(sessionName);
    server.close();
    client.close();
    transport.close();
    process.exit(0);
  };

  process.on("exit", () => {
    if (ownsPidFile) removeTilionPidFile(sessionName);
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function extractToolText(content: unknown): string {
  // MCP tool-call responses can come in several shapes:
  //   1. undefined / null                       (tool returned no content)
  //   2. string                                  (older / non-standard MCP servers)
  //   3. array of content blocks                 (NEW: some servers return the
  //                                              content array at the top
  //                                              level — `{type:"text",...}[]
  //                                              instead of `{content:[...]}`)
  //   4. object with `content` array of blocks  (canonical MCP shape)
  //
  // The earlier versions only handled #1 and #4, silently returning "" or
  // a JSON-encoded string on #2/#3. That made fortress status / persona-set
  // / reset report wrong data on successful tool calls.

  if (content == null) return "";
  if (typeof content === "string") return content;

  // Helper to extract text from an array of content blocks (used by #3 and #4).
  const fromBlocks = (blocks: unknown[]): string =>
    blocks
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n");

  // Shape #3: top-level array of content blocks.
  if (Array.isArray(content)) {
    return fromBlocks(content);
  }

  // Shape #4: object with a `content` array of blocks.
  if (typeof content === "object" && "content" in content) {
    const blocks = (content as { content?: unknown }).content;
    if (Array.isArray(blocks)) {
      return fromBlocks(blocks);
    }
  }

  // Last-resort: stringify so the caller at least sees something useful
  // rather than a silent empty result.
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}
