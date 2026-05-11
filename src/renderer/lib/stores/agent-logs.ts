import { writable } from "svelte/store";

const MAX_LINES = 500;

export interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
  ts: number;
}

// Keyed by agent name
export const agentLogs = writable<Map<string, LogLine[]>>(new Map());

export function appendLog(name: string, stream: "stdout" | "stderr", text: string) {
  agentLogs.update((map) => {
    const m = new Map(map);
    const existing = m.get(name) ?? [];
    const updated = [...existing, { stream, text, ts: Date.now() }];
    m.set(name, updated.length > MAX_LINES ? updated.slice(-MAX_LINES) : updated);
    return m;
  });
}

export function clearLogs(name: string) {
  agentLogs.update((map) => {
    const m = new Map(map);
    m.set(name, []);
    return m;
  });
}

export function dropLogs(name: string) {
  agentLogs.update((map) => {
    if (!map.has(name)) return map;
    const m = new Map(map);
    m.delete(name);
    return m;
  });
}

export function renameLogKey(oldName: string, newName: string) {
  agentLogs.update((map) => {
    if (!map.has(oldName) || oldName === newName) return map;
    const m = new Map(map);
    const lines = m.get(oldName)!;
    m.delete(oldName);
    m.set(newName, lines);
    return m;
  });
}
