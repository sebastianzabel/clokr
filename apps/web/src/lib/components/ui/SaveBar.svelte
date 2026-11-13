<script lang="ts">
  // Issue #843 (D-843-01 block 7) - the save bar of a form group. It is the section-button rule of
  // docs/ADMIN_STRUCTURE.md §3.2.1 as code: text and number fields of a group save through ONE
  // button, so the bar exists only while there is something unsaved. The page owns the save
  // handler; the bar never talks to the API.
  import Spinner from "./Spinner.svelte";
  import { canSave, errorsPhrase, saveBarSummary } from "./save-bar";

  interface Props {
    /** Number of unsaved changes; the bar is hidden at 0. */
    changes: number;
    /** Number of invalid fields; saving is blocked while above 0. */
    errors: number;
    /** A save is running: the label stays, a spinner sits inside the button. */
    saving?: boolean;
    /** What the save does ("Vertrag speichern"), never a bare "Speichern". */
    saveLabel: string;
    onSave: () => void;
    onDiscard: () => void;
  }

  let { changes, errors, saving = false, saveLabel, onSave, onDiscard }: Props = $props();

  const enabled = $derived(canSave({ changes, errors, saving }));
</script>

{#if changes > 0}
  <div class="save-bar" role="region" aria-label="Speicherleiste">
    <p class="save-bar-summary">
      {saveBarSummary(changes, 0)}{#if errors > 0}<span aria-hidden="true"> · </span><span
          class="save-bar-errors">{errorsPhrase(errors)}</span
        >{/if}
    </p>
    <div class="save-bar-actions">
      <button type="button" class="btn btn-secondary" disabled={saving} onclick={() => onDiscard()}>
        Verwerfen
      </button>
      <button
        type="button"
        class="btn btn-primary save-bar-save"
        disabled={!enabled}
        onclick={() => enabled && onSave()}
      >
        {#if saving}<Spinner size={14} label="Wird gespeichert" />{/if}
        {saveLabel}
      </button>
    </div>
  </div>
{/if}

<style>
  .save-bar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-3);
    box-sizing: border-box;
    padding: var(--s-2) var(--s-4);
    background: var(--card);
    border-top: 1px solid var(--line);
    box-shadow: var(--shadow);
  }

  .save-bar-summary {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .save-bar-errors {
    color: var(--bad);
    font-weight: 600;
  }

  .save-bar-actions {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    margin-left: auto;
  }

  .save-bar-actions :global(.btn) {
    min-height: var(--h-control);
  }

  .save-bar-save {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
</style>
