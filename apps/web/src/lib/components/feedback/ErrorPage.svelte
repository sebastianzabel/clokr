<script lang="ts">
  // Issue #855 (D-855-06): the error page for an unknown address or a failed load. `framed` stands on its
  // own with the logo (no shell: the root error page); unframed it sits inside the app shell. Text only
  // from `errorCopy` — never the raw error message.
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import Chip from "$lib/components/ui/Chip.svelte";
  import { SECONDARY_LABELS, errorCopy } from "./error-copy";

  interface Props {
    status: number;
    framed?: boolean;
  }

  let { status, framed = false }: Props = $props();

  const copy = $derived(errorCopy(status));

  function secondary() {
    if (copy.secondary === "reload") window.location.reload();
    else history.back();
  }
</script>

<svelte:head>
  <title>{copy.documentTitle} – Clokr</title>
</svelte:head>

{#snippet content()}
  <div class="error-page-status"><Chip tone="neutral">Fehler {status}</Chip></div>
  <p class="error-page-sentence">{copy.sentence}</p>
  <div class="error-page-actions">
    <a href="/" class="btn btn-primary">Zur Startseite</a>
    <button type="button" class="btn btn-secondary" onclick={secondary}
      >{SECONDARY_LABELS[copy.secondary]}</button
    >
  </div>
{/snippet}

{#if framed}
  <AuthFrame title={copy.title}>
    {@render content()}
  </AuthFrame>
{:else}
  <section class="error-page" aria-labelledby="error-page-title" data-testid="error-page">
    <h1 id="error-page-title" class="error-page-title">{copy.title}</h1>
    {@render content()}
  </section>
{/if}

<style>
  .error-page {
    max-width: 520px;
    margin: var(--s-16) auto;
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .error-page-title {
    font-size: var(--fs-h1);
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
    color: var(--text);
  }

  .error-page-sentence {
    margin: 0;
    color: var(--text-2);
  }

  .error-page-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
</style>
