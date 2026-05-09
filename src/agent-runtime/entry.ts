import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  MSG,
  DEFAULT_ROOM,
  encode,
  decode,
  type ServerMsg,
  type Participant,
  type ControlMsg,
  type ControlOp,
  type ActivityKind,
} from "../shared/protocol.ts";
import { makeIntro } from "./helpers/intro.ts";
import { accumulateModelUsage, formatUsage } from "./helpers/usage.ts";

const args = process.argv.slice(2);

function extractFlagValue(flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      value = args[i + 1];
      args.splice(i, 2);
      i -= 1;
    } else if (a.startsWith(`${flag}=`)) {
      value = a.slice(flag.length + 1);
      args.splice(i, 1);
      i -= 1;
    }
  }
  return value;
}
const modelFlag = extractFlagValue("--model");
const effortFlag = extractFlagValue("--effort");

const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0] ?? process.env.AGENT_NAME;
const cwdArg = positional[1] ?? process.env.AGENT_CWD ?? process.cwd();
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";
const agentRoom = process.env.AGENT_ROOM ?? DEFAULT_ROOM;
// Resume session ID is passed by the desktop app via env (no interactive picker)
const initialSessionId = process.env.RESUME_SESSION_ID || undefined;
let agentModel: string | undefined =
  modelFlag ?? process.env.AGENT_MODEL ?? undefined;

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
let agentEffort: EffortLevel | undefined =
  (effortFlag as EffortLevel) ?? (process.env.AGENT_EFFORT as EffortLevel) ?? undefined;
if (agentEffort && !EFFORT_LEVELS.includes(agentEffort)) {
  console.warn(`[${name}] invalid effort '${agentEffort}', ignoring`);
  agentEffort = undefined;
}

if (!name) {
  console.error("usage: entry.ts <name> [cwd]");
  process.exit(1);
}

const cwd = path.resolve(cwdArg);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
  console.error(`[${name}] cwd does not exist or is not a directory: ${cwd}`);
  process.exit(1);
}

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

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

function isLocalHubUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

const hubIsLocal = isLocalHubUrl(hubUrl);
if (!hubIsLocal) {
  console.warn(
    `[${name}] hub at ${hubUrl} is non-local — defaulting permissionMode to acceptEdits.`,
  );
}
if (agentModel) {
  console.log(`[${name}] model=${agentModel} (override)`);
}
if (agentEffort) {
  console.log(`[${name}] effort=${agentEffort} (override)`);
}
if (initialSessionId) {
  console.log(`[${name}] resuming session ${initialSessionId.slice(0, 8)}…`);
}

// SDK 0.2.x ships the Claude Code CLI as a per-platform native binary
// (e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64/claude). The SDK's
// internal resolver returns a path inside app.asar in packaged builds,
// and Electron's automatic asar→unpacked translation does not fire for
// child_process.spawn from a utilityProcess context — every turn dies
// with ENOTDIR. Resolve the binary ourselves and rewrite the path so
// the OS sees the real file in app.asar.unpacked/.
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
      // Electron packs node_modules into app.asar but Forge unpacks the
      // claude-agent-sdk* subtree to app.asar.unpacked. require.resolve
      // returns the asar path; rewrite to the unpacked sibling.
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
const claudeBinaryPath = resolveClaudeBinary();
if (claudeBinaryPath) {
  console.log(`[${name}] claude binary: ${claudeBinaryPath}`);
} else {
  console.warn(`[${name}] could not resolve native claude binary; SDK will fall back`);
}

// Load filesystem settings from ~/.claude (user), <cwd>/.claude (project),
// and <cwd>/.claude/settings.local.json (local). SDK 0.2.x defaults to
// isolation mode, which silently skips CLAUDE.md, skills, agents, hooks,
// and commands. Including 'project' is required to pick up CLAUDE.md.
const SETTING_SOURCES = ["user", "project", "local"] as const;

