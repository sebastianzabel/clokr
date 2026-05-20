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

  async function handleConfirm() {
    if (pending) return;
    pending = true;
    try {
      await onConfirm();
      open = false;
    } finally {
      pending = false;
    }
  }

  function handleCancel() {
    if (pending) return;
    onCancel?.();
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
