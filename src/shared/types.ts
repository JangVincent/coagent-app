// Shared types used by both main process and renderer

export type BackendKind = "claude" | "codex";

export interface AgentSpec {
  name: string;
  cwd: string;
  room: string;
  kind: BackendKind;
  model?: string;
  effort?: EffortLevel;
  status: "starting" | "running" | "exited";
  paused?: boolean;
}

export interface RoomSpec {
  id: string;      // unique room name (used in protocol)
  label: string;   // display name
}

export interface PastSession {
  sid: string;
  mtimeMs: number;
  preview: string;
  turns: number;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface SpawnAgentOpts {
  name: string;
  cwd: string;
  room: string;
  kind?: BackendKind;
  model?: string;
  effort?: EffortLevel;
  resumeSessionId?: string;
}

export type CodexTrustStatus = "trusted" | "untrusted" | "unset";

export interface CoagentAPI {
  getHubPort(): Promise<{ port: number }>;
  getSelfName(): Promise<{ name: string }>;
  setSelfName(name: string): Promise<void>;
  pickFolder(): Promise<{ path: string | null }>;
  pickPaths(): Promise<{ paths: string[] }>;
  getFilePath(file: File): string;
  listSessions(cwd: string): Promise<{ sessions: PastSession[] }>;
  spawnAgent(spec: SpawnAgentOpts): Promise<{ ok: boolean; error?: string }>;
  killAgent(name: string): Promise<{ ok: boolean }>;
  renameAgent(
    oldName: string,
    newName: string,
  ): Promise<{ ok: boolean; error?: string; status?: AgentSpec["status"] }>;
  listAgents(): Promise<{ agents: AgentSpec[] }>;
  onAgentStatus(
    cb: (data: { name: string; status: AgentSpec["status"]; code?: number }) => void,
  ): () => void;
  onAgentLog(
    cb: (data: { name: string; stream: "stdout" | "stderr"; line: string }) => void,
  ): () => void;

  /** Read project trust status from ~/.codex/config.toml. */
  checkCodexTrust(projectPath: string): Promise<{ status: CodexTrustStatus }>;
  /**
   * Append `[projects."<path>"] trust_level = "trusted"` to ~/.codex/config.toml.
   * Refuses (returns ok=false) if the project is already explicitly marked
   * "untrusted" — coagent never silently overrides an explicit user choice.
   */
  trustCodexProject(
    projectPath: string,
  ): Promise<{ ok: boolean; status: CodexTrustStatus; error?: string }>;
}
