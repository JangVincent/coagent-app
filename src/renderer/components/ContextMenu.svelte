<script lang="ts">
  import { onMount } from "svelte";

  let {
    x, y,
    agentName,
    onClose,
    onShowLogs,
  }: {
    x: number;
    y: number;
    agentName: string;
    onClose: () => void;
    onShowLogs?: () => void;
  } = $props();

  import { sendControl } from "../lib/ws-client.ts";
  import { agents, setAgentPaused } from "../lib/stores/agents.ts";
  import { capsFor } from "../lib/backend-caps.ts";

  let agent = $derived($agents.find((a) => a.name === agentName));
  let paused = $derived(agent?.paused ?? false);
  let caps = $derived(capsFor(agent?.kind));
  let showModeMenu = $state(false);
  let showModelMenu = $state(false);
  let showEffortMenu = $state(false);
  let confirmKill = $state(false);
  let confirmClear = $state(false);
  let menu: HTMLElement;

  // Initial position uses the click coords; the post-mount $effect below
  // re-clamps using the actual rendered height so the menu never spills off
  // the bottom (the main menu is ~360px tall — too long to estimate safely).
  const MENU_WIDTH = 200;
  const VIEWPORT_PAD = 8;
  let left = $state(Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_PAD));
  let top = $state(y);

  function reclamp() {
    if (!menu) return;
    const h = menu.offsetHeight;
    const w = menu.offsetWidth;
    const maxTop = window.innerHeight - h - VIEWPORT_PAD;
    if (y + h + VIEWPORT_PAD > window.innerHeight) {
      // Try to open above the cursor; if still off, pin to top with padding.
      top = Math.max(VIEWPORT_PAD, Math.min(y - h, maxTop));
    } else {
      top = y;
    }
    left = Math.min(x, window.innerWidth - w - VIEWPORT_PAD);
  }

  // Re-measure when the visible content changes (submenu navigation, confirm
  // sections) — the height shifts substantially between states.
  $effect(() => {
    void showModeMenu;
    void showModelMenu;
    void showEffortMenu;
    void confirmKill;
    void confirmClear;
    queueMicrotask(reclamp);
  });

  function send(op: string, arg?: string) {
    sendControl(agentName, op, arg);
    onClose();
  }

  function togglePause() {
    const next = !paused;
    // Optimistic update — control_ack will reaffirm/correct.
    setAgentPaused(agentName, next);
    sendControl(agentName, next ? "pause" : "resume");
    onClose();
  }

  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Small delay so the triggering right-click doesn't immediately close
    setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("keydown", keyHandler);
    }, 50);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  });

  const modes = [
    { value: "default", label: "Ask (default)" },
    { value: "acceptEdits", label: "Accept edits" },
    { value: "bypassPermissions", label: "Auto (bypass)" },
    { value: "plan", label: "Plan" },
  ];

  // Submenu lists are derived from the per-backend caps map; the leading
  // "Default" entry resets the override on the backend (sends `default`).
  let modelOptions = $derived([
    { id: "default", label: "Default" },
    ...caps.models.filter((m) => m.id !== "").map((m) => ({ id: m.id, label: m.label })),
  ]);
  let effortOptions = $derived([
    { id: "default", label: "Default" },
    ...caps.efforts.map((e) => ({ id: e.id, label: e.label })),
  ]);
</script>

