<!--
  ApiKeysPanel - the „API-Schlüssel“ tab of Verwalten › System › Integrationen (Issue #854, rebuilt on the
  blocks of #843; the data, the endpoints and the rules are those of the pre-#854 section „API Keys“ of
  /admin/system). A management section without configuration keys of its own (registry section
  `integrationen-api-schluessel`).

  Loads `GET /api-keys` itself, the first time the tab is shown. Writes are `POST /api-keys` (create with a name
  and the chosen scopes; the key is shown ONCE in OneTimeKey and never again) and `DELETE /api-keys/:id` (revoke,
  behind a confirmation). Where the tenant has not booked the add-on module the calm hint replaces the create
  action (Issue #566, display only; the server answers 409 either way) - existing keys stay listed and revocable.

  Presentation only: `api-key:manage` is checked by the API; a 403 shows a calm note, not an error.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
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
  type ApiKeyEntry = {
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };

  const API_SCOPES = [
    { scope: "read:employees", label: "Mitarbeiter lesen" },
    { scope: "read:time-entries", label: "Zeiteinträge lesen" },
    { scope: "write:time-entries", label: "Zeiteinträge schreiben" },
    { scope: "read:leave", label: "Abwesenheiten lesen" },
    { scope: "write:leave", label: "Abwesenheiten schreiben" },
    { scope: "read:reports", label: "Berichte lesen" },
    { scope: "read:overtime", label: "Überstunden lesen" },
    { scope: "admin", label: "Voller Zugriff" },
  ];
  const DEFAULT_SCOPES = ["read:employees", "read:time-entries"];

  /** The German label of a scope; an unknown scope keeps its own text. */
  function scopeLabel(scope: string): string {
    return API_SCOPES.find((entry) => entry.scope === scope)?.label ?? scope;
  }

  let keys: ApiKeyEntry[] = $state([]);
  let loading = $state(false);
  let loadError = $state("");
  let forbidden = $state(false);

  // Phase 566 (D-12): display only. `=== false` only: an unknown state never hides the create action.
  const integrationsBooked = $derived(moduleBooked($salonContext, "INTEGRATIONS"));

  const columns: DataTableColumn[] = [
    { key: "name", label: "Name", primary: true },
    { key: "keyPrefix", label: "Schlüssel" },
    { key: "scopes", label: "Berechtigungen" },
    { key: "lastUsedAt", label: "Letzter Zugriff" },
    { key: "status", label: "Status" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  async function load() {
    loading = true;
    loadError = "";
    try {
      keys = await api.get<ApiKeyEntry[]>("/api-keys");
      forbidden = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die API-Schlüssel konnten nicht geladen werden.";
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

  function formatLastUsed(iso: string | null): string {
    return iso ? new Date(iso).toLocaleDateString("de-DE") : "Nie";
  }

  // ── Create ────────────────────────────────────────────────────────────────
  let createOpen = $state(false);
  let newName = $state("");
  let newScopes = $state<string[]>([...DEFAULT_SCOPES]);
  let createError = $state("");
  let creating = $state(false);
  // Shown once after the creation, then forgotten (T-854-34).
  let newKeyRaw = $state("");

  function openCreate() {
    newName = "";
    newScopes = [...DEFAULT_SCOPES];
    createError = "";
    createOpen = true;
  }

  function toggleScope(scope: string, on: boolean) {
    newScopes = on
      ? newScopes.includes(scope)
        ? newScopes
        : [...newScopes, scope]
      : newScopes.filter((entry) => entry !== scope);
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function createApiKey() {
    if (!newName.trim()) {
      createError = "Gib dem Schlüssel einen Namen.";
      return;
    }
    if (newScopes.length === 0) {
      createError = "Wähl mindestens eine Berechtigung aus.";
      return;
    }
    creating = true;
    createError = "";
    try {
      const res = await api.post<ApiKeyEntry & { rawKey: string }>("/api-keys", {
        name: newName.trim(),
        scopes: newScopes,
      });
      newKeyRaw = res.rawKey;
      createOpen = false;
      await load();
    } catch (err) {
      createError =
        err instanceof Error ? err.message : "API-Schlüssel konnte nicht erstellt werden.";
    } finally {
      creating = false;
    }
  }

  // ── Revoke ────────────────────────────────────────────────────────────────
  let revokeConfirm: { open: boolean; key: ApiKeyEntry | null } = $state({
    open: false,
    key: null,
  });

  function askRevoke(key: ApiKeyEntry) {
    revokeConfirm = { open: true, key };
  }

  async function confirmRevoke() {
    const key = revokeConfirm.key;
    if (!key) return;
    try {
      await api.delete(`/api-keys/${key.id}`);
    } catch (err) {
      toasts.error(
        err instanceof Error
          ? err.message
          : "API-Schlüssel konnte nicht widerrufen werden. Versuch es noch einmal.",
      );
      throw err;
    }
    toasts.success("API-Schlüssel widerrufen.");
    await load();
  }
</script>

<section class="settings-group" aria-labelledby="integrationen-api-title">
  <h2 class="settings-group-title" id="integrationen-api-title">API-Schlüssel</h2>
  <p class="settings-group-desc">
    Mit einem API-Schlüssel greifen externe Dienste auf die gewählten Daten zu, zum Beispiel für
    einen Export.
  </p>

  {#if newKeyRaw}
    <OneTimeKey
      title="API-Schlüssel erstellt"
      rawKey={newKeyRaw}
      onclose={() => (newKeyRaw = "")}
    />
  {/if}

  {#if integrationsBooked === false}
    <ModuleHint module="INTEGRATIONS" subject="API-Schlüssel" />
  {:else}
    <div class="ik-actions">
      <button type="button" class="btn btn-primary" onclick={openCreate}>Schlüssel anlegen</button>
    </div>
  {/if}

  {#if forbidden}
    <div role="alert">
      <Note tone="bad">Für die API-Schlüssel fehlt dir die Berechtigung.</Note>
    </div>
  {:else if loadError}
    <ErrorState message={loadError} onRetry={load} retrying={loading} />
  {:else if loading && keys.length === 0}
    <Skeleton shape="card" count={1} lines={3} />
  {:else if keys.length === 0}
    <EmptyState
      icon="inbox"
      title="Noch keine API-Schlüssel"
      description="Leg einen Schlüssel an, wenn ein externer Dienst auf Clokr zugreifen soll."
    />
  {:else}
    <DataTable
      {columns}
      rows={keys}
      rowKey={(row) => row.id}
      caption="API-Schlüssel mit Berechtigungen und Status"
    >
      {#snippet cell(row, column)}
        {#if column.key === "keyPrefix"}
          <code class="ik-code">{row.keyPrefix}…</code>
        {:else if column.key === "scopes"}
          {row.scopes.map(scopeLabel).join(", ")}
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

<!-- ── Dialog: create an API key ───────────────────────────────────────────── -->
<Dialog bind:open={createOpen} title="API-Schlüssel anlegen">
  <form
    id="api-key-create-form"
    novalidate
    class="ik-form"
    onsubmit={(event) => {
      event.preventDefault();
      void createApiKey();
    }}
  >
    <FormField label="Name" required help="Zum Beispiel „DATEV-Export“.">
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

    <fieldset class="ik-scopes">
      <legend class="ik-legend">Berechtigungen</legend>
      {#each API_SCOPES as entry (entry.scope)}
        <label class="ik-scope">
          <input
            type="checkbox"
            checked={newScopes.includes(entry.scope)}
            onchange={(event) => toggleScope(entry.scope, event.currentTarget.checked)}
          />
          <span>{entry.label}</span>
        </label>
      {/each}
    </fieldset>

    {#if createError}
      <div role="alert"><Note tone="bad">{createError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (createOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="api-key-create-form" class="btn btn-primary" disabled={creating}>
      {creating ? "Anlegen …" : "Schlüssel erstellen"}
    </button>
  {/snippet}
</Dialog>

<!-- ── Confirmation: revoke a key ──────────────────────────────────────────── -->
<ConfirmDialog
  bind:open={revokeConfirm.open}
  title="API-Schlüssel widerrufen?"
  description={revokeConfirm.key
    ? `Der Schlüssel „${revokeConfirm.key.name}“ funktioniert danach nicht mehr. Das lässt sich nicht rückgängig machen.`
    : ""}
  confirmLabel="Widerrufen"
  danger
  onConfirm={confirmRevoke}
/>

<style>
  .ik-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .ik-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .ik-scopes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--s-2);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .ik-legend {
    grid-column: 1 / -1;
    padding: 0;
    margin-bottom: var(--s-1);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
  }

  .ik-scope {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text);
  }

  .ik-code {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
  }
</style>