let ws: WebSocket | null = null;
let sessionId: string | null = initialSessionId ?? null;
// Always send intro on first turn — it contains the critical send_chat instruction.
// For resumed sessions Claude already has context, but still needs the current
// participant list and send_chat reminder for this new connection.
let introSent = false;
let roster: Participant[] = [];
const queue: { from: string; content: string }[] = [];
type TaskKind = "turn" | "compact" | "usage";
let currentTask: TaskKind | null = null;
let currentAbort: AbortController | null = null;
let paused = false;
let totalCost = 0;
let totalTurns = 0;
let sendChatCallCount = 0;

function startTask(kind: TaskKind): AbortController | null {
  if (currentTask !== null) return null;
  const controller = new AbortController();
  currentTask = kind;
  currentAbort = controller;
  return controller;
}

function finishTask(controller: AbortController) {
  if (currentAbort === controller) {
    currentAbort = null;
    currentTask = null;
  }
}

let permissionMode: PermissionMode = hubIsLocal ? "bypassPermissions" : "acceptEdits";

function setSessionId(id: string | null) {
  sessionId = id;
  // Report session ID to main process via stdout (parsed by agent-manager.ts)
  if (id) console.log(`[${name}] __SESSION_ID__:${id}`);
}

let lastActivity: { kind: ActivityKind; tool?: string } | null = null;

function sendActivity(kind: ActivityKind, tool?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastActivity && lastActivity.kind === kind && lastActivity.tool === tool) return;
  lastActivity = { kind, tool };
  ws.send(encode({ type: MSG.ACTIVITY, name, kind, tool, ts: Date.now(), room: agentRoom }));
}

function sendAck(op: ControlOp, ok: boolean, info?: string, fromRequester?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(encode({
    type: MSG.CONTROL_ACK,
    target: name,
    op,
    from: fromRequester ?? "?",
    ok,
    info,
    ts: Date.now(),
    room: agentRoom,
  }));
}

