import http from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  GET_PARTICIPANTS_DESCRIPTION,
  GET_PARTICIPANTS_INPUT_SHAPE,
  SEND_CHAT_DESCRIPTION,
  SEND_CHAT_INPUT_SHAPE,
  makeGetParticipantsHandler,
  makeSendChatHandler,
  type ChatToolDeps,
} from "./chat-tools.ts";

export interface ChatMcpHttpServer {
  /** Full URL the agent CLI should hit, e.g. `http://127.0.0.1:54123/mcp`. */
  url: string;
  /** Random bearer token required in `Authorization: Bearer <token>` header. */
  bearerToken: string;
  port: number;
  close(): Promise<void>;
}

export interface StartChatMcpHttpServerOptions extends ChatToolDeps {
  /** Override the listen host (default: 127.0.0.1). */
  host?: string;
}

const MCP_PATH = "/mcp";

// Build a fresh McpServer with chat tools registered. The deps closure
// (in particular `bridge`) is shared across instances, so each request's
// server forwards to the same hub-side state.
function buildServer(deps: ChatToolDeps): McpServer {
  const server = new McpServer({ name: "agent-chat", version: "1.0.0" });
  server.registerTool(
    "send_chat",
    {
      description: SEND_CHAT_DESCRIPTION,
      inputSchema: SEND_CHAT_INPUT_SHAPE,
    },
    makeSendChatHandler(deps),
  );
  server.registerTool(
    "get_participants",
    {
      description: GET_PARTICIPANTS_DESCRIPTION,
      inputSchema: GET_PARTICIPANTS_INPUT_SHAPE,
    },
    makeGetParticipantsHandler(deps),
  );
  return server;
}

export async function startChatMcpHttpServer(
  opts: StartChatMcpHttpServerOptions,
): Promise<ChatMcpHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const bearerToken = randomBytes(24).toString("hex");
  const deps: ChatToolDeps = { agentName: opts.agentName, bridge: opts.bridge };

  const httpServer = http.createServer(async (req, res) => {
    const dbg = process.env.COAGENT_MCP_DEBUG === "1";
    if (dbg) {
      console.error(
        `[mcp-http] ${req.method} ${req.url} auth=${req.headers.authorization ? "present" : "missing"}`,
      );
    }
    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${bearerToken}`) {
      if (dbg) {
        console.error(
          `[mcp-http] 401: got "${auth ?? "(none)"}", expected "Bearer ${bearerToken.slice(0, 8)}…"`,
        );
      }
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("unauthorized");
      return;
    }

    // Stateless mode (per the @modelcontextprotocol/sdk simpleStatelessStreamableHttp
    // example): each POST builds a fresh McpServer + transport, handles the
    // request, then closes both. This lets `codex exec resume`, which spawns
    // a brand-new codex process per turn, reconnect cleanly without needing
    // session-id continuity from the previous turn's transport.
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: unknown;
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
                id: null,
              }),
            );
            return;
          }
        }
      }

      const server = buildServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (dbg) console.error(`[mcp-http] handler error:`, e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: String((e as Error).message ?? e) },
              id: null,
            }),
          );
        }
      } finally {
        // Tear down per-request server/transport when the response closes.
        const cleanup = () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        };
        if (res.writableEnded) cleanup();
        else res.on("close", cleanup);
      }
    });
    req.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end("request error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const port =
    addr && typeof addr === "object" && "port" in addr
      ? (addr as { port: number }).port
      : 0;
  if (!port) throw new Error("failed to bind chat MCP HTTP server to a port");

  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    bearerToken,
    port,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
