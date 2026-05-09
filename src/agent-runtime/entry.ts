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
import { createHubBridge } from "./hub-bridge.ts";
import {
  EFFORT_LEVELS,
  ResumeFailedError,
  type AgentBackend,
  type EffortLevel,
  type PermissionMode,
} from "./backends/types.ts";
import { createClaudeBackend } from "./backends/claude.ts";
import { createCodexBackend } from "./backends/codex.ts";

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
const backendFlag = extractFlagValue("--backend");

const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0] ?? process.env.AGENT_NAME;
const cwdArg = positional[1] ?? process.env.AGENT_CWD ?? process.cwd();
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";
const agentRoom = process.env.AGENT_ROOM ?? DEFAULT_ROOM;
const initialSessionId = process.env.RESUME_SESSION_ID || undefined;
const backendKind = (backendFlag ?? process.env.AGENT_BACKEND ?? "claude").toLowerCase();
const initialModel = modelFlag ?? process.env.AGENT_MODEL ?? undefined;

let initialEffort: EffortLevel | undefined =
  (effortFlag as EffortLevel) ?? (process.env.AGENT_EFFORT as EffortLevel) ?? undefined;
if (initialEffort && !EFFORT_LEVELS.includes(initialEffort)) {
  console.warn(`[${name}] invalid effort '${initialEffort}', ignoring`);
  initialEffort = undefined;
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
if (initialModel) console.log(`[${name}] model=${initialModel} (override)`);
if (initialEffort) console.log(`[${name}] effort=${initialEffort} (override)`);
if (initialSessionId) {
  console.log(`[${name}] resuming session ${initialSessionId.slice(0, 8)}…`);
}

const initialPermissionMode: PermissionMode = hubIsLocal
  ? "bypassPermissions"
  : "acceptEdits";

let ws: WebSocket | null = null;
let roster: Participant[] = [];

const bridge = createHubBridge({
  getWs: () => ws,
  getRoster: () => roster,
});

// Backend is created asynchronously (Codex starts an HTTP MCP server).
// All references in helpers below assume initialization is complete before
// any WebSocket message arrives — connect() is only called after init.
let backend!: AgentBackend;

async function initBackend(): Promise<AgentBackend> {
  if (backendKind === "claude") {
    return createClaudeBackend({
      agentName: name!,
      cwd,
      initialModel,
      initialEffort,
      initialPermissionMode,
      initialSessionId,
      bridge,
    });
  }
  if (backendKind === "codex") {
    if (initialSessionId) {
      console.warn(`[${name}] codex backend ignores RESUME_SESSION_ID for now (PoC)`);
    }
    if (initialEffort) {
      console.warn(`[${name}] codex backend has no effort concept; ignoring '${initialEffort}'`);
    }
    return createCodexBackend({
      agentName: name!,
      cwd,
      initialModel,
      bridge,
    });
  }
  console.error(`[${name}] unsupported backend '${backendKind}'`);
  process.exit(1);
}

// Always send intro on first turn — it contains the critical send_chat instruction.
let introSent = false;
const queue: { from: string; content: string }[] = [];
type TaskKind = "turn" | "compact" | "usage";
let currentTask: TaskKind | null = null;
let currentAbort: AbortController | null = null;
let paused = false;

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

function reportSessionId(id: string) {
  // Report session ID to main process via stdout (parsed by agent-manager.ts)
  console.log(`[${name}] __SESSION_ID__:${id}`);
}

let lastActivity: { kind: ActivityKind; tool?: string } | null = null;

function sendActivity(kind: ActivityKind, tool?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastActivity && lastActivity.kind === kind && lastActivity.tool === tool) return;
  lastActivity = { kind, tool };
  ws.send(
    encode({
      type: MSG.ACTIVITY,
      name,
      kind,
      tool,
      ts: Date.now(),
      room: agentRoom,
    }),
  );
}

function sendAck(op: ControlOp, ok: boolean, info?: string, fromRequester?: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    encode({
      type: MSG.CONTROL_ACK,
      target: name,
      op,
      from: fromRequester ?? "?",
      ok,
      info,
      ts: Date.now(),
      room: agentRoom,
    }),
  );
}

async function runUsage(requester: string) {
  if (!backend.usage) {
    sendAck("usage", false, "backend does not support /usage", requester);
    return;
  }
  const controller = startTask("usage");
  if (!controller) {
    sendAck("usage", false, `busy: in ${currentTask}`, requester);
    return;
  }
  try {
    const res = await backend.usage({
      abort: controller,
      onActivity: sendActivity,
      onSessionId: reportSessionId,
    });
    sendAck("usage", res.ok, res.info, requester);
  } finally {
    finishTask(controller);
    if (queue.length > 0) processQueue();
    else sendActivity("idle");
  }
}

