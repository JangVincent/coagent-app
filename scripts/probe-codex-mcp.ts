// Integration probe: start the in-process HTTP MCP server, spawn codex
// pointing at it, and dump every JSONL event so we can see the actual
// tool names and prefixes codex assigns to our chat tools.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { startChatMcpHttpServer } from "../src/agent-runtime/mcp/http-server.ts";
import type { HubChatBridge } from "../src/agent-runtime/backends/types.ts";

const TARGET_TRIPLE: Record<string, Record<string, string>> = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
};

function resolveCodex(): string {
  const triple = TARGET_TRIPLE[process.platform]?.[process.arch];
  const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
  const pkgJson = require.resolve(`${platformPkg}/package.json`);
  return path.join(path.dirname(pkgJson), "vendor", triple!, "codex", "codex");
}

async function main() {
  const codex = resolveCodex();
  if (!fs.existsSync(codex)) throw new Error(`codex not at ${codex}`);

  const bridge: HubChatBridge = {
    sendChatMessage(content) {
      console.log(`[bridge] received: ${content}`);
    },
    getCallCount() {
      return 0;
    },
    getRoster() {
      return [
        { name: "vincent", role: "human" },
        { name: "claude-bot", role: "agent" },
      ];
    },
  };
  const mcp = await startChatMcpHttpServer({ agentName: "probe", bridge });
  console.log(`[host] mcp at ${mcp.url}`);

  const args = [
    "exec",
    "-",
    "--json",
    "--cd",
    process.cwd(),
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.coagent_chat.url="${mcp.url}"`,
    "-c",
    `mcp_servers.coagent_chat.bearer_token_env_var="COAGENT_MCP_TOKEN"`,
  ];

  const child = spawn(codex, args, {
    env: { ...process.env, COAGENT_MCP_TOKEN: mcp.bearerToken },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[codex stderr] ${chunk.toString()}`);
  });

  const prompt = `Call the tool named exactly "mcp__coagent_chat__send_chat" with arguments {"content":"probe-pass-from-codex"}. Then end the turn.`;
  child.stdin.write(prompt);
  child.stdin.end();

  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Print interesting events
    if (event.type === "thread.started") {
      console.log(`[codex] thread=${event.thread_id}`);
    } else if (event.type === "item.started" || event.type === "item.completed") {
      const t = event.item?.type;
      if (t === "agent_message") {
        console.log(`[codex] message:\n${event.item.text}\n`);
      } else if (t === "mcp_tool_call") {
        console.log(`[codex] mcp_tool_call event:`, JSON.stringify(event.item, null, 2));
      } else {
        console.log(`[codex] item ${event.type} type=${t}`);
      }
    } else if (event.type === "turn.completed") {
      console.log(`[codex] turn.completed usage=${JSON.stringify(event.usage)}`);
    } else if (event.type === "turn.failed" || event.type === "error") {
      console.log(`[codex] FAILURE:`, JSON.stringify(event));
    }
  }

  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await mcp.close();
  console.log("done");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