async function runUsagePassthrough(requester: string) {
  const controller = startTask("usage");
  if (!controller) {
    sendAck("usage", false, `busy: in ${currentTask}`, requester);
    return;
  }
  sendActivity("usage");
  let resultText = "";
  let failure: string | null = null;
  try {
    const res = query({
      prompt: "/usage",
      options: {
        cwd,
        permissionMode,
        resume: sessionId ?? undefined,
        abortController: controller,
        ...(agentModel ? { model: agentModel } : {}),
        ...(agentEffort ? { effort: agentEffort } : {}),
        ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
        settingSources: [...SETTING_SOURCES],
        mcpServers: {
          "agent-chat": { type: "sdk", name: "agent-chat", instance: chatServer.instance },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (msg.type === "result") {
        const r = msg as { result?: string };
        if (typeof r.result === "string" && r.result.length > 0) {
          resultText = r.result.trim();
        }
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    failure = controller.signal.aborted
      ? "aborted"
      : `CLI /usage failed: ${err.message ?? String(e)}`;
  } finally {
    finishTask(controller);
  }
  if (failure) {
    sendAck("usage", true, `${formatUsage(totalCost, totalTurns)}\n(${failure})`, requester);
  } else {
    const combined = resultText
      ? `${formatUsage(totalCost, totalTurns)}\n${resultText}`
      : `${formatUsage(totalCost, totalTurns)}\n(CLI /usage returned no data)`;
    sendAck("usage", true, combined, requester);
  }
  if (queue.length > 0) processQueue();
  else sendActivity("idle");
}

async function runCompact(requester: string) {
  if (!sessionId) {
    sendAck("compact", false, "no active session to compact", requester);
    return;
  }
  const controller = startTask("compact");
  if (!controller) {
    sendAck("compact", false, `busy: in ${currentTask}`, requester);
    return;
  }
  console.log(`[${name}] /compact starting (session=${sessionId})`);
  sendActivity("compact");
  let acked = false;
  try {
    const res = query({
      prompt: "/compact",
      options: {
        cwd,
        permissionMode,
        resume: sessionId ?? undefined,
        abortController: controller,
        ...(agentModel ? { model: agentModel } : {}),
        ...(agentEffort ? { effort: agentEffort } : {}),
        ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
        settingSources: [...SETTING_SOURCES],
        mcpServers: {
          "agent-chat": { type: "sdk", name: "agent-chat", instance: chatServer.instance },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (msg.type === "system" && (msg as { subtype?: string }).subtype === "compact_boundary") {
        const meta = (msg as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
        sendAck("compact", true, `compacted (pre=${meta?.pre_tokens ?? "?"} tokens)`, requester);
        acked = true;
      }
    }
    if (!acked) sendAck("compact", true, "done", requester);
  } catch (e) {
    const err = e as { message?: string };
    if (controller.signal.aborted) {
      sendAck("compact", false, "aborted", requester);
    } else {
      sendAck("compact", false, `error: ${err.message ?? String(e)}`, requester);
    }
  } finally {
    finishTask(controller);
    if (queue.length > 0) processQueue();
    else sendActivity("idle");
  }
}

function handleControl(msg: ControlMsg) {
  const op = msg.op;
  const requester = msg.from ?? "?";
  console.log(`[${name}] control from ${requester}: ${op}`);
  switch (op) {
    case "clear": {
      const prev = sessionId;
      const inflight = currentTask;
      currentAbort?.abort();
      setSessionId(null);
      introSent = false;
      queue.length = 0;
      const note = prev
        ? `session cleared (was ${prev.slice(0, 8)}…)${inflight ? `, ${inflight} aborted` : ""}`
        : "no prior session";
      sendAck(op, true, note, requester);
      return;
    }
    case "compact": void runCompact(requester); return;
    case "status": {
      const lines = [
        `session=${sessionId ?? "(none)"}`,
        `mode=${permissionMode}`,
        `model=${agentModel ?? "(sdk default)"}`,
        `effort=${agentEffort ?? "(sdk default)"}`,
        `task=${currentTask ?? "idle"}`,
        `paused=${paused}`,
        `queue=${queue.length}`,
        `turns=${totalTurns}`,
        `totalCost=$${totalCost.toFixed(4)}`,
      ];
      sendAck(op, true, lines.join(" · "), requester);
      return;
    }
    case "usage": void runUsagePassthrough(requester); return;
    case "mode": {
      const argRaw = (msg.arg ?? "").trim();
      if (!argRaw) {
        sendAck(op, true, `current=${permissionMode}`, requester);
        return;
      }
      const resolved = MODE_ALIASES[argRaw] ?? MODE_ALIASES[argRaw.toLowerCase()];
      if (!resolved) {
        sendAck(op, false, `unknown mode '${argRaw}'`, requester);
        return;
      }
      const prev = permissionMode;
      permissionMode = resolved;
      sendAck(op, true, `${prev} → ${resolved}`, requester);
      return;
    }
    case "model": {
      const argRaw = (msg.arg ?? "").trim();
      if (!argRaw) {
        sendAck(op, true, `current=${agentModel ?? "(sdk default)"}`, requester);
        return;
      }
      const prev = agentModel ?? "(sdk default)";
      if (argRaw === "default" || argRaw === "clear" || argRaw === "reset") {
        agentModel = undefined;
      } else {
        agentModel = argRaw;
      }
      sendAck(op, true, `${prev} → ${agentModel ?? "(sdk default)"} (applies to next turn)`, requester);
      return;
    }
    case "effort": {
      const argRaw = (msg.arg ?? "").trim().toLowerCase() as EffortLevel;
      if (!argRaw) {
        sendAck(op, true, `current=${agentEffort ?? "(sdk default)"}`, requester);
        return;
      }
      if (argRaw === "default" || argRaw === "clear" || argRaw === "reset") {
        const prev = agentEffort ?? "(sdk default)";
        agentEffort = undefined;
        sendAck(op, true, `${prev} → (sdk default) (applies to next turn)`, requester);
        return;
      }
      if (!EFFORT_LEVELS.includes(argRaw)) {
        sendAck(op, false, `invalid effort '${argRaw}' — use: ${EFFORT_LEVELS.join(", ")}`, requester);
        return;
      }
      const prev = agentEffort ?? "(sdk default)";
      agentEffort = argRaw;
      sendAck(op, true, `${prev} → ${agentEffort} (applies to next turn)`, requester);
      return;
    }
    case "pause": {
      paused = true;
      sendAck(op, true, "paused", requester);
      return;
    }
    case "resume": {
      paused = false;
      sendAck(op, true, "resumed", requester);
      if (queue.length > 0) processQueue();
      return;
    }
    case "kill": {
      currentAbort?.abort();
      sendAck(op, true, "exiting", requester);
      setTimeout(() => process.exit(0), 300);
      return;
    }
    default:
      sendAck(op, false, "unknown op", requester);
  }
}

const sendChatTool = tool(
  "send_chat",
  "Send a message to the group chat. Use @name to address a participant. This is the ONLY way to deliver a message to other participants — anything else you output stays local.",
  {
    content: z.string().describe(
      "Message text. Use @name to mention participants. For file references, just write the path.",
    ),
  },
  async ({ content }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ type: MSG.MESSAGE, content }));
      sendChatCallCount += 1;
      process.stdout.write(`[${name} -> chat] ${content}\n`);
      return { content: [{ type: "text" as const, text: "sent" }] };
    }
    return {
      content: [{ type: "text" as const, text: "error: not connected to hub" }],
      isError: true,
    };
  },
);

const getParticipantsTool = tool(
  "get_participants",
  "Get the current list of participants in the chat room. Returns names and roles (human/agent).",
  {},
  async () => {
    const list = roster.length > 0
      ? roster.map((p) => `${p.name} (${p.role})`).join(", ")
      : "(no participants)";
    return { content: [{ type: "text" as const, text: list }] };
  },
);

const chatServer = createSdkMcpServer({
  name: "agent-chat",
  version: "1.0.0",
  tools: [sendChatTool, getParticipantsTool],
});

async function processQueue() {
  if (paused || queue.length === 0) return;
  const controller = startTask("turn");
  if (!controller) return;
  const batch = queue.splice(0, queue.length);
  let header = "";
  if (!introSent) {
    if (initialSessionId) {
      // Resumed session: keep it short to avoid context overflow.
      // The previous session already has the full instructions.
      header = `You are "${name!}", a Claude Code agent (cwd: ${cwd}). ` +
        `You are resuming a previous session. ` +
        `IMPORTANT: use the send_chat tool to reply — plain text is silently dropped.\n\n`;
    } else {
      header = makeIntro(name!, cwd, roster) + "\n\n";
    }
    introSent = true;
  }
  const body = batch.map((m) => `[from ${m.from}] ${m.content}`).join("\n");
  const promptText = header + body;

  console.log(`\n[${name}] --- turn (${batch.length} incoming) ---`);
  sendActivity("thinking");
  const sendChatBefore = sendChatCallCount;
  let resultText = "";
  const runQuery = async (resumeId: string | undefined) => {
    const res = query({
      prompt: promptText,
      options: {
        cwd,
        permissionMode,
        resume: resumeId,
        abortController: controller,
        ...(agentModel ? { model: agentModel } : {}),
        ...(agentEffort ? { effort: agentEffort } : {}),
        ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
        settingSources: [...SETTING_SOURCES],
        mcpServers: {
          "agent-chat": { type: "sdk", name: "agent-chat", instance: chatServer.instance },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              sendActivity("thinking");
            } else if (block.type === "tool_use" && !String(block.name).endsWith("send_chat")) {
              sendActivity("tool", String(block.name));
            }
          }
        }
      } else if (msg.type === "result") {
        const r = msg as any;
        if (typeof r.result === "string" && r.result.trim().length > 0) {
          resultText = r.result.trim();
        }
        if (typeof r.total_cost_usd === "number") totalCost += r.total_cost_usd;
        totalTurns += 1;
        accumulateModelUsage(r.modelUsage);
      }
    }
  };

  try {
    try {
      await runQuery(sessionId ?? undefined);
    } catch (e: any) {
      // If resume fails, retry as a fresh session
      const isResumeError = sessionId && (
        String(e?.message ?? e).includes("exited with code") ||
        String(e?.message ?? e).includes("session")
      );
      if (isResumeError && !controller.signal.aborted) {
        console.warn(`[${name}] resume failed (${e?.message}), retrying as fresh session`);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encode({
            type: MSG.MESSAGE,
            content: `_(session resume failed — starting fresh)_`,
          }));
        }
        setSessionId(null);
        introSent = false; // re-send intro for the fresh session
        // Re-add the batch back to queue and re-process as fresh
        queue.unshift(...batch.map((m) => ({ from: m.from, content: m.content })));
        return; // let finally → processQueue handle it
      }
      throw e; // re-throw non-resume errors
    }

    if (sendChatCallCount === sendChatBefore && ws && ws.readyState === WebSocket.OPEN) {
      if (resultText) {
        ws.send(encode({ type: MSG.MESSAGE, content: resultText }));
        sendChatCallCount += 1;
      } else {
        console.error(`[${name}] turn produced no output`);
        ws.send(encode({
          type: MSG.MESSAGE,
          content: `_(turn completed with no response — try again)_`,
        }));
        sendChatCallCount += 1;
      }
    }
  } catch (e: any) {
    if (!controller.signal.aborted) {
      const errMsg = e?.message ?? String(e);
      console.error(`[${name}] turn error:`, errMsg);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encode({ type: MSG.MESSAGE, content: `_(error: ${errMsg})_` }));
      }
    }
  } finally {
    finishTask(controller);
    if (queue.length > 0) processQueue();
    else sendActivity("idle");
  }
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_BACKOFF_CAP = 6;
const SHUTDOWN_GRACE_MS = 500;

let shuttingDown = false;
let reconnectAttempt = 0;
let fatalReason: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function reconnectDelay(attempt: number): number {
  const exp = Math.min(attempt - 1, RECONNECT_BACKOFF_CAP);
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (fatalReason) {
    console.error(`[${name}] not reconnecting: ${fatalReason}`);
    process.exit(1);
    return;
  }
  reconnectAttempt += 1;
  const delay = reconnectDelay(reconnectAttempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!shuttingDown) connect();
  }, delay);
}

