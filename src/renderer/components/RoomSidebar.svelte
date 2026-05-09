<script lang="ts">
  import { rooms, activeRoomId, createRoom, ensureRoom, renameRoom, deleteRoom } from "../lib/stores/rooms.ts";
  import { agents, addAgent, dropAgents, renameAgentInStore } from "../lib/stores/agents.ts";
  import { dropRoom } from "../lib/stores/messages.ts";
  import { dropLogs } from "../lib/stores/agent-logs.ts";
  import { openTab, closeTab } from "../lib/stores/room-tabs.ts";
  import { activities } from "../lib/stores/activities.ts";
  import { selfName } from "../lib/stores/self.ts";
  import { reconnectWithName } from "../lib/ws-client.ts";
  import ActivityBadge from "./ActivityBadge.svelte";
  import AddAgentDialog from "./AddAgentDialog.svelte";
  import type { BackendKind, EffortLevel } from "@shared/types.ts";
  import { DEFAULT_ROOM } from "@shared/protocol.ts";

  let showNewRoom = $state(false);

  // Track which rooms have their agent list expanded (default: all collapsed)
  let expandedRooms = $state<Set<string>>(new Set());

  function toggleRoomExpanded(roomId: string) {
    const next = new Set(expandedRooms);
    if (next.has(roomId)) next.delete(roomId);
    else next.add(roomId);
    expandedRooms = next;
  }

  function autofocusEl(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // ── room rename ──────────────────────────────────────────────────
  let editingRoomId = $state<string | null>(null);
  let roomLabelInput = $state("");

  function startRenameRoom(roomId: string, currentLabel: string) {
    editingRoomId = roomId;
    roomLabelInput = currentLabel;
  }

  function saveRoomName() {
    const trimmed = roomLabelInput.trim();
    if (trimmed && editingRoomId) renameRoom(editingRoomId, trimmed);
    editingRoomId = null;
  }

  // ── identity ─────────────────────────────────────────────────────
  let editingName = $state(false);
  let nameInput = $state("");
  let showAbout = $state(false);

  function startEditName() {
    nameInput = $selfName;
    editingName = true;
  }

  function toggleAbout(e: MouseEvent) {
    e.stopPropagation();
    showAbout = !showAbout;
  }

  function dismissAbout(e: MouseEvent) {
    // Only dismiss when clicking outside the popover and the trigger
    const target = e.target as HTMLElement;
    if (!target.closest(".about-popover") && !target.closest(".identity-info")) {
      showAbout = false;
    }
  }

  $effect(() => {
    if (showAbout) {
      window.addEventListener("mousedown", dismissAbout);
      return () => window.removeEventListener("mousedown", dismissAbout);
    }
  });

  async function saveName() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== $selfName) {
      selfName.set(trimmed);
      await window.coagent.setSelfName(trimmed);
      reconnectWithName(trimmed); // re-register with hub under new name
    }
    editingName = false;
  }
  let newRoomLabel = $state("");

  function submitNewRoom() {
    const label = newRoomLabel.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || label;
    createRoom(id, label);
    openTab(id);
    newRoomLabel = "";
    showNewRoom = false;
  }

  let showAddDialog = $state(false);
  let addTargetRoom = $state(DEFAULT_ROOM);

  function addAgentToRoom(roomId: string) {
    addTargetRoom = roomId;
    // Auto-expand the room when adding an agent so the list is visible
    if (!expandedRooms.has(roomId)) {
      expandedRooms = new Set(expandedRooms).add(roomId);
    }
    showAddDialog = true;
  }

  async function handleAddAgent(opts: {
    name: string;
    cwd: string;
    kind: BackendKind;
    model?: string;
    effort: EffortLevel;
    resumeSessionId?: string;
  }) {
    showAddDialog = false;
    const room = addTargetRoom;
    ensureRoom(room);
    addAgent({
      name: opts.name,
      cwd: opts.cwd,
      room,
      kind: opts.kind,
      model: opts.model,
      effort: opts.effort,
      status: "starting",
    });
    openTab(room);
    const res = await window.coagent.spawnAgent({
      name: opts.name,
      cwd: opts.cwd,
      room,
      kind: opts.kind,
      model: opts.model,
      effort: opts.effort,
      resumeSessionId: opts.resumeSessionId,
    });
    if (!res.ok) console.error("spawn failed:", res.error);
  }

  function agentsInRoom(roomId: string) {
    return $agents.filter((a) => a.room === roomId);
  }

  // ── agent rename ────────────────────────────────────────────────
  let editingAgentName = $state<string | null>(null);
  let agentRenameInput = $state("");

  function startRenameAgent(name: string) {
    editingAgentName = name;
    agentRenameInput = name;
  }

  async function saveAgentName() {
    const oldName = editingAgentName;
    const newName = agentRenameInput.trim();
    editingAgentName = null;
    if (!oldName || !newName || newName === oldName) return;
    if ($agents.some((a) => a.name === newName)) {
      console.warn(`agent name '${newName}' already taken`);
      return;
    }
    const res = await window.coagent.renameAgent(oldName, newName);
    if (!res.ok) {
      console.error("rename failed:", res.error);
      return;
    }
    renameAgentInStore(oldName, newName);
  }

  // ── room delete ──────────────────────────────────────────────────
  let confirmDeleteRoomId = $state<string | null>(null);

  async function performDeleteRoom(roomId: string) {
    if (roomId === DEFAULT_ROOM) return;
    const roomAgents = agentsInRoom(roomId);
    const names = new Set(roomAgents.map((a) => a.name));

    // Kill any live agents (utilityProcess.kill via IPC). The agent's
    // ws closes on exit and the hub broadcasts an updated roster.
    await Promise.all(
      roomAgents
        .filter((a) => a.status !== "exited")
        .map((a) => window.coagent.killAgent(a.name))
    );

    // Drop client-side state: chat history, log buffers, agent entries, room itself.
    dropRoom(roomId);
    for (const n of names) dropLogs(n);
    dropAgents(names);
    closeTab(roomId);
    deleteRoom(roomId);

    confirmDeleteRoomId = null;
  }
