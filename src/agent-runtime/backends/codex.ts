import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentBackend,
  type BackendCapabilities,
  type BackendStatus,
  type ControlResult,
  type HubChatBridge,
  type TurnOutcome,
  type TurnRequest,
} from "./types.ts";
import { startChatMcpHttpServer, type ChatMcpHttpServer } from "../mcp/http-server.ts";

const TARGET_TRIPLE: Record<string, Record<string, string>> = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-musl", x64: "x86_64-unknown-linux-musl" },
  win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
};

// `@openai/codex` ships the Rust CLI as a per-platform optionalDependency
// (e.g. `@openai/codex-darwin-arm64/vendor/<triple>/codex/codex`). The npm
// shim resolves and spawns it; we replicate that resolution here so we can
// invoke the binary directly with full control over args, stdin, and abort.
function resolveCodexBinary(): string | undefined {
  const triple = TARGET_TRIPLE[process.platform]?.[process.arch];
  if (!triple) return undefined;
  const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  try {
    let pkgJson = require.resolve(`${platformPkg}/package.json`);
    if (pkgJson.includes(`${path.sep}app.asar${path.sep}`)) {
      pkgJson = pkgJson.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`,
      );
    }
    const candidate = path.join(path.dirname(pkgJson), "vendor", triple, "codex", exe);
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return undefined;
}

const KILL_GRACE_MS = 1500;

// Walk a codex event/error payload and surface the deepest human-readable
// `message` field. Codex wraps API errors as
// `{type:"error",status:400,error:{type:"invalid_request_error",message:"..."}}`
// and turn.failed sometimes carries the same shape one level deeper.
function findDeepestMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  // Prefer a nested error.message before the surface-level message — for
  // codex's API errors the nested one is the user-facing text.
  const nested = findDeepestMessage(obj.error);
  if (nested) return nested;
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  return null;
}

function extractFailure(event: Record<string, unknown>, fallback: string): string {
  const msg = findDeepestMessage(event);
  if (msg) {
    const status = typeof event.status === "number" ? ` (HTTP ${event.status})` : "";
    return `${fallback}: ${msg}${status}`;
  }
  return `${fallback}: ${JSON.stringify(event)}`;
}

export interface CodexBackendOptions {
  agentName: string;
  cwd: string;
  initialModel?: string;
  bridge: HubChatBridge;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  message?: string;
  error?: string;
  // turn.failed and error events have shifted shape across codex versions;
  // we capture the whole object as a fallback for diagnostics.
  [key: string]: unknown;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  name?: string;
  tool_name?: string;
  server?: string;
}

export async function createCodexBackend(opts: CodexBackendOptions): Promise<AgentBackend> {
  const codexBinary = resolveCodexBinary();
  if (codexBinary) {
    console.log(`[${opts.agentName}] codex binary: ${codexBinary}`);
  } else {
    console.warn(
      `[${opts.agentName}] could not resolve native codex binary; ensure @openai/codex is installed`,
    );
  }

  // One MCP HTTP server per agent — provides send_chat / get_participants
  // to codex via `mcp_servers.coagent_chat.url`.
  const mcp: ChatMcpHttpServer = await startChatMcpHttpServer({
    agentName: opts.agentName,
    bridge: opts.bridge,
  });
  console.log(`[${opts.agentName}] codex MCP bridge: ${mcp.url}`);

  let sessionId: string | null = null;
  let model: string | undefined = opts.initialModel;
  let totalTurns = 0;

  function buildArgs(resumeSid: string | null): string[] {
    // Codex 0.130.x auto-rejects MCP tool calls under any approval_policy
    // value (incl. "never") in non-interactive mode (see openai/codex#15437).
    // The only way to let the agent invoke our send_chat tool is the full
    // bypass flag — same trust level as Claude's `bypassPermissions` mode.
    // Once codex grows a per-MCP allowlist this can become user-controllable
    // (BackendCapabilities.mode = true again).

    // `codex exec` and `codex exec resume` accept different flag sets.
    // `resume` does NOT accept --cd or --sandbox: the cwd and sandbox
    // policy are pinned to the original session. Options shared by both
    // (--json, --skip-git-repo-check, --dangerously-bypass-…, -c, --model)
    // are appended after positional args separately for each branch.
    const sharedOpts = [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `mcp_servers.coagent_chat.url="${mcp.url}"`,
      "-c",
      `mcp_servers.coagent_chat.bearer_token_env_var="COAGENT_MCP_TOKEN"`,
      ...(model ? ["--model", model] : []),
    ];

    if (resumeSid) {
      // exec resume [OPTIONS] [SESSION_ID] [PROMPT]
      // Read PROMPT from stdin via "-".
      return ["exec", "resume", ...sharedOpts, resumeSid, "-"];
    }
    // exec [OPTIONS] [PROMPT]
    // Fresh session: also pin --cd to our project root.
    return ["exec", ...sharedOpts, "--cd", opts.cwd, "-"];
  }

  function spawnCodex(args: string[], abort: AbortSignal): ChildProcess {
    if (!codexBinary) {
      throw new Error("codex binary not found — install @openai/codex");
    }
    const child = spawn(codexBinary, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        COAGENT_MCP_TOKEN: mcp.bearerToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, KILL_GRACE_MS).unref();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });
    return child;
  }

  function handleEvent(
    event: CodexEvent,
    onActivity: TurnRequest["onActivity"],
    onSessionId: TurnRequest["onSessionId"],
  ): { resultText?: string; failure?: string } {
    switch (event.type) {
      case "thread.started": {
        if (event.thread_id) {
          sessionId = event.thread_id;
          onSessionId(event.thread_id);
        }
        return {};
      }
      case "turn.started":
        onActivity("thinking");
        return {};
      case "item.started": {
        const item = event.item;
        if (!item) return {};
        const t = item.type;
        if (t === "command_execution") {
          onActivity("tool", "Bash");
        } else if (t === "mcp_tool_call") {
          const toolName = item.name ?? item.tool_name ?? "mcp";
          if (!String(toolName).endsWith("send_chat")) {
            onActivity("tool", String(toolName));
          }
        } else if (t === "file_change") {
          onActivity("tool", "Edit");
        } else if (t === "web_search") {
          onActivity("tool", "WebSearch");
        } else if (t === "agent_message" || t === "reasoning") {
          onActivity("thinking");
        }
        return {};
      }
      case "item.completed": {
        const item = event.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          const trimmed = item.text.trim();
          if (trimmed.length > 0) return { resultText: trimmed };
        }
        return {};
      }
      case "turn.completed":
        return {};
      case "turn.failed": {
        return { failure: extractFailure(event, "turn failed") };
      }
      case "error": {
        return { failure: extractFailure(event, "codex error") };
      }
      default:
        if (process.env.COAGENT_CODEX_DEBUG === "1") {
          process.stderr.write(`[codex event] ${JSON.stringify(event)}\n`);
        }
        return {};
    }
  }

  async function runOnce(req: TurnRequest, prompt: string): Promise<TurnOutcome> {
    const args = buildArgs(sessionId);
    const child = spawnCodex(args, req.abort.signal);

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderrBuf += s;
      // Surface to the agent log buffer for debugging.
      process.stderr.write(`[${opts.agentName} codex] ${s}`);
    });

    let resultText = "";
    let failure: string | null = null;
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      const debug = process.env.COAGENT_CODEX_DEBUG === "1";
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: CodexEvent;
        try {
          event = JSON.parse(trimmed) as CodexEvent;
        } catch {
          if (debug) process.stderr.write(`[codex non-json] ${trimmed}\n`);
          continue;
        }
        if (debug) {
          process.stderr.write(`[codex jsonl] ${trimmed}\n`);
        }
        const r = handleEvent(event, req.onActivity, req.onSessionId);
        if (r.resultText) resultText = r.resultText;
        if (r.failure) failure = r.failure;
      }
    }

    const exitCode: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("close", (code) => resolve(code));
    });

    if (req.abort.signal.aborted) {
      throw new Error("aborted");
    }
    if (failure) throw new Error(failure);
    if (exitCode !== 0) {
      const tail = stderrBuf.trim().split("\n").slice(-3).join(" / ");
      throw new Error(`codex exited with code ${exitCode}${tail ? `: ${tail}` : ""}`);
    }

    totalTurns += 1;
    return { resultText, costUsd: 0 };
  }

  const capabilities: BackendCapabilities = {
    kindLabel: "Codex",
    // Codex prefixes MCP tool names as `mcp__<server>__<tool>` in the
    // model's tool registry. The agent must use this exact name to call
    // the chat delivery tool.
    chatToolName: "mcp__coagent_chat__send_chat",
    compact: false,
    usage: false,
    effort: false,
    model: true,
    // Codex auto-rejects MCP tool calls under any approval_policy except via
    // --dangerously-bypass-approvals-and-sandbox (openai/codex#15437). We
    // unconditionally pass that flag so send_chat works, which means any
    // permission mode the user sets here would be silently ignored. Mark
    // unsupported until codex grows a per-MCP allowlist.
    mode: false,
  };

  return {
    capabilities,

    async runTurn(req: TurnRequest): Promise<TurnOutcome> {
      return runOnce(req, req.prompt);
    },

    setModel(value: string | undefined): ControlResult {
      const prev = model ?? "(codex default)";
      if (!value || value === "default" || value === "clear" || value === "reset") {
        model = undefined;
      } else {
        model = value;
      }
      return {
        ok: true,
        info: `${prev} → ${model ?? "(codex default)"} (applies to next turn)`,
      };
    },

    // setMode intentionally omitted — see capabilities.mode comment above.

    getSessionId() {
      return sessionId;
    },
    setSessionId(id: string | null) {
      sessionId = id;
    },

    status(): BackendStatus {
      return {
        model: model ?? "(codex default)",
        effort: "(n/a)",
        // Always bypass — see capabilities.mode comment for why this isn't
        // user-tunable yet.
        mode: "bypass-approvals-and-sandbox (forced)",
        session: sessionId,
        extra: {
          turns: String(totalTurns),
          mcp: mcp.url,
        },
      };
    },
  };
}
