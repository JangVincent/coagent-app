<script lang="ts">
  import { agents } from "../lib/stores/agents.ts";
  import { nameColor } from "../lib/name-color.ts";
  import ActivityBadge from "./ActivityBadge.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import AgentLogPanel from "./AgentLogPanel.svelte";

  let { roomId }: { roomId: string } = $props();

  let roomAgents = $derived(
    $agents.filter((a) => a.room === roomId && a.status !== "exited")
  );

  let selectedAgent = $state<string | null>(null);
  let activeAgent = $derived(
    selectedAgent ?? roomAgents.find((a) => a.status === "running")?.name ?? roomAgents[0]?.name ?? null
  );

  // Context menu state
  let menuAgent = $state<string | null>(null);
  let menuX = $state(0);
  let menuY = $state(0);
  let logAgent = $state<string | null>(null);

  function openMenu(e: MouseEvent, agentName: string) {
    e.preventDefault();
    menuAgent = agentName;
    menuX = e.clientX;
    menuY = e.clientY;
  }
</script>

{#if roomAgents.length > 0}
  <div class="tab-bar">
    {#each roomAgents as a (a.name)}
      <button
        class="tab"
        class:active={a.name === activeAgent}
        onclick={(e) => { selectedAgent = a.name; openMenu(e, a.name); }}
        oncontextmenu={(e) => openMenu(e, a.name)}
        style:--agent-color={nameColor(a.name)}
        title="Click for options"
      >
        <span class="tab-dot"></span>
        <span class="tab-name">{a.name}</span>
        <ActivityBadge agentName={a.name} />
      </button>
    {/each}
  </div>
{/if}

{#if menuAgent}
  <ContextMenu
    x={menuX}
    y={menuY}
    agentName={menuAgent}
    onClose={() => (menuAgent = null)}
    onShowLogs={() => { logAgent = menuAgent; }}
  />
{/if}

{#if logAgent}
  <AgentLogPanel agentName={logAgent} onClose={() => (logAgent = null)} />
{/if}

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 var(--s-4);
    border-top: 1px solid var(--line-1);
    background: var(--bg-2);
    overflow-x: auto;
    /* CSS spec: setting overflow-x to a non-visible value auto-promotes
       overflow-y from visible to auto, which surfaces an unwanted
       vertical scrollbar. Pin overflow-y to hidden to keep this row a
       single-line horizontal scroller. */
    overflow-y: hidden;
    flex-shrink: 0;
    height: 34px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-3);
    border-bottom: 1.5px solid transparent;
    margin-bottom: -1px;
    transition: color var(--t-fast) var(--ease),
                border-color var(--t-fast) var(--ease),
                background var(--t-fast) var(--ease);
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0;
    position: relative;
  }
  .tab:hover { color: var(--agent-color); background: var(--bg-3); }
  .tab.active {
    color: var(--agent-color);
    border-bottom-color: var(--agent-color);
  }

  .tab-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--agent-color);
    flex-shrink: 0;
    opacity: 0.55;
    transition: opacity var(--t-fast) var(--ease),
                box-shadow var(--t-fast) var(--ease);
  }
  .tab.active .tab-dot {
    opacity: 1;
    box-shadow: 0 0 8px var(--agent-color);
  }

  .tab-name { font-weight: 500; font-size: var(--fs-sm); }
</style>
