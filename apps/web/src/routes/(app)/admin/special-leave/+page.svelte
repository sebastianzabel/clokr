<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import Breadcrumb from "$lib/components/ui/Breadcrumb.svelte";
  import { toasts } from "$stores/toast";
  import Pagination from "$components/ui/Pagination.svelte";

  interface SpecialLeaveRule {
    id: string;
    name: string;
    reason: string | null;
    defaultDays: number;
    isStatutory: boolean;
    requiresProof: boolean;
    isActive: boolean;
  }

  let rules: SpecialLeaveRule[] = $state([]);
  let loading = $state(true);

  // Pagination
  let slPage = $state(1);
  let slPageSize = $state(10);
  let pagedRules = $derived(rules.slice((slPage - 1) * slPageSize, slPage * slPageSize));

  // Create modal
  let showCreate = $state(false);
  let createName = $state("");
  let createReason = $state("");
  let createDays = $state(1);
  let createProof = $state(false);
  let creating = $state(false);

  // Edit modal
  let editRule: SpecialLeaveRule | null = $state(null);
  let editDays = $state(1);
  let editProof = $state(false);
  let editActive = $state(true);
  let editReason = $state("");
  let saving = $state(false);

  onMount(loadRules);

  async function loadRules() {
    loading = true;
    try {
      rules = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
    } catch {
      toasts.error("Fehler beim Laden der Sonderurlaubsregeln");
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    if (!createName.trim()) return;
    creating = true;
    try {
      await api.post("/special-leave/rules", {
        name: createName.trim(),
        reason: createReason.trim() || undefined,
        defaultDays: createDays,
        requiresProof: createProof,
      });
      showCreate = false;
      createName = "";
      createReason = "";
      createDays = 1;
      createProof = false;
      await loadRules();
      toasts.success("Regel erstellt");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      creating = false;
    }
  }

  function openEdit(rule: SpecialLeaveRule) {
    editRule = rule;
    editDays = Number(rule.defaultDays);
    editProof = rule.requiresProof;
    editActive = rule.isActive;
    editReason = rule.reason ?? "";
  }

  async function handleSave() {
    if (!editRule) return;
    saving = true;
    try {
      await api.put(`/special-leave/rules/${editRule.id}`, {
        defaultDays: editDays,
        requiresProof: editProof,
        isActive: editActive,
        reason: editReason.trim() || null,
      });
      editRule = null;
      await loadRules();
      toasts.success("Regel aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      saving = false;
    }
  }

  async function handleDelete(rule: SpecialLeaveRule) {
    if (rule.isStatutory) return;
    try {
      await api.delete(`/special-leave/rules/${rule.id}`);
      await loadRules();
      toasts.success("Regel gelöscht");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    }
  }
</script>

<svelte:head><title>Sonderurlaub – Clokr</title></svelte:head>
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") {
      showCreate = false;
      editRule = null;
    }
  }}
/>

<Breadcrumb items={[{ label: "Admin", href: "/admin" }, { label: "Sonderurlaub" }]} />

<div class="page-header">
  <h1 class="page-title">Sonderurlaubsregeln</h1>
  <button class="btn btn-primary" onclick={() => (showCreate = true)}>+ Neue Regel</button>
</div>

<p class="text-muted" style="margin-bottom:1.5rem;">
  Gesetzliche Anlässe (§ 616 BGB) werden automatisch angelegt. Tage und Nachweis­pflicht können
  angepasst, zusätzliche betriebliche Anlässe hinzugefügt werden.
</p>