</script>

<nav class="sidebar" aria-label="Rooms">
  <header class="sidebar-header">
    <span class="sidebar-title">Workspace</span>
    <button
      class="btn-ghost"
      class:active={showNewRoom}
      onclick={() => { showNewRoom = !showNewRoom; newRoomLabel = ""; }}
      title="New room"
      aria-label="New room"
    >
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M5.5 1.5v8M1.5 5.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>
  </header>

  {#if showNewRoom}
    <div class="row row--input">
      <span class="row-rail" aria-hidden="true">+</span>
      <input
        class="row-input"
        bind:value={newRoomLabel}
        placeholder="room-name"
        use:autofocusEl
        onkeydown={(e) => {
          if (e.key === "Enter") submitNewRoom();
          if (e.key === "Escape") { showNewRoom = false; }
        }}
      />
      <button class="row-submit" onclick={submitNewRoom}>create</button>
    </div>
  {/if}

  <div class="room-list" role="listbox">
    {#each $rooms as room (room.id)}
      {@const roomAgents = agentsInRoom(room.id)}
      {@const isActive = $activeRoomId === room.id}
      {@const isExpanded = expandedRooms.has(room.id)}
      {@const runningCount = roomAgents.filter(a => a.status !== "exited").length}

      <section class="room-section" class:active={isActive} class:expanded={isExpanded}>
        {#if editingRoomId === room.id}
          <div class="row row--room row--editing">
            <span class="row-chevron" aria-hidden="true">▾</span>
            <input
              class="row-input row-input--inline"
              bind:value={roomLabelInput}
              use:autofocusEl
              onkeydown={(e) => {
                if (e.key === "Enter") saveRoomName();
                if (e.key === "Escape") editingRoomId = null;
              }}
              onblur={saveRoomName}
            />
          </div>
        {:else if confirmDeleteRoomId === room.id}
          {@const liveCount = roomAgents.filter((a) => a.status !== "exited").length}
          <div class="row row--room row--confirm">
            <span class="row-chevron danger" aria-hidden="true">!</span>
            <span class="confirm-text">
              delete #{room.label}{liveCount > 0 ? ` · kill ${liveCount}` : ""}?
            </span>
            <button
              class="row-action danger"
              onclick={(e) => { e.stopPropagation(); performDeleteRoom(room.id); }}
              title="Confirm delete"
            >yes</button>
            <button
              class="row-action ghost"
              onclick={(e) => { e.stopPropagation(); confirmDeleteRoomId = null; }}
              title="Cancel"
            >no</button>
          </div>
        {:else}
          <div class="row row--room" class:is-active={isActive}>
            <button
              class="row-chevron-btn"
              onclick={(e) => { e.stopPropagation(); toggleRoomExpanded(room.id); }}
              aria-label={isExpanded ? "Collapse room" : "Expand room"}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              <span class="row-chevron">{isExpanded ? "▾" : "▸"}</span>
            </button>
            <button
              class="row-body"
              onclick={() => openTab(room.id)}
              ondblclick={() => startRenameRoom(room.id, room.label)}
              role="option"
              aria-selected={isActive}
              title="Double-click to rename"
            >
              <span class="row-hash">#</span>
              <span class="row-label">{room.label}</span>
              {#if runningCount > 0}
                <span class="count-badge">{runningCount}</span>
              {/if}
            </button>
            <div class="row-actions">
              <button
                class="btn-ghost"
                onclick={(e) => { e.stopPropagation(); addAgentToRoom(room.id); }}
                title="Add agent"
                aria-label="Add agent"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M5.5 1.5v8M1.5 5.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
              </button>
              {#if room.id !== DEFAULT_ROOM}
                <button
                  class="btn-ghost danger"
                  onclick={(e) => { e.stopPropagation(); confirmDeleteRoomId = room.id; }}
                  title="Delete room"
                  aria-label="Delete room"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path d="M2 3h7M4.5 3V2a1 1 0 011-1h0a1 1 0 011 1v1M3 3l.5 6.5a1 1 0 001 .9h2a1 1 0 001-.9L8 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              {/if}
            </div>
          </div>
        {/if}

        {#if isExpanded}
          <div class="agent-section">
            {#each roomAgents as agent (agent.name)}
              <div class="row row--agent" class:exited={agent.status === "exited"}>
                <span class="row-guide" aria-hidden="true"></span>
                <span class="dot" class:running={agent.status === "running"} class:starting={agent.status === "starting"} aria-hidden="true"></span>
                {#if editingAgentName === agent.name}
                  <input
                    class="row-input row-input--inline"
                    bind:value={agentRenameInput}
                    onkeydown={(e) => {
                      if (e.key === "Enter") saveAgentName();
                      if (e.key === "Escape") editingAgentName = null;
                    }}
                    onblur={saveAgentName}
                    use:autofocusEl
                  />
                {:else}
                  <button
                    class="agent-name"
                    ondblclick={() => agent.status === "running" && startRenameAgent(agent.name)}
                    title="Double-click to rename"
                  >{agent.name}</button>
                {/if}
                <span class="agent-activity"><ActivityBadge agentName={agent.name} /></span>
              </div>
            {/each}

            {#if roomAgents.length === 0}
              <div class="row row--agent row--empty">
                <span class="row-guide" aria-hidden="true"></span>
                <span class="empty-text">no agents</span>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <footer class="identity">
    {#if editingName}
      <div class="row row--identity row--editing">
        <span class="name-avatar">{(nameInput || "?")[0].toUpperCase()}</span>
        <input
          class="row-input row-input--inline"
          bind:value={nameInput}
          use:autofocusEl
          onkeydown={(e) => {
            if (e.key === "Enter") saveName();
            if (e.key === "Escape") editingName = false;
          }}
          onblur={saveName}
        />
      </div>
    {:else}
      <div class="row row--identity">
        <button class="identity-main" onclick={startEditName} title="이름 변경">
          <span class="name-avatar">{($selfName || "?")[0].toUpperCase()}</span>
          <span class="row-label">{$selfName || "—"}</span>
          <span class="identity-cue" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 8.5l1-3 5-5 2 2-5 5-3 1z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
              <path d="M6.5 1.5l2 2" stroke="currentColor" stroke-width="1.1"/>
            </svg>
          </span>
        </button>
        <button
          class="identity-info"
          class:active={showAbout}
          onclick={toggleAbout}
          title="앱 정보"
          aria-label="앱 정보"
          aria-expanded={showAbout}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="4.7" stroke="currentColor" stroke-width="1.1"/>
            <path d="M6 5.2v3M6 3.6v.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
        {#if showAbout}
          <div class="about-popover" role="dialog" aria-label="앱 정보">
            <div class="about-name">coagent</div>
            <div class="about-version">v{__APP_VERSION__}</div>
            <div class="about-divider" aria-hidden="true"></div>
            <a class="about-link" href="https://github.com/JangVincent/coagent-app/releases" target="_blank" rel="noopener noreferrer">Releases ↗</a>
            <a class="about-link" href="https://github.com/JangVincent/coagent-app" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          </div>
        {/if}
      </div>
    {/if}
  </footer>
</nav>

{#if showAddDialog}
  <AddAgentDialog
    roomId={addTargetRoom}
    onConfirm={handleAddAgent}
    onCancel={() => { showAddDialog = false; }}
  />
{/if}

<style>
  /* ── geometry tokens (component-local) ──────────────────────────── */
  .sidebar {
    /* every interactive slot in this column shares these */
    --row-h: 30px;
    --gutter-x: 10px;
    --rail-w: 2px;            /* active accent rail */
    --chevron-col: 18px;      /* chevron column width = nesting indent */
    --guide-x: calc(var(--gutter-x) + 8px); /* x of vertical guide line */

    width: 224px;
    flex-shrink: 0;
    border-right: 1px solid var(--line-1);
    background: var(--bg-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--font-mono);
  }

  /* ── header ──────────────────────────────────────────────────────── */
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: calc(var(--sidebar-top-padding, 12px) + 28px);
    padding: var(--sidebar-top-padding, 12px) var(--gutter-x) 6px;
    border-bottom: 1px solid var(--line-1);
    -webkit-app-region: drag;
    flex-shrink: 0;
  }
  .sidebar-title {
    font-size: var(--fs-cap);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    color: var(--text-3);
    /* tiny tick mark before the label, like a section register */
    position: relative;
    padding-left: 12px;
  }
  .sidebar-title::before {
    content: "";
    position: absolute;
    left: 0; top: 50%;
    width: 6px; height: 1px;
    background: var(--accent);
    transform: translateY(-0.5px);
  }

  /* ── shared icon button ─────────────────────────────────────────── */
  .btn-ghost {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--r-sm);
    color: var(--text-3);
    -webkit-app-region: no-drag;
    transition: color var(--t-fast) var(--ease),
                background var(--t-fast) var(--ease),
                opacity var(--t-fast) var(--ease);
  }
  .btn-ghost:hover { color: var(--text-1); background: var(--bg-4); }
  .btn-ghost.active { color: var(--accent); background: var(--accent-soft); }
  .btn-ghost.danger:hover { color: var(--danger); background: var(--danger-soft); }

  /* ── room list scroller ─────────────────────────────────────────── */
  .room-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  /* ── unified row primitive ──────────────────────────────────────── */
  .row {
    position: relative;
    display: flex;
    align-items: center;
    min-height: var(--row-h);
    padding: 0 var(--gutter-x);
    gap: 6px;
  }

  /* ── room section: continuous accent rail when active ───────────── */
  .room-section { position: relative; }
  .room-section::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: var(--rail-w);
    background: transparent;
    transition: background var(--t-base) var(--ease);
    pointer-events: none;
  }
  .room-section.active::before { background: var(--accent); }
  .room-section.active.expanded::before { bottom: 4px; }

  /* ── room row ────────────────────────────────────────────────────── */
  .row--room {
    padding-left: 0;
    padding-right: 4px;
  }
  .row--room:hover { background: var(--bg-4); }
  .row--room.is-active { background: var(--bg-2); }

  .row-chevron-btn {
    width: var(--chevron-col);
    height: var(--row-h);
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3);
    flex-shrink: 0;
    transition: color var(--t-fast) var(--ease);
  }
  .row-chevron-btn:hover { color: var(--text-1); }
  .row-chevron {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1;
    color: inherit;
    display: inline-block;
    width: 13px;
    text-align: center;
  }
  .row-chevron.danger { color: var(--danger); font-size: 13px; font-weight: 700; }

  .row-body {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    height: var(--row-h);
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
  }
  .row-hash {
    font-size: var(--fs-sm);
    color: var(--text-4);
    font-weight: 400;
    flex-shrink: 0;
    transition: color var(--t-fast) var(--ease);
  }
  .row--room.is-active .row-hash { color: var(--accent); }
  .row-label {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-2);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .row--room.is-active .row-label { color: var(--text-1); }

  .count-badge {
    font-size: var(--fs-cap);
    color: var(--text-3);
    background: transparent;
    border: 1px solid var(--line-2);
    border-radius: 100px;
    padding: 1px 6px 0;
    line-height: 1.4;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    transition: color var(--t-fast) var(--ease),
                border-color var(--t-fast) var(--ease),
                background var(--t-fast) var(--ease);
  }
  .row--room.is-active .count-badge {
    color: var(--accent-strong);
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .row--room:hover .row-actions,
  .row--room:focus-within .row-actions { opacity: 1; }

  /* ── inline editing room ───────────────────────────────────────── */
  .row--editing { background: var(--bg-2); }

  /* ── confirm delete row ────────────────────────────────────────── */
  .row--confirm {
    background: var(--danger-soft);
    padding-left: 0;
    padding-right: 4px;
  }
  .row--confirm .row-chevron.danger {
    width: var(--chevron-col);
    text-align: center;
  }
  .confirm-text {
    flex: 1;
    font-size: var(--fs-xs);
    color: var(--danger);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-action {
    height: 22px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-cap);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    flex-shrink: 0;
    transition: background var(--t-fast) var(--ease),
                color var(--t-fast) var(--ease),
                opacity var(--t-fast) var(--ease);
  }
  .row-action.danger { background: var(--danger); color: var(--bg-0); }
  .row-action.danger:hover { opacity: 0.86; }
  .row-action.ghost { color: var(--text-3); }
  .row-action.ghost:hover { color: var(--text-1); background: var(--bg-4); }

  /* ── agent section: nested column with hairline guide ──────────── */
  .agent-section {
    position: relative;
    padding: 2px 0 6px;
  }
  /* vertical guide line aligned with chevron column */
  .agent-section::before {
    content: "";
    position: absolute;
    left: var(--guide-x);
    top: 0;
    bottom: 8px;
    width: 1px;
    background: var(--line-1);
    pointer-events: none;
  }
  .room-section.active .agent-section::before { background: var(--line-2); }

  .row--agent {
    padding-left: calc(var(--chevron-col) + var(--gutter-x));
    padding-right: var(--gutter-x);
    min-height: 26px;
    gap: 8px;
  }
  .row--agent:hover { background: var(--bg-4); }
  .row--agent.exited { opacity: 0.35; }

  .row-guide {
    /* invisible spacer matching the rail offset; keeps the nested rows
       perfectly aligned with the room chevron column */
    width: 0;
    flex-shrink: 0;
  }

  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--text-4);
    flex-shrink: 0;
    box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.06);
    transition: background var(--t-fast) var(--ease);
  }
  .dot.starting {
    background: var(--text-3);
    animation: dot-pulse 1.4s var(--ease) infinite;
  }
  .dot.running {
    background: var(--accent);
    box-shadow: 0 0 0 0.5px var(--accent-line),
                0 0 8px oklch(0.78 0.13 65 / 0.35);
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.35; transform: scale(0.85); }
  }

  .agent-name {
    font-size: var(--fs-xs);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: text;
    transition: color var(--t-fast) var(--ease);
  }
  .row--agent:hover .agent-name { color: var(--text-1); }

  .agent-activity { flex-shrink: 0; }

  .row--empty .empty-text {
    font-size: var(--fs-cap);
    color: var(--text-4);
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    font-style: italic;
  }

  /* ── input rows (new room + new agent + rename) ─────────────────── */
  .row--input {
    padding-left: 0;
    padding-right: 4px;
    background: var(--bg-2);
  }
  /* room-level input row inherits .row padding; the rail glyph sits in
     the chevron slot so the input aligns with regular room labels */
  .row > .row-rail {
    width: var(--chevron-col);
    text-align: center;
    color: var(--accent);
    font-size: var(--fs-sm);
    font-weight: 600;
    flex-shrink: 0;
  }
  .row-input {
    flex: 1;
    min-width: 0;
    height: 22px;
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    padding: 0 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-1);
    outline: none;
    transition: border-color var(--t-fast) var(--ease);
  }
  .row-input::placeholder { color: var(--text-4); }
  .row-input:focus { border-color: var(--accent-line); }

  /* inline rename inputs sit invisibly in the row, no chrome */
  .row-input--inline {
    background: transparent;
    border: 1px solid transparent;
    border-bottom-color: var(--accent-line);
    border-radius: 0;
    padding: 0 2px;
    height: 20px;
    font-size: var(--fs-sm);
  }
  .row--agent .row-input--inline { font-size: var(--fs-xs); }

  .row-submit {
    height: 22px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-cap);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    color: var(--accent-strong);
    flex-shrink: 0;
    transition: background var(--t-fast) var(--ease),
                color var(--t-fast) var(--ease);
  }
  .row-submit:hover { background: var(--accent-line); color: var(--text-1); }

  /* ── identity footer (matches row geometry) ─────────────────────── */
  .identity {
    border-top: 1px solid var(--line-1);
    padding: 6px var(--s-1);
    flex-shrink: 0;
    background: var(--bg-1);
  }
  .row--identity {
    width: 100%;
    border: none;
    color: inherit;
    border-radius: var(--r-sm);
    padding: 0 4px 0 0;
    gap: 4px;
    position: relative;
  }
  .identity-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--row-h);
    padding: 0 8px;
    border-radius: var(--r-sm);
    text-align: left;
    color: inherit;
    transition: background var(--t-fast) var(--ease);
  }
  .identity-main:hover { background: var(--bg-4); }
  .name-avatar {
    width: 22px; height: 22px;
    border-radius: var(--r-sm);
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700;
    font-size: var(--fs-xs);
    flex-shrink: 0;
    color: var(--accent);
    letter-spacing: 0;
  }
  .identity-main .row-label {
    font-size: var(--fs-sm);
    color: var(--text-1);
    font-weight: 500;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .identity-cue {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-4);
    opacity: 0;
    flex-shrink: 0;
    transition: opacity var(--t-fast) var(--ease),
                color var(--t-fast) var(--ease);
  }
  .identity-main:hover .identity-cue { opacity: 1; color: var(--text-2); }

  .identity-info {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--r-sm);
    color: var(--text-4);
    flex-shrink: 0;
    transition: color var(--t-fast) var(--ease),
                background var(--t-fast) var(--ease);
  }
  .identity-info:hover { color: var(--text-1); background: var(--bg-4); }
  .identity-info.active { color: var(--accent); background: var(--accent-soft); }

  .about-popover {
    position: absolute;
    right: 4px;
    bottom: calc(100% + 6px);
    min-width: 160px;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--line-2);
    border-radius: var(--r-md, 6px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28),
                0 1px 2px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 50;
  }
  .about-name {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-1);
  }
  .about-version {
    font-size: var(--fs-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .about-divider {
    height: 1px;
    background: var(--line-1);
    margin: 4px -4px;
  }
  .about-link {
    font-size: var(--fs-xs);
    color: var(--text-2);
    text-decoration: none;
    padding: 2px 0;
    transition: color var(--t-fast) var(--ease);
  }
  .about-link:hover { color: var(--accent); }
</style>
