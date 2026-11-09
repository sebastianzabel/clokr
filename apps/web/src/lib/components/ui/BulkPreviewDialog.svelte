<script lang="ts">
  // Issue #843 (D-843-01 block 7) - the bulk-change pattern helper: a Dialog that shows what a
  // write would touch (count, list, effective date) BEFORE the write, and the one place the
  // confirmation happens. A SaveBar hands a many-record change over to it. The server owns the
  // candidate set and the date; this block only displays what the caller passes and never
  // computes a date (§ 3 NachwG, #568).
  import type { Snippet } from "svelte";
  import Dialog from "./Dialog.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { fmtDateDe } from "$lib/reports/period-format";

  interface Props {
    /** Two-way bindable open state. */
    open?: boolean;
    title: string;
    /** Optional eyebrow above the title. */
    eyebrow?: string;
    /** How many records the confirmed write affects. Confirm is disabled at 0. */
    count: number;
    /** Effective date as an ISO calendar day, formatted for display only; never computed here. */
    effectiveDate?: string;
    /** What confirming does ("Änderungen übernehmen"), never a bare "OK". */
    confirmLabel: string;
    /** The write is running: confirm and cancel are disabled. */
    pending?: boolean;
    /** The preview is loading: a Skeleton replaces the count line and the list. */
    loading?: boolean;
    onConfirm: () => void;
    /** Called after the dialog was cancelled or dismissed (not after a confirm). */
    onCancel?: () => void;
    /** The affected records. */
    list: Snippet;
    /** Content above the count line (notes, errors, an effective-date choice). */
    intro?: Snippet;
    /** Extra footer actions between „Abbrechen“ and the confirm button. */
    extraActions?: Snippet;
    /** Render the bare panel in place (the example page's themed frames only). */
    static?: boolean;
  }

  let {
    open = $bindable(false),
    title,
    eyebrow,
    count,
    effectiveDate,
    confirmLabel,
    pending = false,
    loading = false,
    onConfirm,
    onCancel,
    list,
    intro,
    extraActions,
    static: staticPanel = false,
  }: Props = $props();

  const countPhrase = $derived(count === 1 ? "Betrifft 1 Person" : `Betrifft ${count} Personen`);
  const confirmDisabled = $derived(pending || loading || count <= 0);

  function cancel() {
    open = false;
    onCancel?.();
  }

  function confirm() {
    if (confirmDisabled) return;
    onConfirm();
  }

  /** A dismissal through the overlay or Escape is a cancellation, like the button. */
  function onOpenChange(next: boolean) {
    if (!next) onCancel?.();
  }
</script>

{#snippet body()}
  <div class="bulk-preview">
    {#if intro}{@render intro()}{/if}
    {#if loading}
      <Skeleton shape="row" count={3} />
    {:else}
      {#if effectiveDate}
        <p class="bulk-preview-meta">
          <span class="bulk-preview-count">{countPhrase}</span>
          <span>Gilt ab {fmtDateDe(effectiveDate)}</span>
        </p>
      {/if}
      {@render list()}
    {/if}
  </div>
{/snippet}

{#snippet foot()}
  <button type="button" class="btn btn-ghost" disabled={pending} onclick={cancel}>
    Abbrechen
  </button>
  {#if extraActions}{@render extraActions()}{/if}
  <button type="button" class="btn btn-primary" disabled={confirmDisabled} onclick={confirm}>
    {confirmLabel}
  </button>
{/snippet}

<Dialog
  bind:open
  {title}
  {eyebrow}
  size="wide"
  static={staticPanel}
  {onOpenChange}
  children={body}
  footer={foot}
/>

<style>
  .bulk-preview {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .bulk-preview-meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s-1) var(--s-3);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .bulk-preview-count {
    font-weight: 600;
    color: var(--text);
  }
</style>
