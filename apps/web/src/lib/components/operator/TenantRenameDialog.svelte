<!--
  TenantRenameDialog - "Mandant umbenennen" (Issue #89, D-14).

  Renames the tenant's display name only; the Kurzname stays. The submit button stays disabled
  until the trimmed name differs from the current one, so an empty or unchanged save can never
  reach the API. A failed rename never closes the dialog: the reason is chosen by the error's
  `code` (lib/operator/reasons.ts) and shown inside it.
-->
<script lang="ts">
  import { tick } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { failureText } from "$lib/operator/reasons";

  interface Props {
    open: boolean;
    /** The tenant's current name; the form starts from it every time the dialog opens. */
    currentName: string;
    /** Receives the trimmed new name; rejects with the client's error on failure. */
    onRename: (name: string) => Promise<void>;
  }

  let { open = $bindable(), currentName, onRename }: Props = $props();

  const NAME_MAX = 200;
  const FORM_ID = "op-tenant-rename-form";

  let name = $state("");
  let pending = $state(false);
  let alertMessage = $state<string | null>(null);
  let alertEl: HTMLElement | undefined = $state();

  const trimmed = $derived(name.trim());
  const changed = $derived(trimmed !== "" && trimmed !== currentName.trim());

  async function submit(event: Event) {
    event.preventDefault();
    if (pending || !changed) return;
    pending = true;
    alertMessage = null;
    try {
      await onRename(trimmed);
      open = false;
    } catch (error) {
      alertMessage = failureText(error);
      await tick();
      alertEl?.focus();
    } finally {
      pending = false;
    }
  }

  // Each opening starts from the current name; the element that opened the dialog gets focus back.
  $effect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    name = currentName;
    alertMessage = null;
    pending = false;
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  });
</script>

<Modal bind:open eyebrow="Mandant" title="Mandant umbenennen">
  <div class="dialog-root" data-testid="op-tenant-rename-dialog">
    <form id={FORM_ID} class="form" novalidate onsubmit={submit}>
      {#if alertMessage}
        <div
          class="alert alert-error"
          role="alert"
          tabindex="-1"
          data-testid="op-tenant-rename-error"
          bind:this={alertEl}
        >
          {alertMessage}
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="op-tenant-rename-input">Neuer Name *</label>
        <input
          id="op-tenant-rename-input"
          class="form-input"
          type="text"
          maxlength={NAME_MAX}
          autocomplete="off"
          aria-describedby="op-tenant-rename-hint"
          data-testid="op-tenant-rename-input"
          bind:value={name}
        />
        <p class="form-hint" id="op-tenant-rename-hint">Der Kurzname bleibt unverändert.</p>
      </div>
    </form>
  </div>

  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn btn-ghost" disabled={pending} onclick={() => (open = false)}
      >Abbrechen</button
    >
    <button
      type="submit"
      form={FORM_ID}
      class="btn btn-primary"
      data-testid="op-tenant-rename-submit"
      disabled={!changed || pending}
    >
      {#if pending}<Spinner size={14} label="Wird gespeichert" /> Wird gespeichert …{:else}Namen
        speichern{/if}
    </button>
  {/snippet}
</Modal>

<style>
  .dialog-root {
    min-width: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .form-group {
    min-width: 0;
  }

  .form-input {
    min-width: 0;
  }

  .form-hint {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .alert {
    overflow-wrap: anywhere;
  }
</style>
