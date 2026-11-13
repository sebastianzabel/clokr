<script lang="ts">
  import Dialog from "$components/ui/Dialog.svelte";
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
    /**
     * Optional additive body content rendered inside the modal AFTER the
     * `description` paragraph and BEFORE the footer. Backward-compatible: every
     * existing caller omits `body` and is unaffected. Used e.g. to render the
     * appointment-collision list (Phase 87) — structured markup a plain
     * `description` string cannot carry.
     */
    body?: import("svelte").Snippet;
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
    body,
    onConfirm,
    onCancel,
  }: Props = $props();

  let pending = $state(false);
  // Phase 76.13 (UI-V19-05): `confirming` is set inside handleConfirm AFTER the
  // awaited onConfirm() resolves, so a successful confirm path does NOT
  // double-fire onCancel via the open-transition $effect below.
  let confirming = $state(false);
  // Snapshot of the previous `open` value so $effect can detect a true→false
  // transition.
  let prevOpen = $state(open);

  // M-01 fix (Phase 76.13 UI-V19-05): every way of closing (Cancel button, Escape,
  // backdrop click) converges on `open = false` without a callback of its own. We
  // observe that transition here so parent state (e.g. /admin/employees/[id]
  // tracking-exemption toggle) can revert. `confirming` is set in handleConfirm
  // AFTER the awaited onConfirm() resolves, so a successful confirm path does NOT
  // double-fire onCancel.
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

  /**
   * Issue #843 (D-843-16): the Dialog block reports the user-driven closings (Escape on the
   * document, a click on the scrim) through the open binding. While a confirm is in flight they
   * are refused outright - the dialog stays open - so the pending confirm "wins" exactly like the
   * disabled Cancel button; otherwise they take the one cancel path of the Cancel button.
   */
  function setOpen(next: boolean) {
    if (!next && pending) return;
    open = next;
  }

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
    } catch {
      // A rejecting onConfirm is an expected refusal (the caller shows its own
      // reason inside the dialog). handleConfirm runs from a click handler that
      // nobody awaits, so rethrowing would surface as an unhandled promise
      // rejection in the browser (and be posted by the tenant client logger).
      // The dialog simply stays open; no caller can observe the rethrow.
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

<Dialog bind:open={() => open, setOpen} {title}>
  {#if description}
    <p class="confirm-description">{description}</p>
  {/if}
  {@render body?.()}
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
</Dialog>

<style>
  .confirm-description {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    /* A description may carry line breaks (e.g. one line per exceeded leave limit, Issue #836). */
    white-space: pre-line;
  }
</style>
