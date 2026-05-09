import type { BackendKind } from "@shared/types.ts";

export interface ModelOption {
  id: string;
  label: string;
}

export interface EffortOption {
  id: string;
  label: string;
  desc?: string;
}

/**
 * Per-backend UI capabilities and option lists. Keep this in sync with the
 * agent-runtime side `BackendCapabilities` (src/agent-runtime/backends/types.ts):
 * any op flag here that's true must also be implemented by the backend, and
 * vice versa. The agent-runtime is the source of truth for actual gating —
 * unsupported ops are rejected with a clear ack — but this map drives whether
 * each option even appears in the UI.
 */
export interface BackendUiCaps {
  compact: boolean;
  usage: boolean;
  effort: boolean;
  model: boolean;
  mode: boolean;
  /** Model picker entries; first item is the no-override "Default". */
  models: ModelOption[];
  /** Concrete effort levels (no "Default" — UI prepends a reset entry). */
  efforts: EffortOption[];
}

export const BACKEND_CAPS: Record<BackendKind, BackendUiCaps> = {
  claude: {
    compact: true,
    usage: true,
    effort: true,
    model: true,
    mode: true,
    models: [
      { id: "", label: "Default" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-opus-4-7", label: "Opus 4.7" },
    ],
    efforts: [
      { id: "low", label: "Low", desc: "Fast, efficient" },
      { id: "medium", label: "Medium", desc: "Balanced" },
      { id: "high", label: "High", desc: "Default quality" },
      { id: "xhigh", label: "XHigh", desc: "Extended reasoning" },
      { id: "max", label: "Max", desc: "Maximum capability" },
    ],
  },
  codex: {
    compact: false,
    usage: false,
    // Codex exposes reasoning depth via `-c model_reasoning_effort=...`.
    // Valid backend values are none|minimal|low|medium|high|xhigh, but
    // `minimal` and `none` 400 against codex's built-in image_gen / web_search
    // tools — we expose only the safe subset.
    effort: true,
    model: true,
    // Codex auto-rejects MCP tool calls under any approval_policy; we
    // always pass --dangerously-bypass-approvals-and-sandbox so the chat
    // tool can call back. Permission modes therefore have no effect today.
    mode: false,
    models: [
      { id: "", label: "Default" },
      { id: "gpt-5-codex", label: "GPT-5 Codex (API key only)" },
      { id: "gpt-5", label: "GPT-5" },
    ],
    efforts: [
      { id: "low", label: "Low", desc: "Fast, efficient" },
      { id: "medium", label: "Medium", desc: "Balanced" },
      { id: "high", label: "High", desc: "Default quality" },
      { id: "xhigh", label: "XHigh", desc: "Extended reasoning" },
    ],
  },
};

export function capsFor(kind: BackendKind | undefined): BackendUiCaps {
  return BACKEND_CAPS[kind ?? "claude"];
}
