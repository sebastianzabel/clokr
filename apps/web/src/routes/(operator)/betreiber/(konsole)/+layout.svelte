<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { loadSession } from "$stores/operator-auth";
  import { setUnauthorizedHandler } from "$lib/operator/client";
  import { buildSignInUrl } from "$lib/operator/next-path";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // SSR renders no authenticated content: the session lives in sessionStorage, so the guard can
  // only run in the browser. Until it has read the session the page shows a neutral line.
  let ready = $state(false);

  onMount(() => {
    // A 401/403 from any operator call clears the session and sends the browser to the sign-in.
    setUnauthorizedHandler((url) => {
      void goto(url);
    });

    if (loadSession() === null) {
      void goto(buildSignInUrl($page.url.pathname + $page.url.search, { expired: false }));
      return;
    }
    ready = true;
  });

  onDestroy(() => {
    setUnauthorizedHandler(null);
  });
</script>

<main id="main-content" class="op-main page-fade" data-testid="op-main">
  {#if ready}
    {@render children?.()}
  {:else}
    <p class="op-loading" role="status">Wird geladen …</p>
  {/if}
</main>

<style>
  .op-main {
    max-width: 1120px;
    margin-inline: auto;
    padding: 32px 24px 64px;
    min-width: 0;
  }

  .page-fade {
    animation: fadeUp 400ms var(--ease-out);
  }

  .op-loading {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .op-main {
      padding: 24px 16px 48px;
    }
  }
</style>
