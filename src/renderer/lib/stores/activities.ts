import { writable } from "svelte/store";
import type { ActivityMsg } from "@shared/protocol.ts";

// Keyed by agent name (activities are per-agent, displayed in the room they belong to)
export const activities = writable<Map<string, ActivityMsg>>(new Map());

export function setActivity(msg: ActivityMsg) {
  activities.update((map) => {
    const m = new Map(map);
    m.set(msg.name, msg);
    return m;
  });
}

export function renameActivityKey(oldName: string, newName: string) {
  activities.update((map) => {
    if (!map.has(oldName) || oldName === newName) return map;
    const m = new Map(map);
    const v = m.get(oldName)!;
    m.delete(oldName);
    m.set(newName, { ...v, name: newName });
    return m;
  });
}
