<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import SignInSteps from "$lib/components/operator/SignInSteps.svelte";
  import LogoMark from "$lib/components/layout/LogoMark.svelte";
  import { operatorApi } from "$lib/operator/client";
  import { safeNext } from "$lib/operator/next-path";
  import { loadSession, setSession } from "$stores/operator-auth";

  type Phase = "checking" | "off" | "form";

  let phase = $state<Phase>("checking");

  // `?next=` goes through the allow-list; anything else lands on the console root.
  const target = $derived(safeNext($page.url.searchParams.get("next")) ?? "/betreiber");
  const notice = $derived(
    $page.url.searchParams.get("abgelaufen") === "1" ? "SESSION_EXPIRED" : null,
  );

  onMount(() => {
    if (loadSession() !== null) {
      void goto(target);
      return;
    }
    void operatorApi.probeSurface().then((surface) => {
      phase = surface === "off" ? "off" : "form";
    });
  });

  function handleSuccess(accessToken: string, expiresIn: number) {
    setSession(accessToken, expiresIn);
    void goto(target);
  }
</script>

<svelte:head>
  <title>Anmelden – Betreiber – Clokr</title>
</svelte:head>

<main id="main-content" class="op-signin-page" data-testid="op-signin-page">
  <div class="op-brand">
    <div class="op-wordmark">
      <LogoMark size={28} />
      <span>Clokr</span>
    </div>
    <span class="badge badge-purple">Betreiber</span>
  </div>

  <div class="op-card" aria-busy={phase === "checking"}>
    {#if phase !== "off"}
      <header class="op-card-head">
        <!-- eslint-disable-next-line clokr/ui -- standalone sign-in page without the console shell, same shape as the exempt (auth) pages -->
        <h1 class="op-card-title">Anmelden</h1>
        <p class="op-card-sub">Zugang für Betreiber</p>
      </header>
    {/if}

    {#if phase !== "checking"}
      <SignInSteps
        {notice}
        surfaceOff={phase === "off"}
        onLogin={operatorApi.login}
        onVerify={operatorApi.verify}
        onSuccess={handleSuccess}
      />
    {/if}
  </div>
</main>

<style>
  .op-signin-page {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 16px;
    background: var(--sunk);
  }

  .op-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .op-wordmark {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
  }

  .op-card {
    width: 100%;
    max-width: 420px;
    padding: 32px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    box-shadow: var(--shadow-pop);
  }

  .op-card-head {
    margin-bottom: 24px;
  }

  .op-card-title {
    margin: 0 0 4px;
    font-family: var(--font-ui);
    font-size: 22px;
    font-weight: 400;
    line-height: 1.2;
    color: var(--text);
  }

  .op-card-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-2);
  }

  @media (max-width: 400px) {
    .op-card {
      padding: 24px;
    }
  }
</style>
