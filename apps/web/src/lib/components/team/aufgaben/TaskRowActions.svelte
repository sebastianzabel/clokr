<script lang="ts">
  // Issue #853-19 (prototype „Aufgaben“) - the decision of an open leave or Zeitnachtrag row, in the
  // row: „Ablehnen“ (ghost) and „Genehmigen“ (primary). Template only: the page decides what the
  // buttons do (Genehmigen acts through the existing approve call, Ablehnen asks for the required
  // reason first). The caller's own request shows the four-eyes note instead of the buttons - the same
  // text as the dialog (passed in as `ownNote`, so this template imports no dialog). Each button's
  // accessible name starts with its visible word and adds whom it concerns, because a list holds
  // many identical buttons.
  interface Props {
    /** Control value of the row (test ids); never shown. */
    kind: string;
    sourceId: string;
    personName: string;
    /** A cancellation request: the accessible names say „Stornierung“. */
    cancellation?: boolean;
    /** The caller's own request: no buttons, the `ownNote` instead. */
    own?: boolean;
    /** The four-eyes sentence of the decision dialog (shown for `own`). */
    ownNote?: string;
    /** Any decision is under way: both buttons wait. */
    busy?: boolean;
    /** The decision of THIS row is under way: its approve button shows an ellipsis. */
    deciding?: boolean;
    onApprove: () => void;
    onReject: () => void;
  }

  let {
    kind,
    sourceId,
    personName,
    cancellation = false,
    own = false,
    ownNote = "",
    busy = false,
    deciding = false,
    onApprove,
    onReject,
  }: Props = $props();

  const subject = $derived(cancellation ? "Stornierung" : "Antrag");
</script>

{#if own}
  <span class="text-muted" data-testid={`task-own-${kind}-${sourceId}`}>{ownNote}</span>
{:else}
  <button
    type="button"
    class="btn btn-ghost btn-sm"
    data-testid={`task-reject-${kind}-${sourceId}`}
    aria-label={`Ablehnen: ${subject} von ${personName}`}
    disabled={busy}
    onclick={onReject}
  >
    Ablehnen
  </button>
  <button
    type="button"
    class="btn btn-primary btn-sm"
    data-testid={`task-approve-${kind}-${sourceId}`}
    aria-label={`Genehmigen: ${subject} von ${personName}`}
    disabled={busy}
    onclick={onApprove}
  >
    {deciding ? "…" : "Genehmigen"}
  </button>
{/if}
