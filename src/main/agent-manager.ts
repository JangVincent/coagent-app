import { utilityProcess, app } from "electron";
import type { UtilityProcess } from "electron";
import path from "node:path";
import type { AgentSpec, BackendKind, EffortLevel } from "../shared/types.ts";

export type { AgentSpec };

interface AgentHandle {
  spec: AgentSpec & { resumeSessionId?: string };
  proc: UtilityProcess;
  currentSessionId?: string; // Tracked via IPC from agent runtime
  // Set during rename so the kill-triggered exit doesn't surface as a status
  // change to the renderer (the agent isn't really exiting, just being
  // respawned under a new name).
  renaming?: boolean;
}

const agents = new Map<string, AgentHandle>();
let hubPort = 0;
let onStatusChange: ((name: string, status: AgentSpec["status"], code?: number) => void) | null = null;
let onLog: ((name: string, stream: "stdout" | "stderr", line: string) => void) | null = null;

export function initAgentManager(
  port: number,
  statusCb: typeof onStatusChange,
  logCb: typeof onLog,
) {
  hubPort = port;
  onStatusChange = statusCb;
  onLog = logCb;
}

function agentEntryPath(): string {
  // Always inside the app bundle (asar in packaged builds, project root in dev).
  // Living next to dist/main lets `require("@anthropic-ai/claude-agent-sdk")`
  // and other externals resolve via the sibling node_modules.
  return path.join(app.getAppPath(), "dist", "agent-runtime", "entry.cjs");
}

export function spawnAgent(spec: {
  name: string;
  cwd: string;
  room: string;
  kind?: BackendKind;
  model?: string;
  effort?: EffortLevel;
  resumeSessionId?: string;
}): { ok: boolean; error?: string } {
  if (agents.has(spec.name)) {
    return { ok: false, error: `agent '${spec.name}' already running` };
  }

  const kind: BackendKind = spec.kind ?? "claude";
  const entry = agentEntryPath();
  const envBase = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined)
  ) as Record<string, string>;
  const env: Record<string, string> = {
    ...envBase,
    HUB_URL: `ws://127.0.0.1:${hubPort}`,
    AGENT_NAME: spec.name,
    AGENT_CWD: spec.cwd,
    AGENT_ROOM: spec.room,
    AGENT_BACKEND: kind,
    ...(spec.model ? { AGENT_MODEL: spec.model } : {}),
    ...(spec.effort ? { AGENT_EFFORT: spec.effort } : {}),
    ...(spec.resumeSessionId ? { RESUME_SESSION_ID: spec.resumeSessionId } : {}),
  };

  const proc = utilityProcess.fork(entry, [spec.name, spec.cwd], {
    serviceName: spec.name,
    stdio: "pipe",
    env,
  });

  const handle: AgentHandle = {
    spec: { ...spec, kind, status: "starting" },
    proc,
  };
  agents.set(spec.name, handle);

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      // Parse session ID from agent runtime log: [name] __SESSION_ID__:uuid
      const sessionMatch = line.match(/__SESSION_ID__:([a-f0-9-]+)/i);
      if (sessionMatch) {
        const h = agents.get(spec.name);
        if (h) h.currentSessionId = sessionMatch[1];
      }
      onLog?.(spec.name, "stdout", line);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      onLog?.(spec.name, "stderr", line);
    }
  });

  proc.on("spawn", () => {
    const h = agents.get(spec.name);
    if (h) h.spec.status = "running";
    onStatusChange?.(spec.name, "running");
  });

  proc.on("exit", (code) => {
    const handle = agents.get(spec.name);
    const suppress = handle?.renaming === true;
    agents.delete(spec.name);
    if (!suppress) onStatusChange?.(spec.name, "exited", code ?? undefined);
  });

  return { ok: true };
}

export function killAgent(name: string): { ok: boolean } {
  const h = agents.get(name);
  if (!h) return { ok: false };
  h.proc.kill();
  return { ok: true };
}

export function listAgents(): AgentSpec[] {
  return [...agents.values()].map((h) => ({
    name: h.spec.name,
    cwd: h.spec.cwd,
    room: h.spec.room,
    kind: h.spec.kind,
    model: h.spec.model,
    effort: h.spec.effort,
    status: h.spec.status,
  }));
}

export async function killAllAgents(): Promise<void> {
  for (const [, h] of agents) {
    try { h.proc.kill(); } catch {}
  }
  agents.clear();
}

/** Update the tracked session ID for an agent (called via IPC from agent runtime) */
export function setAgentSessionId(name: string, sessionId: string): void {
  const h = agents.get(name);
  if (h) h.currentSessionId = sessionId;
}

/** Get the current session ID for an agent */
export function getAgentSessionId(name: string): string | undefined {
  return agents.get(name)?.currentSessionId;
}

/** Rename an agent by killing and respawning with the same session.
 *
 * Returns the final status of the new agent so the renderer can apply it
 * synchronously after renaming its own store, avoiding a race where the
 * `agent:status` event for the new name arrives before the renderer's store
 * has an entry under that name (which would silently drop the status).
 */
const RENAME_SPAWN_AWAIT_TIMEOUT_MS = 5000;

export async function renameAgent(
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; error?: string; status?: AgentSpec["status"] }> {
  const h = agents.get(oldName);
  if (!h) return { ok: false, error: `agent '${oldName}' not found` };
  if (agents.has(newName)) return { ok: false, error: `name '${newName}' already taken` };

  // Capture current state before killing
  const { cwd, room, kind, model, effort } = h.spec;
  const sessionId = h.currentSessionId;

  // Flag the old handle so the exit triggered by our kill doesn't surface
  // as an "exited" status to the renderer. The renderer will see only the
  // final rename result.
  h.renaming = true;
  h.proc.kill();
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!agents.has(oldName)) resolve();
      else setTimeout(check, 50);
    };
    check();
  });

  // Respawn with new name but same session
  const result = spawnAgent({
    name: newName,
    cwd,
    room,
    kind,
    model,
    effort,
    resumeSessionId: sessionId,
  });
  if (!result.ok) return result;

  // Wait until the new proc either spawns (status becomes "running") or
  // exits, so the IPC response carries an authoritative status.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const check = () => {
      const handle = agents.get(newName);
      if (!handle) return finish();              // already exited
      if (handle.spec.status !== "starting") return finish();
      setTimeout(check, 50);
    };
    check();
    setTimeout(finish, RENAME_SPAWN_AWAIT_TIMEOUT_MS);
  });

  const status = agents.get(newName)?.spec.status ?? "exited";
  return { ok: true, status };
}
