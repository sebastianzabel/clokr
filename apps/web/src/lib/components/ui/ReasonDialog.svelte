<script lang="ts">
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  interface Props {
    /** Bindable open state. Parent owns the boolean (`$state(false)`). */
    open: boolean;
    /** Serif H3 title rendered in the modal header. */
    title: string;
    /** Optional descriptive body text under the title. */
    description?: string;
    /** Label for the Begründung textarea (default "Begründung"). */
    label?: string;
    /** Label for the confirm button (default "Bestätigen", per ConfirmDialog). */
    confirmLabel?: string;
    /** When true, the confirm button uses .btn-danger styling. */
    danger?: boolean;
    /**
     * Confirm handler — called ONLY with a non-empty, trimmed reason. May throw
     * (e.g. a server 400/403/409) — the error message is shown inline and the
     * dialog stays open, mirroring ConfirmDialog's documented throw-keeps-open
     * behaviour.
     */
    onConfirm: (reason: string) => void | Promise<void>;
    /** Optional cancel handler. */
    onCancel?: () => void;
  }

  let {
    open = $bindable(),
    title,
    description,
    label = "Begründung",
    confirmLabel,
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  // Quick 260824-cjd: mirrors the exact German wording the API returns for a
  // missing/blank reason (apps/api/src/utils/audit-reason.ts AUDIT_REASON_REQUIRED).
  const REASON_REQUIRED = "Begründung ist erforderlich (revisionssicherheitspflichtig).";

  let reason = $state("");
  let error = $state("");
  // Snapshot of the previous `open` value so the reset-on-open $effect below can
  // detect a false→true transition (re-opening for a new action must not carry a
  // stale reason/error from the previous confirm attempt).
  let prevOpen = $state(open);

  $effect(() => {
    if (!prevOpen && open) {
      reason = "";
      error = "";
    }
    prevOpen = open;
  });

  async function handleConfirm() {
    const trimmed = reason.trim();
    if (!trimmed) {
      error = REASON_REQUIRED;
      // Throwing keeps ConfirmDialog open (it only sets open=false after a
      // successful await) — the inline message above is shown instead.
      throw new Error(REASON_REQUIRED);
    }
    try {
      await onConfirm(trimmed);
      error = "";
    } catch (err) {
      error = err instanceof Error ? err.message : "Ein Fehler ist aufgetreten.";
      throw err;
    }
  }
</script>

<ConfirmDialog
  bind:open
  {title}
  {description}
  {confirmLabel}
  {danger}
  onConfirm={handleConfirm}
  {onCancel}
>
  {#snippet body()}
    <div class="reason-field">
      <label class="form-label" for="reason-dialog-textarea">{label} *</label>
      <textarea
        id="reason-dialog-textarea"
        class="form-input"
        rows="3"
        bind:value={reason}
        placeholder="Bitte kurz begründen."
      ></textarea>
      {#if error}
        <p class="reason-field-error" role="alert">{error}</p>
      {/if}
    </div>
  {/snippet}
</ConfirmDialog>

<style>
  .reason-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .reason-field-error {
    margin: 0;
    font-size: 13px;
    color: var(--bad);
  }
</style>
