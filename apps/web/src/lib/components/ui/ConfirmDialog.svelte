<script lang="ts">
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  interface Props {
    /** Bindable open state. Parent owns the boolean (`$state(false)`). */
    open: boolean;
    /** Serif H3 title rendered in the modal header. */
    title: string;
    /** Optional descriptive body text under the title. */
    description?: string;
    /** Label for the confirm button (default "Bestätigen"). */
    confirmLabel?: string;
    /** Label for the cancel button (default "Abbrechen"). */
    cancelLabel?: string;
    /** When true, the confirm button uses .btn-danger styling. */
    danger?: boolean;
    /** Confirm handler — may return a Promise. Dialog stays open while pending. */
    onConfirm: () => void | Promise<void>;
    /** Optional cancel handler. */
    onCancel?: () => void;
  }

  let {
    open = $bindable(),
    title,
    description,
    confirmLabel = "Bestätigen",
    cancelLabel = "Abbrechen",
    danger = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  let pending = $state(false);
  // Phase 76.13 (UI-V19-05): `confirming` is set inside handleConfirm AFTER the
  // awaited onConfirm() resolves, so a successful confirm path does NOT
  // double-fire onCancel via the open-transition $effect below.
  let confirming = $state(false);
  // Snapshot of the previous `open` value so $effect can detect a true→false
  // transition (Modal.svelte sets `open = false` directly on ESC + backdrop
  // click without invoking any callback — we observe that change here).
  let prevOpen = $state(open);

  // M-01 fix (Phase 76.13 UI-V19-05): Modal.svelte sets open=false directly on
  // ESC / backdrop click without invoking any cancel callback. We observe the
  // open transition here so parent state (e.g. /admin/employees/[id] tracking-
  // exemption toggle) can revert. `confirming` is set in handleConfirm AFTER
  // the awaited onConfirm() resolves, so a successful confirm path does NOT
  // double-fire onCancel. `pending` guard: if Modal closes while a confirm is
  // in-flight (ESC at the same instant as click), the confirm semantically
  // "wins" and we suppress onCancel — the parent only learns the outcome via
  // its own onConfirm resolution path.
  $effect(() => {
    if (prevOpen && !open) {
      if (!confirming && !pending) {
        onCancel?.();
      }
      // Reset for the next open cycle so re-opening does not carry stale state.
      confirming = false;
    }
    prevOpen = open;
  });

  async function handleConfirm() {
    if (pending) return;
    pending = true;
    try {
      await onConfirm();
      // Order matters: only set `confirming` on a successful onConfirm — if
      // onConfirm throws, the dialog stays open and the next dismiss should
      // behave like a normal cancel (i.e. fire onCancel).
      confirming = true;
      open = false;
    } finally {
      pending = false;
    }
  }

  function handleCancel() {
    if (pending) return;
    // onCancel is invoked by the $effect on the open transition (covers Cancel
    // button, ESC, backdrop — all three paths converge on `open = false`).
    open = false;
  }
</script>

<Modal bind:open {title}>
  {#if description}
    <p class="confirm-description">{description}</p>
  {/if}
  {#snippet footer()}
    <button class="btn btn-ghost" type="button" onclick={handleCancel} disabled={pending}>
      {cancelLabel}
    </button>
    <button
      class="btn {danger ? 'btn-danger' : 'btn-primary'}"
      type="button"
      onclick={handleConfirm}
      disabled={pending}
    >
      {#if pending}<Spinner />{/if}
      {confirmLabel}
    </button>
  {/snippet}
</Modal>

<style>
  .confirm-description {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
  }
</style>
