<script lang="ts">
  // Issue #843 (D-843-01 block 9) - the ONE markup of a toast item. Toast.svelte renders it inside
  // its live regions, the Bausteine page renders it statically. The classes `toast toast-{type}`,
  // `.toast-icon`, `.toast-message` and `.toast-close` are selected by e2e specs, keep them.
  import type { Toast } from "$stores/toast";

  interface Props {
    type: Toast["type"];
    message: string;
    /** Called by the close button, which exists for errors only. */
    onClose?: () => void;
  }

  let { type, message, onClose }: Props = $props();
</script>

<div class="toast toast-{type}">
  <span class="toast-icon">
    {#if type === "success"}
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M6.5 10.5L8.5 12.5L13.5 7.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {:else if type === "error"}
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M7 7L13 13M13 7L7 13"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    {:else if type === "info"}
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
        <path d="M10 9V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="10" cy="6.5" r="0.75" fill="currentColor" />
      </svg>
    {:else}
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 2.5L18.5 17.5H1.5L10 2.5Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M10 8V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <circle cx="10" cy="14.5" r="0.75" fill="currentColor" />
      </svg>
    {/if}
  </span>

  <span class="toast-message">{message}</span>

  {#if type === "error"}
    <button type="button" class="toast-close" onclick={() => onClose?.()} aria-label="Schließen">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4 4L12 12M12 4L4 12"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  {/if}
</div>

<style>
  /* Inverse surface: --text as the fill and --card as the text, the proven pair turned around. */
  .toast {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    padding: 0.75rem 1rem 0.75rem calc(1rem + 4px);
    border-radius: var(--r-control);
    background: var(--text);
    color: var(--card);
    box-shadow: var(--shadow-pop);
    font-size: var(--fs-base);
    line-height: 1.45;
    pointer-events: auto;
    overflow: hidden;
  }

  /* The type shows as a colour fill on the left edge, never as text colour. */
  .toast::before {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: var(--toast-fill);
  }
  .toast-success {
    --toast-fill: var(--ok);
  }
  .toast-error {
    --toast-fill: var(--bad);
  }
  .toast-info {
    --toast-fill: var(--info);
  }
  .toast-warning {
    --toast-fill: var(--warn);
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    margin-top: 2px;
    color: var(--card);
  }

  .toast-message {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* Visual size 24 x 24, hit area stretched with padding. */
  .toast-close {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--card);
    cursor: pointer;
    border-radius: 4px;
    padding: 10px;
    margin: -10px -10px -10px 0;
    box-sizing: content-box;
    opacity: 0.8;
  }
  .toast-close:hover {
    opacity: 1;
  }
  .toast-close:focus-visible {
    outline: 2px solid var(--card);
    outline-offset: 0;
    opacity: 1;
  }
</style>
