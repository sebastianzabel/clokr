<script lang="ts">
  // Issue #843 (D-843-01 block 9, D-843-19, P9) - Rueckmeldung. The container is moved to
  // document.body, marked data-toast-root (Dialog.svelte's inert loop skips it), exists from app
  // start and holds two PERSISTENT, initially empty live regions: role=status for success, info and
  // warning, role=alert for errors. Items mount inside their region, so screen readers announce
  // every acknowledgement - also behind an open dialog.
  import { toasts, type Toast } from "$stores/toast";
  import { fade } from "$lib/motion";
  import { onDestroy } from "svelte";
  import ToastItem from "./ToastItem.svelte";

  let items: Toast[] = $state([]);
  const unsubscribe = toasts.subscribe((v) => (items = v));
  onDestroy(unsubscribe);

  // Only the last 5 toasts are shown.
  let visible = $derived(items.slice(-5));
  let polite = $derived(visible.filter((t) => t.type !== "error"));
  let assertive = $derived(visible.filter((t) => t.type === "error"));

  /** Moves the node to <body> (outside the app root) and takes it away again on destroy. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<div class="toast-container" data-toast-root use:portal>
  <div class="toast-region" data-testid="toast-region-status" role="status" aria-live="polite">
    {#each polite as toast (toast.id)}
      <div class="toast-slot" transition:fade>
        <ToastItem type={toast.type} message={toast.message} />
      </div>
    {/each}
  </div>
  <div class="toast-region" data-testid="toast-region-alert" role="alert">
    {#each assertive as toast (toast.id)}
      <div class="toast-slot" transition:fade>
        <ToastItem
          type={toast.type}
          message={toast.message}
          onClose={() => toasts.remove(toast.id)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
    left: 0;
    right: 0;
    margin-inline: auto;
    width: min(480px, calc(100vw - 2rem));
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    pointer-events: none;
  }

  .toast-slot {
    min-width: 0;
  }

  .toast-region {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
</style>
