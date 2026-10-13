<script lang="ts">
  import { onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import { pinOperatorLook } from "$lib/operator/theme-pin";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // The console has a fixed look (theme nacht, density comfortable, editorial skin). The wrapper
  // below carries the attributes for the server-rendered HTML; this pins <html> as well, because
  // body, scrollbars and the toast live outside the wrapper. Written straight to the DOM, never
  // through the preference stores, and put back on destroy so the tenant app is not left pinned.
  let restoreLook: (() => void) | undefined;
  if (browser) {
    restoreLook = pinOperatorLook(document.documentElement);
  }

  onDestroy(() => {
    restoreLook?.();
  });
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="op-shell" data-theme="nacht" data-density="comfortable" data-testid="op-shell">
  <a href="#main-content" class="op-skip">Zum Inhalt springen</a>
  {@render children?.()}
</div>

<style>
  .op-shell {
    min-height: 100dvh;
    background: var(--bg);
    color: var(--text);
  }

  .op-skip {
    position: absolute;
    top: -48px;
    left: 8px;
    padding: 8px 16px;
    background: var(--brand);
    color: white;
    text-decoration: none;
    border-radius: var(--r-sm);
    z-index: 1000;
    transition: top 120ms var(--ease);
  }

  .op-skip:focus {
    top: 8px;
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
</style>