<div class="menu" bind:this={menu} style:left="{left}px" style:top="{top}px" role="menu">
  <div class="menu-header">{agentName}</div>

  {#if confirmKill}
    <div class="confirm-section">
      <span class="confirm-label">Kill agent?</span>
      <div class="confirm-btns">
        <button class="confirm-yes" onclick={() => send("kill")}>Kill</button>
        <button class="confirm-no" onclick={() => { confirmKill = false; }}>Cancel</button>
      </div>
    </div>
  {:else if confirmClear}
    <div class="confirm-section">
      <span class="confirm-label">Clear session?</span>
      <div class="confirm-btns">
        <button class="confirm-yes" onclick={() => send("clear")}>Clear</button>
        <button class="confirm-no" onclick={() => { confirmClear = false; }}>Cancel</button>
      </div>
    </div>
  {:else if showModeMenu}
    <button class="item back" onclick={() => (showModeMenu = false)}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      Back
    </button>
    <div class="divider"></div>
    {#each modes as m}
      <button class="item" onclick={() => send("mode", m.value)}>{m.label}</button>
    {/each}
  {:else if showModelMenu}
    <button class="item back" onclick={() => (showModelMenu = false)}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      Back
    </button>
    <div class="divider"></div>
    {#each modelOptions as m}
      <button class="item" onclick={() => send("model", m.id)}>{m.label}</button>
    {/each}
  {:else if showEffortMenu}
    <button class="item back" onclick={() => (showEffortMenu = false)}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      Back
    </button>
    <div class="divider"></div>
    {#each effortOptions as e}
      <button class="item" onclick={() => send("effort", e.id)}>{e.label}</button>
    {/each}
  {:else}
    <button class="item" onclick={togglePause}>
      {paused ? "▶ Resume" : "⏸ Pause"}
    </button>
    <div class="divider"></div>
    <button class="item" onclick={() => send("status")}>/status</button>
    {#if caps.usage}
      <button class="item" onclick={() => send("usage")}>/usage</button>
    {/if}
    {#if caps.compact}
      <button class="item" onclick={() => send("compact")}>/compact</button>
    {/if}
    <button class="item" onclick={() => { confirmClear = true; }}>
      /clear session
    </button>
    {#if caps.mode || caps.model || caps.effort}
      <div class="divider"></div>
      {#if caps.mode}
        <button class="item submenu" onclick={() => (showModeMenu = true)}>
          Set mode
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 1l4 3.5L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      {/if}
      {#if caps.model}
        <button class="item submenu" onclick={() => (showModelMenu = true)}>
          Set model
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 1l4 3.5L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      {/if}
      {#if caps.effort}
        <button class="item submenu" onclick={() => (showEffortMenu = true)}>
          Set effort
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 1l4 3.5L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      {/if}
    {/if}
    <div class="divider"></div>
    <button class="item danger" onclick={() => { confirmKill = true; }}>/kill</button>
    <div class="divider"></div>
    <button class="item logs" onclick={() => { onShowLogs?.(); onClose(); }}>Show logs</button>
  {/if}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 9999;
    background: var(--bg-2);
    border: 1px solid var(--line-3);
    border-radius: var(--r-md);
    padding: 4px;
    min-width: 200px;
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
    animation: menu-in 140ms var(--ease);
    /* Cap height to viewport (with padding on both sides) so even on
       short windows the menu stays usable; falls back to scrolling. */
    max-height: calc(100vh - 16px);
    overflow-y: auto;
  }
  @keyframes menu-in {
    from { opacity: 0; transform: translateY(-2px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .menu-header {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    font-weight: 500;
    color: var(--text-3);
    padding: 6px 10px 8px;
    letter-spacing: var(--tr-cap);
    text-transform: uppercase;
    border-bottom: 1px solid var(--line-1);
    margin-bottom: 4px;
  }

  .divider {
    height: 1px;
    background: var(--line-1);
    margin: 4px 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-sm);
    color: var(--text-2);
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
    font-family: var(--font-mono);
    letter-spacing: 0;
  }
  .item:hover { background: var(--bg-4); color: var(--text-1); }

  .item.back { color: var(--text-3); font-family: var(--font-sans); font-size: var(--fs-xs); }
  .item.back:hover { color: var(--text-1); }

  .item.submenu { justify-content: space-between; font-family: var(--font-sans); }

  .item.danger { color: var(--danger); }
  .item.danger:hover { background: var(--danger-soft); }
  .item.logs { color: var(--text-3); font-family: var(--font-sans); font-size: var(--fs-xs); }
  .item.logs:hover { color: var(--text-1); }

  .confirm-section {
    padding: 8px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .confirm-label {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--fs-md);
    color: var(--text-1);
    padding: 0 2px;
    letter-spacing: 0;
  }
  .confirm-btns { display: flex; gap: 4px; }
  .confirm-yes {
    flex: 1;
    padding: 6px;
    border-radius: var(--r-sm);
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    background: var(--danger);
    color: var(--bg-0);
    transition: opacity var(--t-fast) var(--ease);
  }
  .confirm-yes:hover { opacity: 0.86; }
  .confirm-no {
    flex: 1;
    padding: 6px;
    border-radius: var(--r-sm);
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--line-2);
  }
  .confirm-no:hover { color: var(--text-1); background: var(--bg-4); }
</style>
