// Reproduce: first turn registers MCP and uses send_chat; second turn
// uses `exec resume` and tries to use send_chat again. Verifies whether
// MCP servers configured via -c on the resume command are available.

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { startChatMcpHttpServer } from "../src/agent-runtime/mcp/http-server.ts";
import type { HubChatBridge } from "../src/agent-runtime/backends/types.ts";

function resolveCodex(): string {
  const triple =
    process.platform === "darwin" && process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : null;
  if (!triple) throw new Error("test only on darwin-arm64");
  const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
  const pkgJson = require.resolve(`${platformPkg}/package.json`);
  return path.join(path.dirname(pkgJson), "vendor", triple, "codex", "codex");
}

async function runOnce(args: string[], prompt: string, env: NodeJS.ProcessEnv) {
  const codex = resolveCodex();
  const child = spawn(codex, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(prompt);
  child.stdin.end();

  child.stderr.on("data", (c: Buffer) => {
    process.stderr.write(`[stderr] ${c.toString()}`);
  });

  const events: any[] = [];
  let threadId: string | null = null;
  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    events.push(ev);
    if (ev.type === "thread.started") threadId = ev.thread_id;
    console.log(`[ev] ${ev.type}${ev.item?.type ? `/${ev.item.type}` : ""}${
      ev.item?.tool ? ` tool=${ev.item.tool}` : ""
    }${ev.item?.error ? ` ERROR=${JSON.stringify(ev.item.error)}` : ""}`);
    if (ev.type === "turn.failed" || ev.type === "error") {
      console.log(`  full: ${JSON.stringify(ev)}`);
    }
  }
  await new Promise<void>((r) => child.once("close", () => r()));
  return { threadId, events };
}

async function main() {
  const calls: string[] = [];
  const bridge: HubChatBridge = {
    sendChatMessage(c) {
      calls.push(c);
      console.log(`>>> bridge received: ${c}`);
    },
    getCallCount() {
      return calls.length;
    },
    getRoster() {
      return [{ name: "v", role: "human" }];
    },
  };
  const mcp = await startChatMcpHttpServer({ agentName: "probe-resume", bridge });
  console.log(`[host] mcp at ${mcp.url}`);

  const env = { ...process.env, COAGENT_MCP_TOKEN: mcp.bearerToken };
  const sharedOpts = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `mcp_servers.coagent_chat.url="${mcp.url}"`,
    "-c",
    `mcp_servers.coagent_chat.bearer_token_env_var="COAGENT_MCP_TOKEN"`,
  ];

  console.log("\n=== TURN 1: fresh exec ===");
  const turn1 = await runOnce(
    ["exec", ...sharedOpts, "--cd", process.cwd(), "-"],
    `Call mcp__coagent_chat__send_chat with content "turn1-ok". Then end.`,
    env,
  );
  console.log(`[host] thread=${turn1.threadId}, bridge calls=${calls.length}`);
  if (!turn1.threadId) throw new Error("no thread id from turn 1");

  console.log("\n=== TURN 2: exec resume ===");
  const turn2 = await runOnce(
    ["exec", "resume", ...sharedOpts, turn1.threadId, "-"],
    `Call mcp__coagent_chat__send_chat with content "turn2-ok". Then end.`,
    env,
  );
  console.log(
    `[host] turn2 thread=${turn2.threadId}, total bridge calls=${calls.length}`,
  );

  await mcp.close();
  console.log("\nbridge log:", calls);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
