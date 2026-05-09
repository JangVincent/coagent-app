import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startChatMcpHttpServer } from "../src/agent-runtime/mcp/http-server.ts";
import type { HubChatBridge } from "../src/agent-runtime/backends/types.ts";

interface ToolContent {
  type: string;
  text?: string;
}

function getText(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0] as ToolContent;
  return first?.text ?? "";
}

async function main() {
  const sentMessages: string[] = [];
  const bridge: HubChatBridge = {
    sendChatMessage(content) {
      sentMessages.push(content);
    },
    getCallCount() {
      return sentMessages.length;
    },
    getRoster() {
      return [
        { name: "alice", role: "human" },
        { name: "bot", role: "agent" },
      ];
    },
  };

  const server = await startChatMcpHttpServer({ agentName: "smoke", bridge });
  console.log(`server: ${server.url} (token=${server.bearerToken.slice(0, 8)}…)`);

  // 1. authorized client succeeds
  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${server.bearerToken}` },
    },
  });
  await client.connect(transport);
  console.log("connected");

  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(", "));
  const expected = ["get_participants", "send_chat"];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`missing tool: ${name}`);
  }

  // 2. send_chat round-trips and reaches the bridge
  const r1 = await client.callTool({
    name: "send_chat",
    arguments: { content: "hello @bot from smoke" },
  });
  if (getText(r1.content) !== "sent") {
    throw new Error(`send_chat unexpected reply: ${JSON.stringify(r1)}`);
  }
  if (sentMessages.length !== 1 || sentMessages[0] !== "hello @bot from smoke") {
    throw new Error(`bridge did not receive message: ${JSON.stringify(sentMessages)}`);
  }
  console.log("send_chat ok");

  // 3. get_participants reads the roster
  const r2 = await client.callTool({ name: "get_participants", arguments: {} });
  const t2 = getText(r2.content);
  if (!t2.includes("alice (human)") || !t2.includes("bot (agent)")) {
    throw new Error(`get_participants unexpected: ${t2}`);
  }
  console.log("get_participants ok");

  // 4. unauthenticated client is rejected
  const badClient = new Client({ name: "smoke-bad", version: "0.0.1" });
  const badTransport = new StreamableHTTPClientTransport(new URL(server.url));
  let rejected = false;
  try {
    await badClient.connect(badTransport);
  } catch (e) {
    rejected = true;
    console.log(`auth rejected (expected): ${(e as Error).message}`);
  }
  if (!rejected) throw new Error("unauthenticated request was not rejected");

  // 5. wrong-token client is rejected
  const wrongClient = new Client({ name: "smoke-wrong", version: "0.0.1" });
  const wrongTransport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: "Bearer wrong" } },
  });
  let wrongRejected = false;
  try {
    await wrongClient.connect(wrongTransport);
  } catch {
    wrongRejected = true;
  }
  if (!wrongRejected) throw new Error("wrong-token request was not rejected");
  console.log("wrong-token rejected ok");

  await client.close();
  await server.close();
  console.log("\nsmoke test PASSED");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("\nsmoke test FAILED:", e);
  process.exit(1);
});
