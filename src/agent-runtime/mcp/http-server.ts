import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
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

export async function startChatMcpHttpServer(
  opts: StartChatMcpHttpServerOptions,
): Promise<ChatMcpHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const bearerToken = randomBytes(24).toString("hex");

  const server = new McpServer({ name: "agent-chat", version: "1.0.0" });
  server.registerTool(
    "send_chat",
    {
      description: SEND_CHAT_DESCRIPTION,
      inputSchema: SEND_CHAT_INPUT_SHAPE,
    },
    makeSendChatHandler({ agentName: opts.agentName, bridge: opts.bridge }),
  );
  server.registerTool(
    "get_participants",
    {
      description: GET_PARTICIPANTS_DESCRIPTION,
      inputSchema: GET_PARTICIPANTS_INPUT_SHAPE,
    },
    makeGetParticipantsHandler({ agentName: opts.agentName, bridge: opts.bridge }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith(MCP_PATH)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${bearerToken}`) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("unauthorized");
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
            res.end(`invalid json: ${(e as Error).message}`);
            return;
          }
        }
      }
      try {
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String((e as Error).message ?? e));
        }
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
    addr && typeof addr === "object" && "port" in addr ? (addr as { port: number }).port : 0;
  if (!port) throw new Error("failed to bind chat MCP HTTP server to a port");

  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    bearerToken,
    port,
    async close() {
      try {
        await server.close();
      } catch {}
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
