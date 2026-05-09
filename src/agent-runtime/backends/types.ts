import type { ActivityKind } from "../../shared/protocol.ts";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type ActivityCallback = (kind: ActivityKind, tool?: string) => void;
export type SessionCallback = (sessionId: string) => void;

export interface BackendCapabilities {
  compact: boolean;
  usage: boolean;
  effort: boolean;
  model: boolean;
  mode: boolean;
}

export interface TurnRequest {
  prompt: string;
  abort: AbortController;
  onActivity: ActivityCallback;
  onSessionId: SessionCallback;
}

export interface TurnOutcome {
  resultText: string;
  costUsd: number;
}

export interface ControlRunCtx {
  abort: AbortController;
  onActivity: ActivityCallback;
  onSessionId: SessionCallback;
}

export interface ControlResult {
  ok: boolean;
  info?: string;
}

export interface BackendStatus {
  model: string;
  effort: string;
  mode: string;
  session: string | null;
  /** Extra `key=value` rows to append to /status output. */
  extra?: Record<string, string>;
}

export interface RosterEntry {
  name: string;
  role: string;
}

export interface HubChatBridge {
  sendChatMessage(content: string): void;
  getCallCount(): number;
  getRoster(): RosterEntry[];
}

export interface AgentBackend {
  readonly capabilities: BackendCapabilities;
  runTurn(req: TurnRequest): Promise<TurnOutcome>;
  compact?(ctx: ControlRunCtx): Promise<ControlResult>;
  usage?(ctx: ControlRunCtx): Promise<ControlResult>;
  setModel?(value: string | undefined): ControlResult;
  setEffort?(value: string | undefined): ControlResult;
  setMode?(value: string): ControlResult;
  getSessionId(): string | null;
  setSessionId(id: string | null): void;
  status(): BackendStatus;
}

export class ResumeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeFailedError";
  }
}
