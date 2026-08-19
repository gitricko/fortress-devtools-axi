import { BridgeContentBlock, BridgeCallPayload } from "./tilion-bridge-script.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client";
import { Server } from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { resolveSessionPort, resolveSessionName } from "./sessions.js";
import { writePidFile, removePidFile, getErrorMessage } from "./bridge.js";
import { buildTransportArgs } from "./bridge.js";
import { isProcessAlive } from "./client.js";

/**
 * Probe interface for tilion-mcp prerequisites.
 */
export async function probeTilionPrerequisites(): Promise<void> {
  // Implementation for checking tilion-mcp availability
}

export async function runTilionBridge(port: number = resolveSessionPort()): Promise<void> {
  // Probe tilion-mcp prerequisites before spawning
  await probeTilionPrerequisites();

  // Build transport args for tilion-mcp
  const mcpArgs = buildTransportArgs();
  // For tilion, we need to use the tilion-mcp package instead of chrome-devtools-mcp
  // Since the package name is different, we adjust the args
  const tilionMcpPath = process.env.CHROME_DEVTOOLS_AXI_TILION_MCP_PATH;

  let transportSpec: { command: string; args: string[] };

  if (tilionMcpPath) {
    transportSpec = {
      command: process.execPath,
      args: [tilionMcpPath, ...mcpArgs],
    };
  } else {
    // Auto-detect tilion-mcp globally or use npx
    transportSpec = {
      command: "npx",
      args: ["-y", "tilion-mcp@latest", ...mcpArgs.slice(2)],
    };
  }

  const transport = new StdioClientTransport(transportSpec);
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
          // Extract text from result
          const text = extractToolText(result.content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: text }));
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
    writePidFile(port);
  });

  // Shutdown handling
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removePidFile();
    server.close();
    client.close();
    transport.close();
    process.exit(0);
  };

  process.on("exit", () => {
    removePidFile();
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function extractToolText(content: unknown): string {
  if (!content || typeof content !== "object" || !("content" in content)) {
    return "";
  }
  const result = content as { content?: unknown[] };
  if (!Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter((block: any) => block.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}
