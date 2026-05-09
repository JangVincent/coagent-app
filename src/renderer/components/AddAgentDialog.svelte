<script lang="ts">
  import type { BackendKind, CodexTrustStatus, EffortLevel, PastSession } from "@shared/types.ts";
  import { capsFor } from "../lib/backend-caps.ts";

  let { roomId, onConfirm, onCancel }: {
    roomId: string;
    onConfirm: (opts: {
      name: string;
      cwd: string;
      kind: BackendKind;
      model?: string;
      effort: EffortLevel;
      resumeSessionId?: string;
    }) => void;
    onCancel: () => void;
  } = $props();

  let cwd = $state("");
  let name = $state("");
  let kind = $state<BackendKind>("claude");
  let model = $state("");
  let effort = $state<EffortLevel>("xhigh");
  let sessions = $state<PastSession[]>([]);
  let selectedSession = $state<string | "fresh">("fresh");
  let step = $state<"config" | "session">("config");

  // Codex trust state for the selected directory. `null` means we haven't
  // checked yet (still loading or kind != codex).
  let trustStatus = $state<CodexTrustStatus | null>(null);
  let trustOptIn = $state(false);
  let trustError = $state<string | null>(null);

  let caps = $derived(capsFor(kind));

  // Reset model when switching backends so a stale Claude/Codex id doesn't carry over.
  $effect(() => {
    void kind;
    model = "";
  });

  // Re-check codex trust whenever the user changes backend or directory.
  $effect(() => {
    if (kind !== "codex" || !cwd) {
      trustStatus = null;
      trustOptIn = false;
      trustError = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await window.coagent.checkCodexTrust(cwd);
      if (cancelled) return;
      trustStatus = r.status;
      // Default the opt-in to ON when status is unset — most users adding
      // a Codex agent in their project want full layer support. They can
      // uncheck if they prefer to set this manually later.
      trustOptIn = r.status === "unset";
    })();
    return () => {
      cancelled = true;
    };
  });

  async function pickDirectory() {
    const result = await window.coagent.pickFolder();
    if (!result.path) return;
    cwd = result.path;
    const parts = result.path.replace(/\\/g, "/").split("/").filter(Boolean);
    name = parts[parts.length - 1] ?? "agent";
  }

  async function handleNext() {
    if (!cwd || !name.trim()) return;
    // Codex resume isn't wired yet — always go straight to spawn.
    if (kind === "codex") {
      // Apply trust opt-in before spawning. If it fails (e.g. project is
      // explicitly untrusted), surface the error and stop — let the user
      // fix it manually rather than silently proceeding.
      if (trustOptIn && trustStatus === "unset") {
        const r = await window.coagent.trustCodexProject(cwd);
        if (!r.ok) {
          trustError = r.error ?? "failed to update ~/.codex/config.toml";
          trustStatus = r.status;
          return;
        }
        trustStatus = r.status;
        trustError = null;
      }
      doConfirm(undefined);
      return;
    }
    const { sessions: found } = await window.coagent.listSessions(cwd);
    if (found.length > 0) {
      sessions = found;
      step = "session";
    } else {
      doConfirm(undefined);
    }
  }

  function doConfirm(resumeSessionId: string | undefined) {
    onConfirm({
      name: name.trim(),
      cwd,
      kind,
      model: model || undefined,
      effort,
      resumeSessionId,
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && step === "config" && cwd && name.trim()) handleNext();
  }

  function fmtAgo(ms: number): string {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="overlay" role="dialog" aria-modal="true">
  <div class="dialog">
    {#if step === "config"}
      <div class="dialog-header">
        <span class="dialog-title">Add Agent</span>
        <span class="dialog-subtitle">to #{roomId}</span>
      </div>

      <div class="dialog-body">
        <div class="field">
          <label class="field-label" for="cwd-input">Directory</label>
          <div class="field-row">
            <input
              id="cwd-input"
              type="text"
              class="field-input"
              bind:value={cwd}
              placeholder="Select a directory..."
              readonly
            />
            <button class="btn-browse" onclick={pickDirectory}>Browse</button>
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="name-input">Agent Name</label>
          <input
            id="name-input"
            type="text"
            class="field-input"
            bind:value={name}
            placeholder="my-agent"
          />
        </div>

        <div class="field">
          <span class="field-label">Backend</span>
          <div class="kind-row">
            <label class="kind-option" class:selected={kind === "claude"}>
              <input type="radio" name="kind" value="claude" bind:group={kind} />
              <span>Claude</span>
            </label>
            <label class="kind-option" class:selected={kind === "codex"}>
              <input type="radio" name="kind" value="codex" bind:group={kind} />
              <span>Codex</span>
            </label>
          </div>
        </div>

        <div class="field-row-2">
          <div class="field">
            <label class="field-label" for="model-select">Model</label>
            <select id="model-select" class="field-select" bind:value={model}>
              {#each caps.models as m}
                <option value={m.id}>{m.label}</option>
              {/each}
            </select>
          </div>

          {#if caps.effort}
            <div class="field">
              <label class="field-label" for="effort-select">Effort</label>
              <select id="effort-select" class="field-select" bind:value={effort}>
                {#each caps.efforts as e}
                  <option value={e.id}>{e.label}</option>
                {/each}
              </select>
            </div>
          {:else}
            <div class="field">
              <span class="field-label">Effort</span>
              <div class="field-na">— not used by {kind === "codex" ? "Codex" : kind}</div>
            </div>
          {/if}
        </div>

        {#if caps.effort}
          <div class="effort-hint">
            {caps.efforts.find(e => e.id === effort)?.desc ?? ""}
          </div>
        {/if}

        {#if kind === "codex"}
          <div class="codex-hint">
            Codex requires <code>codex login</code> first. Available models depend on your auth (ChatGPT subscription vs API key).
          </div>
          {#if cwd && trustStatus === "trusted"}
            <div class="trust-row trust-ok">
              <span class="trust-icon">✓</span>
              <span>Project trusted — <code>.codex/config.toml</code>, hooks, and project subagents will load.</span>
            </div>
          {:else if cwd && trustStatus === "untrusted"}
            <div class="trust-row trust-err">
              <span class="trust-icon">✕</span>
              <span>This path is explicitly marked <em>untrusted</em> in <code>~/.codex/config.toml</code>. Edit that file manually to flip it.</span>
            </div>
          {:else if cwd && trustStatus === "unset"}
            <label class="trust-row trust-toggle">
              <input type="checkbox" bind:checked={trustOptIn} />
              <span class="trust-text">
                <span class="trust-title">Trust this project</span>
                <span class="trust-detail">
                  Adds <code>[projects.&quot;{cwd}&quot;]</code> with <code>trust_level = "trusted"</code> to <code>~/.codex/config.toml</code>
                  so codex loads project-scoped <code>.codex/config.toml</code>, hooks, and subagents.
                </span>
              </span>
            </label>
          {/if}
          {#if trustError}
            <div class="trust-row trust-err">
              <span class="trust-icon">✕</span>
              <span>{trustError}</span>
            </div>
          {/if}
        {/if}
      </div>

      <div class="dialog-footer">
        <button class="btn-cancel" onclick={onCancel}>Cancel</button>
        <button
          class="btn-confirm"
          disabled={!cwd || !name.trim()}
          onclick={handleNext}
        >
          Add
        </button>
      </div>
    {:else}
      <div class="dialog-header">
        <span class="dialog-title">Resume session?</span>
        <code class="dialog-cwd">{cwd}</code>
      </div>

      <div class="session-list" role="radiogroup">
        <label class="session-item" class:selected={selectedSession === "fresh"}>
          <input type="radio" name="session" value="fresh" bind:group={selectedSession} />
          <span class="session-label">Start fresh</span>
        </label>
        {#each sessions as s}
          <label class="session-item" class:selected={selectedSession === s.sid}>
            <input type="radio" name="session" value={s.sid} bind:group={selectedSession} />
            <span class="session-label">{s.preview || "(no preview)"}</span>
            <span class="session-meta">{fmtAgo(s.mtimeMs)} · ~{s.turns} turns</span>
          </label>
        {/each}
      </div>

      <div class="dialog-footer">
        <button class="btn-cancel" onclick={() => (step = "config")}>Back</button>
        <button
          class="btn-confirm"
          onclick={() => doConfirm(selectedSession === "fresh" ? undefined : selectedSession)}
        >
          {selectedSession === "fresh" ? "Start fresh" : "Resume"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(6px);
    animation: overlay-in 180ms var(--ease);
  }
  @keyframes overlay-in { from { opacity: 0; } to { opacity: 1; } }

  .dialog {
    background: var(--bg-2);
    border: 1px solid var(--line-3);
    border-radius: var(--r-xl);
    width: 420px;
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    animation: dialog-in 220ms var(--ease);
  }
  @keyframes dialog-in {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .dialog-header {
    padding: 22px 24px 16px;
    border-bottom: 1px solid var(--line-1);
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .dialog-title {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--fs-xl);
    font-weight: 400;
    color: var(--text-1);
    letter-spacing: -0.005em;
  }
  .dialog-subtitle {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-3);
  }
  .dialog-cwd {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-3);
    letter-spacing: 0;
  }

  .dialog-body {
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    color: var(--text-3);
  }
  .field-row {
    display: flex;
    gap: 8px;
  }
  .field-row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .field-input {
    flex: 1;
    min-height: 34px;
    height: 34px;
    padding: 0 12px;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-1);
    outline: none;
    transition: border-color var(--t-fast) var(--ease);
    box-sizing: border-box;
  }
  .field-input::placeholder { color: var(--text-4); }
  .field-input:focus { border-color: var(--accent-line); }
  .field-input[readonly] {
    cursor: pointer;
    color: var(--text-2);
  }

  .field-select {
    height: 34px;
    padding: 0 10px;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-1);
    cursor: pointer;
    outline: none;
    transition: border-color var(--t-fast) var(--ease);
  }
  .field-select:focus { border-color: var(--accent-line); }
  .field-select:hover { border-color: var(--line-3); }

  .btn-browse {
    padding: 0 14px;
    height: 34px;
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    background: var(--bg-4);
    border: 1px solid var(--line-2);
    color: var(--text-2);
    cursor: pointer;
    transition: all var(--t-fast) var(--ease);
    flex-shrink: 0;
  }
  .btn-browse:hover {
    background: var(--bg-3);
    border-color: var(--line-3);
    color: var(--text-1);
  }

  .effort-hint {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-4);
    text-align: center;
    padding: 4px 0 0;
  }

  .kind-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .kind-option {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-2);
    cursor: pointer;
    transition: all var(--t-fast) var(--ease);
  }
  .kind-option:hover {
    border-color: var(--line-3);
    color: var(--text-1);
  }
  .kind-option.selected {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--text-1);
  }
  .kind-option input {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.5px solid var(--line-3);
    flex-shrink: 0;
    position: relative;
  }
  .kind-option.selected input { border-color: var(--accent); }
  .kind-option.selected input::after {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: var(--accent);
  }
  .field-na {
    height: 34px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-4);
    border: 1px dashed var(--line-2);
    border-radius: var(--r);
  }

  .codex-hint {
    font-family: var(--font-sans);
    font-size: var(--fs-cap);
    color: var(--text-3);
    line-height: 1.45;
  }
  .codex-hint code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--text-2);
    background: var(--bg-3);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .trust-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--fs-cap);
    line-height: 1.45;
    border: 1px solid var(--line-2);
    background: var(--bg-3);
  }
  .trust-row code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    color: var(--text-2);
    background: var(--bg-4);
    padding: 1px 4px;
    border-radius: 3px;
    word-break: break-all;
  }
  .trust-icon {
    font-family: var(--font-mono);
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .trust-ok { color: var(--text-2); border-color: var(--line-3); }
  .trust-ok .trust-icon { color: var(--accent); }
  .trust-err { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
  .trust-err .trust-icon { color: var(--danger); }

  .trust-toggle {
    cursor: pointer;
    transition: border-color var(--t-fast) var(--ease);
  }
  .trust-toggle:hover { border-color: var(--line-3); }
  .trust-toggle input {
    appearance: none;
    width: 16px;
    height: 16px;
    border: 1.5px solid var(--line-3);
    border-radius: 3px;
    flex-shrink: 0;
    margin-top: 1px;
    cursor: pointer;
    position: relative;
    background: var(--bg-2);
    transition: all var(--t-fast) var(--ease);
  }
  .trust-toggle input:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .trust-toggle input:checked::after {
    content: "✓";
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--bg-0);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .trust-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .trust-title {
    color: var(--text-1);
    font-weight: 500;
  }
  .trust-detail {
    color: var(--text-3);
    font-size: var(--fs-cap);
  }

  .session-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: var(--s-2);
    gap: 2px;
  }
  .session-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--r);
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease),
                border-color var(--t-fast) var(--ease);
  }
  .session-item:hover { background: var(--bg-3); }
  .session-item.selected {
    background: var(--accent-soft);
    border-left-color: var(--accent);
  }
  .session-item input {
    appearance: none;
    width: 14px; height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--line-3);
    flex-shrink: 0;
    transition: all var(--t-fast) var(--ease);
    cursor: pointer;
    position: relative;
  }
  .session-item input:checked {
    border-color: var(--accent);
  }
  .session-item input:checked::after {
    content: "";
    position: absolute;
    inset: 2.5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .session-label {
    font-size: var(--fs-sm);
    flex: 1;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-meta {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-3);
    flex-shrink: 0;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-top: 1px solid var(--line-1);
    flex-shrink: 0;
  }
  .btn-cancel {
    padding: 7px 14px;
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    border: 1px solid var(--line-2);
    background: transparent;
    transition: all var(--t-fast) var(--ease);
  }
  .btn-cancel:hover { border-color: var(--line-3); color: var(--text-1); }
  .btn-confirm {
    padding: 7px 16px;
    border-radius: var(--r);
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--accent);
    color: var(--bg-0);
    transition: background var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
  }
  .btn-confirm:hover { background: var(--accent-strong); }
  .btn-confirm:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
