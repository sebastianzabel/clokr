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

  /* Brand-coloured TEXT of the console. --brand (nacht #3d4dad) reads well on the light surfaces but
     only reaches about 2:1 on the dark ones (the theme does not re-declare it for dark mode), and
     --brand-light alone is 3.7-4.4:1 on a tinted badge. In dark mode the text uses a lightened
     --brand-light instead; the primary button keeps --brand as its fill. */
  .op-shell {
    --op-brand-text: var(--brand);
  }

  :global([data-mode="dark"]) .op-shell {
    --op-brand-text: color-mix(in srgb, var(--brand-light), #fff 40%);
  }

  /* The eyebrow recipe uses --brand-light, 3.7:1 on the light page background. */
  .op-shell :global(.eyebrow),
  .op-shell :global(.badge-purple) {
    color: var(--op-brand-text);
  }

  /* The modern skin paints the primary button as a gradient from --brand-light (white text 3.9:1);
     the console keeps the solid --brand fill of the editorial recipe whatever the skin. */
  .op-shell :global(.btn.btn-primary) {
    background: var(--brand);
    color: var(--text-on-brand);
  }

  :global([data-mode="dark"]) .op-shell :global(.badge-green) {
    color: var(--good-text);
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
