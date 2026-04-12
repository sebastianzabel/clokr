<script lang="ts">
  import { toasts, type Toast } from "$stores/toast";
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { onDestroy } from "svelte";

  // Subscribe to the toast store reactively
  let items: Toast[] = $state([]);
  const unsubscribe = toasts.subscribe((v) => (items = v));
  onDestroy(unsubscribe);

  // Only show the last 5 toasts
  let visible = $derived(items.slice(-5));

  // Respect prefers-reduced-motion — CSS override does not affect JS-driven Svelte transitions
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Map toast type to status color CSS variable prefix
  function colorVar(type: Toast["type"]): string {
    switch (type) {
      case "success":
        return "green";
      case "error":
        return "red";
      case "info":
        return "blue";
      case "warning":
        return "yellow";
    }
  }
</script>

{#if visible.length > 0}
  <div class="toast-container" role="status" aria-live="polite">
    {#each visible as toast (toast.id)}
      <div
        class="toast toast-{toast.type}"
        animate:flip={{ duration: reducedMotion ? 0 : 250 }}
        in:fly={{ x: reducedMotion ? 0 : 360, duration: reducedMotion ? 0 : 350, easing: (t) => 1 - Math.pow(1 - t, 3) }}
        out:fly={{ x: reducedMotion ? 0 : 360, duration: reducedMotion ? 0 : 250, easing: (t) => t * t }}
        style="
          --toast-color: var(--color-{colorVar(toast.type)});
          --toast-bg: var(--color-{colorVar(toast.type)}-bg);
          --toast-border: var(--color-{colorVar(toast.type)}-border);
        "
      >
        <span class="toast-icon">
          {#if toast.type === "success"}
            <!-- Checkmark circle -->
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M6.5 10.5L8.5 12.5L13.5 7.5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {:else if toast.type === "error"}
            <!-- X circle -->
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M7 7L13 13M13 7L7 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          {:else if toast.type === "info"}
            <!-- Info circle -->
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5" />
              <path d="M10 9V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <circle cx="10" cy="6.5" r="0.75" fill="currentColor" />
            </svg>
          {:else}
            <!-- Warning triangle -->
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
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

        <span class="toast-message">{toast.message}</span>

        <button class="toast-close" onclick={() => toasts.remove(toast.id)} aria-label="Schliessen">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4L12 12M12 4L4 12"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    max-width: 420px;
    width: calc(100vw - 3rem);
    pointer-events: none;
  }

  .toast {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.875rem 1rem 0.875rem calc(1rem + 6px);
    border-radius: var(--radius-sm);
    background: var(--glass-bg-overlay, var(--color-surface));
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--toast-border);
    box-shadow: var(--shadow-md);
    color: var(--color-text);
    font-size: 0.9375rem;
    line-height: 1.45;
    pointer-events: auto;
    will-change: transform, opacity;
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--toast-color);
    margin-top: 1px;
  }

  .toast-message {
    flex: 1;
    min-width: 0;
    word-break: break-word;
  }

  /* Visual size stays 24×24, hit area extended to 44×44 via padding (WCAG 2.5.5) */
  .toast-close {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    border-radius: 4px;
    padding: 10px;
    margin: -10px -10px -10px 0;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .toast-close:hover {
    background-color: var(--color-bg-muted);
    color: var(--color-text);
  }

  /* Colored left accent bar */
  .toast::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--toast-color);
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  }

  /* Mobile adjustments */
  @media (max-width: 480px) {
    .toast-container {
      bottom: 1rem;
      right: 1rem;
      left: 1rem;
      width: auto;
      max-width: none;
    }
  }
</style>
