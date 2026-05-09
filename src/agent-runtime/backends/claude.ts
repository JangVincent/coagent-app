import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import {
  EFFORT_LEVELS,
  ResumeFailedError,
  type AgentBackend,
  type BackendCapabilities,
  type BackendStatus,
  type ControlResult,
  type ControlRunCtx,
  type EffortLevel,
  type HubChatBridge,
  type PermissionMode,
  type TurnOutcome,
  type TurnRequest,
} from "./types.ts";
import { accumulateModelUsage, formatUsage } from "../helpers/usage.ts";
import {
  GET_PARTICIPANTS_DESCRIPTION,
  GET_PARTICIPANTS_INPUT_SHAPE,
  SEND_CHAT_DESCRIPTION,
  SEND_CHAT_INPUT_SHAPE,
  makeGetParticipantsHandler,
  makeSendChatHandler,
} from "../mcp/chat-tools.ts";

// SDK 0.2.x defaults to "isolation mode" which silently skips CLAUDE.md,
// .claude/skills, .claude/agents, .claude/commands, hooks, and settings.
// Including 'project' is required for CLAUDE.md.
const SETTING_SOURCES = ["user", "project", "local"] as const;

const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  ask: "default",
  normal: "default",
  accept: "acceptEdits",
  acceptedits: "acceptEdits",
  acceptEdits: "acceptEdits",
  edits: "acceptEdits",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
  auto: "bypassPermissions",
  plan: "plan",
};

// SDK 0.2.x ships the Claude Code CLI as a per-platform native binary
// (e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64/claude). The SDK's
// internal resolver returns a path inside app.asar in packaged builds,
// and Electron's automatic asar→unpacked translation does not fire for
// child_process.spawn from a utilityProcess context. Resolve ourselves
// and rewrite to the unpacked sibling.
function resolveClaudeBinary(): string | undefined {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates =
    process.platform === "linux"
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/${exe}`,
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/${exe}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`];
  for (const c of candidates) {
    try {
      let resolved = require.resolve(c);
      if (resolved.includes(`${path.sep}app.asar${path.sep}`)) {
        resolved = resolved.replace(
          `${path.sep}app.asar${path.sep}`,
          `${path.sep}app.asar.unpacked${path.sep}`,
        );
      }
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }
  return undefined;
}

export interface ClaudeBackendOptions {
  agentName: string;
  cwd: string;
  initialModel?: string;
  initialEffort?: EffortLevel;
  initialPermissionMode: PermissionMode;
  initialSessionId?: string;
  bridge: HubChatBridge;
}

