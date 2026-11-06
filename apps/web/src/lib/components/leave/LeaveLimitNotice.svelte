<script lang="ts">
  /**
   * LeaveLimitNotice — Issue #836 (plan 07, AC-5, D-836-08).
   *
   * The non-blocking notice after a request exceeded a leave limit. The request is already saved;
   * this block only tells the person which limit is exceeded on how many days. The sentences are
   * built by `warningSentences()` from the API payload — nothing is counted here. Renders nothing
   * without sentences.
   */
  interface Props {
    sentences: string[];
    onDismiss: () => void;
  }

  let { sentences, onDismiss }: Props = $props();
</script>

{#if sentences.length > 0}
  <div class="callout leave-limit-notice" role="status" data-testid="leave-limit-notice">
    <span class="ico" aria-hidden="true">⚠</span>
    <div class="leave-limit-notice-body">
      <p><b>Hinweis zur Urlaubsplanung</b></p>
      {#each sentences as sentence (sentence)}
        <p data-testid="leave-limit-sentence">{sentence}</p>
      {/each}
    </div>
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      aria-label="Hinweis schließen"
      data-testid="leave-limit-notice-close"
      onclick={onDismiss}>Schließen</button
    >
  </div>
{/if}

<style>
  /* Colour comes from the global .callout recipe (app.css) — only layout here. */
  .leave-limit-notice {
    margin-bottom: 1rem;
    align-items: flex-start;
  }
  .leave-limit-notice-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }
</style>