async function runCompact(requester: string) {
  if (!backend.compact) {
    sendAck("compact", false, "backend does not support /compact", requester);
    return;
  }
  const controller = startTask("compact");
  if (!controller) {
    sendAck("compact", false, `busy: in ${currentTask}`, requester);
    return;
  }
  try {
    const res = await backend.compact({
      abort: controller,
      onActivity: sendActivity,
      onSessionId: reportSessionId,
    });
    sendAck("compact", res.ok, res.info, requester);
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
      const prev = backend.getSessionId();
      const inflight = currentTask;
      currentAbort?.abort();
      backend.setSessionId(null);
      introSent = false;
      queue.length = 0;
      const note = prev
        ? `session cleared (was ${prev.slice(0, 8)}…)${inflight ? `, ${inflight} aborted` : ""}`
        : "no prior session";
      sendAck(op, true, note, requester);
      return;
    }
    case "compact":
      void runCompact(requester);
      return;
    case "status": {
      const s = backend.status();
      const lines = [
        `session=${s.session ?? "(none)"}`,
        `mode=${s.mode}`,
        `model=${s.model}`,
        `effort=${s.effort}`,
        `task=${currentTask ?? "idle"}`,
        `paused=${paused}`,
        `queue=${queue.length}`,
      ];
      if (s.extra) {
        for (const [k, v] of Object.entries(s.extra)) lines.push(`${k}=${v}`);
      }
      sendAck(op, true, lines.join(" · "), requester);
      return;
    }
    case "usage":
      void runUsage(requester);
      return;
    case "mode": {
      if (!backend.setMode) {
        sendAck(op, false, "backend does not support mode changes", requester);
        return;
      }
      const argRaw = (msg.arg ?? "").trim();
      if (!argRaw) {
        sendAck(op, true, `current=${backend.status().mode}`, requester);
        return;
      }
      const r = backend.setMode(argRaw);
      sendAck(op, r.ok, r.info, requester);
      return;
    }
    case "model": {
      if (!backend.setModel) {
        sendAck(op, false, "backend does not support model changes", requester);
        return;
      }
      const argRaw = (msg.arg ?? "").trim();
      if (!argRaw) {
        sendAck(op, true, `current=${backend.status().model}`, requester);
        return;
      }
      const r = backend.setModel(argRaw);
      sendAck(op, r.ok, r.info, requester);
      return;
    }
    case "effort": {
      if (!backend.setEffort) {
        sendAck(op, false, "backend does not support effort changes", requester);
        return;
      }
      const argRaw = (msg.arg ?? "").trim().toLowerCase();
      if (!argRaw) {
        sendAck(op, true, `current=${backend.status().effort}`, requester);
        return;
      }
      const r = backend.setEffort(argRaw);
      sendAck(op, r.ok, r.info, requester);
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

async function processQueue() {
  if (paused || queue.length === 0) return;
  const controller = startTask("turn");
  if (!controller) return;
  const batch = queue.splice(0, queue.length);
  let header = "";
  if (!introSent) {
    const { kindLabel, chatToolName } = backend.capabilities;
    if (initialSessionId && backend.getSessionId() === initialSessionId) {
      // Resumed session: keep it short. The previous session has the full
      // instructions; just refresh the chat-tool reminder.
      header =
        `You are "${name!}", a ${kindLabel} agent (cwd: ${cwd}). ` +
        `You are resuming a previous session. ` +
        `IMPORTANT: use the ${chatToolName} tool to reply — plain text is silently dropped.\n\n`;
    } else {
      header = makeIntro(name!, cwd, roster, { kindLabel, chatTool: chatToolName }) + "\n\n";
    }
    introSent = true;
  }
  const body = batch.map((m) => `[from ${m.from}] ${m.content}`).join("\n");
  const promptText = header + body;

  console.log(`\n[${name}] --- turn (${batch.length} incoming) ---`);
  sendActivity("thinking");
  const sendChatBefore = bridge.getCallCount();

  try {
    let outcome: { resultText: string; costUsd: number };
    try {
      outcome = await backend.runTurn({
        prompt: promptText,
        abort: controller,
        onActivity: sendActivity,
        onSessionId: reportSessionId,
      });
    } catch (e: any) {
      if (e instanceof ResumeFailedError && !controller.signal.aborted) {
        console.warn(`[${name}] resume failed (${e.message}), retrying as fresh session`);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            encode({
              type: MSG.MESSAGE,
              content: `_(notice: session resume failed — starting fresh)_`,
            }),
          );
        }
        introSent = false;
        queue.unshift(...batch.map((m) => ({ from: m.from, content: m.content })));
        return; // finally → processQueue handles the retry
      }
      throw e;
    }

    if (
      bridge.getCallCount() === sendChatBefore &&
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      if (outcome.resultText) {
        bridge.sendChatMessage(outcome.resultText);
      } else {
        console.error(`[${name}] turn produced no output`);
        // System-style notice (renderer styles `_(notice: …)_` differently
        // from `_(error: …)_`).
        bridge.sendChatMessage(`_(notice: turn completed with no response)_`);
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

initBackend()
  .then((b) => {
    backend = b;
    connect();
  })
  .catch((e) => {
    console.error(`[${name}] backend init failed:`, e);
    process.exit(1);
  });

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  console.log(`[${name}] received ${signal}, exiting…`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => console.error(`[${name}] UNCAUGHT`, e));
process.on("unhandledRejection", (e) =>
  console.error(`[${name}] UNHANDLED REJECTION`, e),
);