{#if loading}
  <div class="card card-body" style="height:200px;"></div>
{:else}
  <div class="table-wrap card-animate">
    <table class="table">
      <thead>
        <tr>
          <th>Anlass</th>
          <th>Tage</th>
          <th>Nachweis</th>
          <th>Art</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each pagedRules as rule (rule.id)}
          <tr class:inactive={!rule.isActive}>
            <td>
              <strong>{rule.name}</strong>
              {#if rule.reason}
                <br /><span class="text-muted text-sm">{rule.reason}</span>
              {/if}
            </td>
            <td>{Number(rule.defaultDays)}</td>
            <td>{rule.requiresProof ? "Ja" : "Nein"}</td>
            <td>
              <span
                class="badge"
                class:badge-statutory={rule.isStatutory}
                class:badge-custom={!rule.isStatutory}
              >
                {rule.isStatutory ? "Gesetzlich" : "Betrieblich"}
              </span>
            </td>
            <td>
              <span
                class="status-dot"
                class:active={rule.isActive}
                class:deactivated={!rule.isActive}
              ></span>
              {rule.isActive ? "Aktiv" : "Deaktiviert"}
            </td>
            <td class="actions-cell">
              <button class="btn btn-ghost btn-sm" onclick={() => openEdit(rule)}>Bearbeiten</button
              >
              {#if !rule.isStatutory}
                <button class="btn btn-ghost btn-sm text-danger" onclick={() => handleDelete(rule)}
                  >Löschen</button
                >
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <Pagination total={rules.length} bind:page={slPage} bind:pageSize={slPageSize} />
  </div>
{/if}

<!-- Create Modal -->
{#if showCreate}
  <div class="modal-backdrop" onclick={() => (showCreate = false)} role="presentation">
    <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2 class="modal-title">Neue Sonderurlaubsregel</h2>
        <button class="modal-close" onclick={() => (showCreate = false)}>✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" for="cr-name">Anlass</label>
          <input
            id="cr-name"
            class="form-input"
            bind:value={createName}
            placeholder="z. B. Ehrenamtlicher Einsatz"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="cr-reason">Beschreibung</label>
          <input
            id="cr-reason"
            class="form-input"
            bind:value={createReason}
            placeholder="Optional"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="cr-days">Tage</label>
          <input
            id="cr-days"
            type="number"
            class="form-input"
            min="0.5"
            max="30"
            step="0.5"
            bind:value={createDays}
          />
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Nachweis erforderlich</span>
          <label class="switch">
            <input type="checkbox" bind:checked={createProof} />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={() => (showCreate = false)}>Abbrechen</button>
        <button
          class="btn btn-primary"
          onclick={handleCreate}
          disabled={creating || !createName.trim()}
        >
          {creating ? "Erstellen…" : "Erstellen"}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Modal -->
{#if editRule}
  <div class="modal-backdrop" onclick={() => (editRule = null)} role="presentation">
    <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2 class="modal-title">{editRule.name}</h2>
        <button class="modal-close" onclick={() => (editRule = null)}>✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" for="ed-reason">Beschreibung</label>
          <input id="ed-reason" class="form-input" bind:value={editReason} />
        </div>
        <div class="form-group">
          <label class="form-label" for="ed-days">Tage</label>
          <input
            id="ed-days"
            type="number"
            class="form-input"
            min="0.5"
            max="30"
            step="0.5"
            bind:value={editDays}
          />
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Nachweis erforderlich</span>
          <label class="switch">
            <input type="checkbox" bind:checked={editProof} />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="toggle-row">
          <span class="toggle-row-label">Aktiv</span>
          <label class="switch">
            <input type="checkbox" bind:checked={editActive} />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={() => (editRule = null)}>Abbrechen</button>
        <button class="btn btn-primary" onclick={handleSave} disabled={saving}>
          {saving ? "Speichern…" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .page-title {
    font-size: 1.375rem;
    font-weight: 700;
  }

  .table-wrap {
    overflow-x: auto;
  }
  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    border-bottom: 2px solid var(--color-border);
  }
  .table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border-subtle);
    vertical-align: middle;
  }
  tr.inactive td {
    opacity: 0.5;
  }
  .text-sm {
    font-size: 0.8125rem;
  }

  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .badge-statutory {
    background: var(--color-blue-bg);
    color: var(--color-blue);
  }
  .badge-custom {
    background: var(--color-purple-bg);
    color: var(--color-purple);
  }

  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.25rem;
  }
  .status-dot.active {
    background: var(--color-green);
  }
  .status-dot.deactivated {
    background: var(--gray-400);
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .text-danger {
    color: var(--color-red) !important;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0;
  }
</style>