export function createClaudeBackend(opts: ClaudeBackendOptions): AgentBackend {
  const claudeBinaryPath = resolveClaudeBinary();
  if (claudeBinaryPath) {
    console.log(`[${opts.agentName}] claude binary: ${claudeBinaryPath}`);
  } else {
    console.warn(
      `[${opts.agentName}] could not resolve native claude binary; SDK will fall back`,
    );
  }

  let sessionId: string | null = opts.initialSessionId ?? null;
  let model: string | undefined = opts.initialModel;
  let effort: EffortLevel | undefined = opts.initialEffort;
  let permissionMode: PermissionMode = opts.initialPermissionMode;
  let totalCost = 0;
  let totalTurns = 0;

  const toolDeps = { agentName: opts.agentName, bridge: opts.bridge };
  const sendChatTool = tool(
    "send_chat",
    SEND_CHAT_DESCRIPTION,
    SEND_CHAT_INPUT_SHAPE,
    makeSendChatHandler(toolDeps),
  );
  const getParticipantsTool = tool(
    "get_participants",
    GET_PARTICIPANTS_DESCRIPTION,
    GET_PARTICIPANTS_INPUT_SHAPE,
    makeGetParticipantsHandler(toolDeps),
  );
  const chatServer = createSdkMcpServer({
    name: "agent-chat",
    version: "1.0.0",
    tools: [sendChatTool, getParticipantsTool],
  });

  function buildOptions(abort: AbortController) {
    return {
      cwd: opts.cwd,
      permissionMode,
      resume: sessionId ?? undefined,
      abortController: abort,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
      settingSources: [...SETTING_SOURCES],
      mcpServers: {
        "agent-chat": {
          type: "sdk" as const,
          name: "agent-chat",
          instance: chatServer.instance,
        },
      },
    };
  }

  const capabilities: BackendCapabilities = {
    kindLabel: "Claude Code",
    chatToolName: "send_chat",
    compact: true,
    usage: true,
    effort: true,
    model: true,
    mode: true,
  };

  return {
    capabilities,

    async runTurn(req: TurnRequest): Promise<TurnOutcome> {
      let resultText = "";
      let cost = 0;
      try {
        const res = query({
          prompt: req.prompt,
          options: buildOptions(req.abort),
        });
        for await (const msg of res) {
          if ("session_id" in msg && msg.session_id) {
            sessionId = msg.session_id;
            req.onSessionId(msg.session_id);
          }
          if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text?.trim()) {
                  req.onActivity("thinking");
                } else if (
                  block.type === "tool_use" &&
                  !String(block.name).endsWith("send_chat")
                ) {
                  req.onActivity("tool", String(block.name));
                }
              }
            }
          } else if (msg.type === "result") {
            const r = msg as any;
            if (typeof r.result === "string" && r.result.trim().length > 0) {
              resultText = r.result.trim();
            }
            if (typeof r.total_cost_usd === "number") cost += r.total_cost_usd;
            accumulateModelUsage(r.modelUsage);
          }
        }
      } catch (e: any) {
        const isResumeError =
          sessionId &&
          (String(e?.message ?? e).includes("exited with code") ||
            String(e?.message ?? e).includes("session"));
        if (isResumeError && !req.abort.signal.aborted) {
          // Caller will reset host-side intro state and re-queue.
          sessionId = null;
          throw new ResumeFailedError(e?.message ?? String(e));
        }
        throw e;
      }
      totalCost += cost;
      totalTurns += 1;
      return { resultText, costUsd: cost };
    },

    async compact(ctx: ControlRunCtx): Promise<ControlResult> {
      if (!sessionId) return { ok: false, info: "no active session to compact" };
      console.log(`[${opts.agentName}] /compact starting (session=${sessionId})`);
      ctx.onActivity("compact");
      let info = "done";
      let acked = false;
      try {
        const res = query({
          prompt: "/compact",
          options: buildOptions(ctx.abort),
        });
        for await (const msg of res) {
          if ("session_id" in msg && msg.session_id) {
            sessionId = msg.session_id;
            ctx.onSessionId(msg.session_id);
          }
          if (
            msg.type === "system" &&
            (msg as { subtype?: string }).subtype === "compact_boundary"
          ) {
            const meta = (msg as { compact_metadata?: { pre_tokens?: number } })
              .compact_metadata;
            info = `compacted (pre=${meta?.pre_tokens ?? "?"} tokens)`;
            acked = true;
          }
        }
        return { ok: true, info: acked ? info : "done" };
      } catch (e: any) {
        if (ctx.abort.signal.aborted) return { ok: false, info: "aborted" };
        return { ok: false, info: `error: ${e?.message ?? String(e)}` };
      }
    },

    async usage(ctx: ControlRunCtx): Promise<ControlResult> {
      ctx.onActivity("usage");
      let resultText = "";
      let failure: string | null = null;
      try {
        const res = query({
          prompt: "/usage",
          options: buildOptions(ctx.abort),
        });
        for await (const msg of res) {
          if ("session_id" in msg && msg.session_id) {
            sessionId = msg.session_id;
            ctx.onSessionId(msg.session_id);
          }
          if (msg.type === "result") {
            const r = msg as { result?: string };
            if (typeof r.result === "string" && r.result.length > 0) {
              resultText = r.result.trim();
            }
          }
        }
      } catch (e: any) {
        failure = ctx.abort.signal.aborted
          ? "aborted"
          : `CLI /usage failed: ${e?.message ?? String(e)}`;
      }
      const totals = formatUsage(totalCost, totalTurns);
      if (failure) return { ok: true, info: `${totals}\n(${failure})` };
      const combined = resultText
        ? `${totals}\n${resultText}`
        : `${totals}\n(CLI /usage returned no data)`;
      return { ok: true, info: combined };
    },

    setModel(value: string | undefined): ControlResult {
      const prev = model ?? "(sdk default)";
      if (!value || value === "default" || value === "clear" || value === "reset") {
        model = undefined;
      } else {
        model = value;
      }
      return {
        ok: true,
        info: `${prev} → ${model ?? "(sdk default)"} (applies to next turn)`,
      };
    },

    setEffort(value: string | undefined): ControlResult {
      const prev = effort ?? "(sdk default)";
      if (!value || value === "default" || value === "clear" || value === "reset") {
        effort = undefined;
        return {
          ok: true,
          info: `${prev} → (sdk default) (applies to next turn)`,
        };
      }
      const v = value.toLowerCase() as EffortLevel;
      if (!EFFORT_LEVELS.includes(v)) {
        return {
          ok: false,
          info: `invalid effort '${value}' — use: ${EFFORT_LEVELS.join(", ")}`,
        };
      }
      effort = v;
      return { ok: true, info: `${prev} → ${effort} (applies to next turn)` };
    },

    setMode(value: string): ControlResult {
      const resolved = MODE_ALIASES[value] ?? MODE_ALIASES[value.toLowerCase()];
      if (!resolved) return { ok: false, info: `unknown mode '${value}'` };
      const prev = permissionMode;
      permissionMode = resolved;
      return { ok: true, info: `${prev} → ${resolved}` };
    },

    getSessionId() {
      return sessionId;
    },
    setSessionId(id: string | null) {
      sessionId = id;
    },

    status(): BackendStatus {
      return {
        model: model ?? "(sdk default)",
        effort: effort ?? "(sdk default)",
        mode: permissionMode,
        session: sessionId,
        extra: {
          turns: String(totalTurns),
          totalCost: `$${totalCost.toFixed(4)}`,
        },
      };
    },
  };
}
