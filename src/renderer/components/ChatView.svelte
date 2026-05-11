<script lang="ts">
  import { messages } from "../lib/stores/messages.ts";
  import { selfName } from "../lib/stores/self.ts";
  import MarkdownMessage from "./MarkdownMessage.svelte";
  import { nameColor } from "../lib/name-color.ts";
  import { tick } from "svelte";

  let { roomId }: { roomId: string } = $props();

  let allMessages = $derived($messages);
  let chatList = $derived(allMessages.get(roomId) ?? []);
  let viewport: HTMLElement;
  let autoScroll = $state(true);

  function onScroll() {
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    autoScroll = scrollHeight - scrollTop - clientHeight < 80;
  }

  $effect(() => {
    void chatList.length;
    tick().then(() => {
      if (autoScroll && viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  });

  function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

</script>

<div class="chat-view" bind:this={viewport} onscroll={onScroll} role="log">
  {#each chatList as entry}
    {#if entry.kind === "chat"}
      {@const isMe = entry.from === $selfName}
      {@const noticeMatch = !isMe ? entry.content.match(/^\s*_\((notice|error):\s*(.*)\)_\s*$/s) : null}
      {@const legacyErrorMatch = !isMe && !noticeMatch ? entry.content.match(/^\s*_\((.*)\)_\s*$/s) : null}
      {#if noticeMatch}
        {@const noticeKind = noticeMatch[1]}
        {@const noticeText = noticeMatch[2]}
        {#if noticeKind === "notice"}
          <div class="system-msg">— {entry.from}: {noticeText} —</div>
        {:else}
          <div class="error-notice">
            <span class="error-notice-name" style:color={nameColor(entry.from)}>{entry.from}</span>
            <span class="error-notice-text">{noticeText}</span>
          </div>
        {/if}
      {:else if legacyErrorMatch}
        <div class="error-notice">
          <span class="error-notice-name" style:color={nameColor(entry.from)}>{entry.from}</span>
          <span class="error-notice-text">{legacyErrorMatch[1]}</span>
        </div>
      {:else}
        <div class="msg-wrap" class:msg-wrap-me={isMe}>
          {#if !isMe}
            <div class="sender-name" style:color={nameColor(entry.from)}>{entry.from}</div>
          {/if}
          <div class="bubble" class:bubble-me={isMe} class:bubble-agent={!isMe}>
            <MarkdownMessage content={entry.content} />
          </div>
          <div class="msg-time">{formatTime(entry.ts)}</div>
        </div>
      {/if}
    {:else if entry.kind === "system"}
      <div class="system-msg">— {entry.text} —</div>
    {:else if entry.kind === "control_ack"}
      <div class="ack-msg" class:ack-ok={entry.ok} class:ack-err={!entry.ok}>
        <span class="ack-op">/{entry.op}</span>
        {#if entry.info}<span class="ack-info">{entry.info}</span>{/if}
        {#if !entry.ok}<span class="ack-err-label">error</span>{/if}
      </div>
    {/if}
  {/each}

  {#if chatList.length === 0}
    <div class="empty">
      <p>No messages yet.</p>
      <p>Add an agent and say <code>@agent-name hello</code></p>
    </div>
  {/if}
</div>

<style>
  .chat-view {
    flex: 1;
    overflow-y: auto;
    padding: var(--s-6) var(--s-7);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .msg-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 76%;
    align-self: flex-start;
  }
  .msg-wrap-me {
    align-self: flex-end;
    align-items: flex-end;
  }

  .sender-name {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 500;
    padding-left: 2px;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    line-height: 1.1;
  }

  .bubble {
    padding: 10px 14px;
    border-radius: var(--r-lg);
    font-size: var(--fs-md);
    line-height: 1.62;
    box-shadow: var(--shadow-sm);
    animation: bubble-in 220ms var(--ease);
  }
  @keyframes bubble-in {
    from { opacity: 0; transform: translateY(2px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .bubble-agent {
    background: var(--bubble-agent);
    border: 1px solid var(--bubble-agent-line);
    border-radius: var(--r-lg) var(--r-lg) var(--r-lg) 4px;
  }
  .bubble-me {
    background: var(--bubble-self);
    border: 1px solid var(--bubble-self-line);
    border-radius: var(--r-lg) var(--r-lg) 4px var(--r-lg);
  }

  .msg-time {
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-3);
    padding: 0 2px;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .msg-wrap:hover .msg-time { opacity: 1; }

  .error-notice {
    align-self: flex-start;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 0 8px 12px;
    border-left: 2px solid var(--danger);
    font-size: var(--fs-sm);
    max-width: 88%;
  }
  .error-notice-name {
    font-family: var(--font-mono);
    font-weight: 500;
    font-size: var(--fs-cap);
    text-transform: lowercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .error-notice-text {
    color: var(--danger);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    letter-spacing: 0;
  }

  .system-msg {
    align-self: center;
    font-family: var(--font-mono);
    font-size: var(--fs-cap);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
    padding: 4px 0;
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .system-msg::before,
  .system-msg::after {
    content: "";
    width: 24px;
    height: 1px;
    background: var(--line-2);
  }

  .ack-msg {
    align-self: flex-start;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    padding: 6px 0 6px 14px;
    border-left: 1.5px solid var(--accent-line);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    max-width: 88%;
    letter-spacing: 0;
  }
  .ack-msg::before {
    content: "▸";
    color: var(--accent);
    font-size: 10px;
    margin-right: -4px;
    flex-shrink: 0;
  }
  .ack-err { border-left-color: var(--danger-line); }
  .ack-err::before { color: var(--danger); content: "✗"; }
  .ack-op {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  .ack-err .ack-op { color: var(--danger); }
  .ack-info {
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
    flex: 1;
  }
  .ack-err-label {
    color: var(--danger);
    font-size: var(--fs-cap);
    text-transform: uppercase;
    letter-spacing: var(--tr-cap);
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: var(--text-3);
    text-align: center;
  }
  .empty p:first-child {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--fs-2xl);
    line-height: 1.2;
    color: var(--text-2);
    letter-spacing: -0.01em;
  }
  .empty p:last-child {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-3);
  }
  .empty code {
    background: var(--bg-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    padding: 1.5px 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-2);
    letter-spacing: 0;
  }
</style>
