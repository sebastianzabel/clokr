<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { clearSession, loadSession, operatorSession } from "$stores/operator-auth";
  import OperatorBar from "$lib/components/operator/OperatorBar.svelte";
  import { operatorApi, setUnauthorizedHandler } from "$lib/operator/client";
  import { remainingMs, sessionState } from "$lib/operator/countdown";
  import { buildSignInUrl } from "$lib/operator/next-path";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // SSR renders no authenticated content: the session lives in sessionStorage, so the guard can
  // only run in the browser. Until it has read the session the page shows a neutral line.
  let ready = $state(false);
  let displayName = $state<string | null>(null);
  let now = $state(Date.now());
  let ticker: ReturnType<typeof setInterval> | undefined;
  let leaving = false;

  // Always derived from the absolute expiry; a background tab throttles the interval, so the
  // next reading (or the visibilitychange below) catches up instead of drifting.
  const remaining = $derived(
    ready && $operatorSession ? remainingMs($operatorSession.expiresAt, now) : 0,
  );

  function leaveToSignIn() {
    if (leaving) return;
    leaving = true;
    clearSession();
    void goto(buildSignInUrl($page.url.pathname + $page.url.search, { expired: true }));
  }

  function logout() {
    leaving = true;
    clearSession();
    void goto("/betreiber/anmelden");
  }

  $effect(() => {
    if (ready && sessionState(remaining) === "expired") leaveToSignIn();
  });

  onMount(() => {
    // A 401/403 from any operator call clears the session and sends the browser to the sign-in.
    setUnauthorizedHandler((url) => {
      void goto(url);
    });

    if (loadSession() === null) {
      void goto(buildSignInUrl($page.url.pathname + $page.url.search, { expired: false }));
      return;
    }
    now = Date.now();
    ready = true;

    ticker = setInterval(() => {
      now = Date.now();
    }, 1000);

    // The name is decoration: a failure shows none (a 401 already redirected through the handler).
    operatorApi
      .me()
      .then((me) => {
        displayName = me.displayName;
      })
      .catch(() => {
        displayName = null;
      });
  });

  onDestroy(() => {
    if (ticker !== undefined) clearInterval(ticker);
    setUnauthorizedHandler(null);
  });
</script>

<svelte:document
  onvisibilitychange={() => {
    now = Date.now();
  }}
/>

{#if ready}
  <OperatorBar remainingMs={remaining} {displayName} onLogout={logout} />
{/if}

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
