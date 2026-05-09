import { ipcMain, dialog, app, BrowserWindow } from "electron";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { listClaudeSessions } from "./sessions.ts";
import { spawnAgent, killAgent, listAgents, renameAgent, setAgentSessionId } from "./agent-manager.ts";
import { getProjectTrust, trustProject } from "./codex-trust.ts";

// Lazy: app.getPath("userData") must be called after app.whenReady()
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(data: Record<string, unknown>) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

export function registerIpc(hubPort: number) {
  ipcMain.handle("hub:port", () => ({ port: hubPort }));

  ipcMain.handle("self:get-name", () => {
    const cfg = readConfig();
    const name = (cfg.selfName as string | undefined) || os.userInfo().username || "human";
    return { name };
  });

  ipcMain.handle("self:set-name", (_e, name: string) => {
    const cfg = readConfig();
    cfg.selfName = name;
    writeConfig(cfg);
  });

  ipcMain.handle("dialog:pick-folder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory"],
    });
    return { path: result.canceled ? null : result.filePaths[0] };
  });

  // Pick files and/or folders (multiple selection)
  ipcMain.handle("dialog:pick-paths", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    return { paths: result.canceled ? [] : result.filePaths };
  });

  ipcMain.handle("agent:list-sessions", (_e, cwd: string) => {
    const sessions = listClaudeSessions(cwd);
    return { sessions };
  });

  ipcMain.handle("agent:spawn", (_e, spec: Parameters<typeof spawnAgent>[0]) => {
    return spawnAgent(spec);
  });

  ipcMain.handle("agent:kill", (_e, { name }: { name: string }) => {
    return killAgent(name);
  });

  ipcMain.handle("agent:list", () => {
    return { agents: listAgents() };
  });

  ipcMain.handle("agent:rename", async (_e, { oldName, newName }: { oldName: string; newName: string }) => {
    return renameAgent(oldName, newName);
  });

  ipcMain.handle("agent:set-session-id", (_e, { name, sessionId }: { name: string; sessionId: string }) => {
    setAgentSessionId(name, sessionId);
    return { ok: true };
  });

  ipcMain.handle("codex:check-trust", async (_e, { projectPath }: { projectPath: string }) => {
    return { status: await getProjectTrust(projectPath) };
  });

  ipcMain.handle("codex:trust", async (_e, { projectPath }: { projectPath: string }) => {
    return trustProject(projectPath);
  });
}
