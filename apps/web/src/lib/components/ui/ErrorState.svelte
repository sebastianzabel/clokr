<script lang="ts">
  // Issue #843 (D-843-01 block 10) - the error state: a bad Note plus one retry button. The region is
  // role=alert so a failed load is announced; while retrying the button is disabled and shows the spinner.
  import Note from "./Note.svelte";
  import Spinner from "./Spinner.svelte";

  interface Props {
    message?: string;
    hint?: string;
    onRetry: () => void;
    retrying?: boolean;
  }

  let {
    message = "Das hat nicht geklappt.",
    hint = "Bitte versuche es noch einmal.",
    onRetry,
    retrying = false,
  }: Props = $props();
</script>

<div class="error-state" role="alert">
  <Note tone="bad">{hint ? `${message} ${hint}` : message}</Note>
  <button type="button" class="btn btn-secondary btn-sm" disabled={retrying} onclick={onRetry}>
    {#if retrying}<Spinner size={14} />{/if}
    Erneut versuchen
  </button>
</div>

<style>
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
  }
</style>
