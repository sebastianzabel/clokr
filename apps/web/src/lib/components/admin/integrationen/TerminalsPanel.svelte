<!--
  TerminalsPanel - the „NFC-Terminals“ tab of Verwalten › System › Integrationen (Issue #854, rebuilt on the
  blocks of #843; the data, the endpoints and the rules are those of the pre-#854 section of /admin/system).
  A management section without configuration keys of its own (registry section `integrationen-terminals`).

  Loads `GET /terminals` itself, the first time the tab is shown. Writes are `POST /terminals` (create, the key
  is shown ONCE in OneTimeKey and never again), `DELETE /terminals/:id` (revoke, behind a confirmation) and the
  instant `PATCH /terminals/:id` of the salon binding (Issue #541, `saveTerminalSalon`: optimistic update, revert
  before the toast). The salon choice follows the #64 rule (`showSalonOptions`); the column also shows whenever a
  key is bound, so a binding stays visible and removable. Where the tenant has not booked the add-on module the
  calm hint replaces the create action (Issue #566, display only; the server answers 409 either way) - the keys
  already there stay listed and revocable.

  Presentation only: `terminal:manage` is checked by the API; a 403 shows a calm note, not an error.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api, ApiError } from "$api/client";
  import { saveTerminalSalon } from "$lib/admin/terminal-salon-save";
  import { toasts } from "$stores/toast";
  import { salonContext, moduleBooked, showSalonOptions } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import TerminalSalonCell from "$lib/components/admin/TerminalSalonCell.svelte";
  import OneTimeKey from "$lib/components/admin/integrationen/OneTimeKey.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  interface Props {
    active: boolean;
  }

  let { active }: Props = $props();

  // A type alias, not an interface: DataTable rows must be assignable to Record<string, unknown>.
  type TerminalKey = {
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    // Issue #541: the salon the terminal is bound to (null = salon from the weekly pattern)
    salonId: string | null;
    salonName: string | null;
    salonActive: boolean | null;
  };

  let keys: TerminalKey[] = $state([]);
  let loading = $state(false);
  let loadError = $state("");
  let forbidden = $state(false);

  // Phase 566 (D-12): display only. `=== false` only: an unknown state never hides the create action.
  const hardwareBooked = $derived(moduleBooked($salonContext, "HARDWARE_CLOCK"));
  // Issue #541 (D-08, D-11): the choice follows the #64 rule; the column also shows whenever a key is bound.
  const salonOptionsShown = $derived(showSalonOptions($salonContext));
  const showSalonColumn = $derived(salonOptionsShown || keys.some((key) => key.salonId !== null));

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Name", primary: true },
    ...(showSalonColumn ? [{ key: "salon", label: "Salon" }] : []),
    { key: "keyPrefix", label: "Schlüssel" },
    { key: "createdAt", label: "Erstellt" },
    { key: "lastUsedAt", label: "Zuletzt verwendet" },
    { key: "status", label: "Status" },
    { key: "actions", label: "Aktionen", align: "end" as const },
  ]);

  async function load() {
    loading = true;
    loadError = "";
    try {
      const res = await api.get<{ keys: TerminalKey[] }>("/terminals");
      keys = res.keys;
      forbidden = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Terminal-Schlüssel konnten nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  }

  // Lazy load on the first visit of the tab: a person who never opens it costs no request.
  let started = false;
  $effect(() => {
    if (!active || started) return;
    started = true;
    untrack(() => void load());
  });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("de-DE");
  }

  function formatLastUsed(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString("de-DE") : "Nie";
  }

  // ── Create ────────────────────────────────────────────────────────────────
  let createOpen = $state(false);
  let newName = $state("");
  let newSalonId = $state("");
  let createError = $state("");
  let creating = $state(false);
  // Shown once after the creation, then forgotten (T-854-34).
  let newKeyRaw = $state("");

  function openCreate() {
    newName = "";
    newSalonId = "";
    createError = "";
    createOpen = true;
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function createTerminalKey() {
    if (!newName.trim()) {
      createError = "Gib dem Terminal einen Namen.";
      return;
    }
    creating = true;
    createError = "";
    try {
      const res = await api.post<{ rawKey: string }>("/terminals", {
        name: newName.trim(),
        // The id is sent only when one is chosen (D-03).
        ...(newSalonId !== "" && { salonId: newSalonId }),
      });
      newKeyRaw = res.rawKey;
      createOpen = false;
      await load();
    } catch (err) {
      createError =
        err instanceof ApiError ? err.message : "Terminal-Schlüssel konnte nicht erstellt werden.";
    } finally {
      creating = false;
    }
  }

  // ── Salon binding (instant save) ───────────────────────────────────────────
  // Issue #541 (D-03, D-08): the optimistic update and the revert-before-toast rollback live in
  // `$lib/admin/terminal-salon-save` (unit-tested).
  function setTerminalSalon(id: string, salonId: string | null): Promise<boolean> {
    return saveTerminalSalon<TerminalKey>({
      id,
      salonId,
      getRows: () => keys,
      setRows: (rows) => (keys = rows),
      salons: $salonContext.salons,
      patch: (keyId, salon) => api.patch<TerminalKey>(`/terminals/${keyId}`, { salonId: salon }),
      onSaved: () => toasts.success("Salon-Bindung gespeichert."),
      onFailed: (err) => {
        console.error("Failed to set terminal salon:", err);
        toasts.error(
          err instanceof ApiError ? err.message : "Salon-Bindung konnte nicht gespeichert werden.",
        );
      },
    });
  }

  // ── Revoke ────────────────────────────────────────────────────────────────
  let revokeConfirm: { open: boolean; key: TerminalKey | null } = $state({
    open: false,
    key: null,
  });

  function askRevoke(key: TerminalKey) {
    revokeConfirm = { open: true, key };
  }

  async function confirmRevoke() {
    const key = revokeConfirm.key;
    if (!key) return;
    try {
      await api.delete(`/terminals/${key.id}`);
    } catch (err) {
      toasts.error(
        err instanceof ApiError
          ? err.message
          : "Terminal-Schlüssel konnte nicht widerrufen werden.",
      );
      throw err;
    }
    toasts.success("Terminal-Schlüssel widerrufen.");
    await load();
  }
</script>

<section class="settings-group" aria-labelledby="integrationen-terminals-title">
  <h2 class="settings-group-title" id="integrationen-terminals-title">NFC-Terminals</h2>
  <p class="settings-group-desc">
    Jedes stationäre Gerät meldet sich mit einem eigenen Schlüssel an. Ein Terminal kann an einen
    Salon gebunden werden.
  </p>

  {#if newKeyRaw}
    <OneTimeKey
      title="Neuer Schlüssel erstellt"
      rawKey={newKeyRaw}
      onclose={() => (newKeyRaw = "")}
    />
  {/if}

  {#if hardwareBooked === false}
    <ModuleHint module="HARDWARE_CLOCK" subject="NFC-Terminals" />
  {:else}
    <div class="it-actions">
      <button type="button" class="btn btn-primary" onclick={openCreate}>Terminal anlegen</button>
    </div>
  {/if}

  {#if forbidden}
    <div role="alert">
      <Note tone="bad">Für die Terminal-Schlüssel fehlt dir die Berechtigung.</Note>
    </div>
  {:else if loadError}
    <ErrorState message={loadError} onRetry={load} retrying={loading} />
  {:else if loading && keys.length === 0}
    <Skeleton shape="card" count={1} lines={3} />
  {:else if keys.length === 0}
    <EmptyState
      icon="wifi"
      title="Noch keine Terminal-Schlüssel"
      description="Lege für jedes Terminal einen Schlüssel an und trag ihn dort ein."
    />
  {:else}
    <DataTable
      {columns}
      rows={keys}
      rowKey={(row) => row.id}
      caption="NFC-Terminals mit Salon, Schlüssel und Status"
    >
      {#snippet cell(row, column)}
        {#if column.key === "salon"}
          <TerminalSalonCell
            terminal={row}
            salons={$salonContext.salons}
            showOptions={salonOptionsShown}
            onchange={(salonId) => setTerminalSalon(row.id, salonId)}
          />
        {:else if column.key === "keyPrefix"}
          <code class="it-code">{row.keyPrefix}</code>
        {:else if column.key === "createdAt"}
          {formatDate(row.createdAt)}
        {:else if column.key === "lastUsedAt"}
          {formatLastUsed(row.lastUsedAt)}
        {:else if column.key === "status"}
          {#if row.revokedAt}
            <Chip tone="bad">Widerrufen</Chip>
          {:else}
            <Chip tone="ok">Aktiv</Chip>
          {/if}
        {:else if column.key === "actions"}
          {#if !row.revokedAt}
            <button
              type="button"
              class="btn btn-secondary btn-sm btn-danger"
              onclick={() => askRevoke(row)}
            >
              Widerrufen
            </button>
          {/if}
        {:else}
          {row.name}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<!-- ── Dialog: create a terminal key ───────────────────────────────────────── -->
<Dialog bind:open={createOpen} title="Terminal anlegen">
  <form
    id="terminal-create-form"
    novalidate
    class="it-form"
    onsubmit={(event) => {
      event.preventDefault();
      void createTerminalKey();
    }}
  >
    <FormField label="Name" required help="Zum Beispiel „Kasse 1“.">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="text"
          aria-describedby={describedBy}
          bind:value={newName}
        />
      {/snippet}
    </FormField>

    {#if salonOptionsShown}
      <FormField label="Salon" help="Ohne Salon gilt der Salon aus dem Wochenmuster.">
        {#snippet field({ id, describedBy })}
          <select {id} class="form-input" aria-describedby={describedBy} bind:value={newSalonId}>
            <option value="">Kein Salon – Salon aus dem Wochenmuster</option>
            {#each $salonContext.salons as salon (salon.id)}
              <option value={salon.id}>{salon.name}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    {/if}

    {#if createError}
      <div role="alert"><Note tone="bad">{createError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (createOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="terminal-create-form" class="btn btn-primary" disabled={creating}>
      {creating ? "Anlegen …" : "Schlüssel erstellen"}
    </button>
  {/snippet}
</Dialog>

<!-- ── Confirmation: revoke a key ──────────────────────────────────────────── -->
<ConfirmDialog
  bind:open={revokeConfirm.open}
  title="Terminal-Schlüssel widerrufen?"
  description={revokeConfirm.key
    ? `Das Terminal „${revokeConfirm.key.name}“ kann sich danach nicht mehr anmelden. Das lässt sich nicht rückgängig machen.`
    : ""}
  confirmLabel="Widerrufen"
  danger
  onConfirm={confirmRevoke}
/>

<style>
  .it-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .it-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .it-code {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
  }
</style>