function connect() {
  ws = new WebSocket(hubUrl);
  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    ws!.send(encode({ type: MSG.HELLO, name: name!, role: "agent", room: agentRoom }));
    console.log(`[${name}] connected to ${hubUrl} (cwd=${cwd})`);
  });
  ws.addEventListener("message", (ev) => {
    let msg: ServerMsg;
    try {
      msg = decode<ServerMsg>(ev.data as string);
    } catch {
      return;
    }
    if (msg.type === MSG.ROSTER) {
      roster = msg.participants;
    } else if (msg.type === MSG.SYSTEM) {
      if (Array.isArray(msg.participants)) roster = msg.participants;
      const t = msg.text;
      if (t.includes("already taken") || t.includes("expected hello")) {
        fatalReason = t;
      }
      console.log(`[${name}] -- ${t}`);
    } else if (msg.type === MSG.MESSAGE) {
      if (msg.from === name) return;
      const addressed = msg.mentions?.includes(name!) || msg.mentions?.includes("all");
      if (!addressed) return;
      queue.push({ from: msg.from, content: msg.content });
      processQueue();
    } else if (msg.type === MSG.CONTROL) {
      if (msg.target !== name) return;
      handleControl(msg);
    }
  });
  ws.addEventListener("close", (ev) => {
    console.log(`[${name}] disconnected (code=${ev.code})`);
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    // error event always followed by close
  });
}

connect();

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  console.log(`[${name}] received ${signal}, exiting…`);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws?.close(); } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => console.error(`[${name}] UNCAUGHT`, e));
process.on("unhandledRejection", (e) => console.error(`[${name}] UNHANDLED REJECTION`, e));
