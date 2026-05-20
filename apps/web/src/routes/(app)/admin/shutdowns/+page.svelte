<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  // ── Typen ─────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }

  interface ShutdownException {
    id: string;
    employeeId: string;
    reason: string | null;
    employee: Employee;
  }

  interface CompanyShutdown {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    deductsFromVacation: boolean;
    notes: string | null;
    exceptions: ShutdownException[];
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let shutdowns: CompanyShutdown[] = $state([]);
  let allEmployees: Employee[] = $state([]);

  // Pagination
  let sdPage = $state(1);
  let sdPageSize = $state(10);
  let pagedShutdowns = $derived(shutdowns.slice((sdPage - 1) * sdPageSize, sdPage * sdPageSize));
  let loading = $state(true);
  let error = $state("");

  // Formular für neuen Betriebsurlaub
  let showForm = $state(false);
  let saving = $state(false);
  let editId = $state<string | null>(null);
  let formName = $state("");
  let formStart = $state("");
  let formEnd = $state("");
  let formDeducts = $state(true);
  let formNotes = $state("");
  let formError = $state("");

  // Ausnahmen-Verwaltung
  let exceptionShutdownId = $state<string | null>(null);
  let exceptionModalOpen = $state(false);
  let addExceptionEmpId = $state("");
  let addExceptionReason = $state("");
  let savingException = $state(false);

  // Jahresfilter
  let filterYear = $state(new Date().getFullYear().toString());

  // Bestätigung beim Löschen
  let deleteConfirm = $state<{ open: boolean; id: string | null; name: string }>({
    open: false,
    id: null,
    name: "",
  });

  // ── Lade-Funktionen ───────────────────────────────────────────────────────
  async function loadShutdowns() {
    loading = true;
    error = "";
    try {
      shutdowns = await api.get(`/company-shutdowns?year=${filterYear}`);
    } catch {
      error = "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  async function loadEmployees() {
    try {
      const data = await api.get<{ employees?: Employee[] } | Employee[]>("/employees?limit=500");
      allEmployees = (Array.isArray(data) ? data : data.employees) ?? [];
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadShutdowns();
    loadEmployees();
  });

  // ── Formular ──────────────────────────────────────────────────────────────
  function openCreate() {
    editId = null;
    formName = "";
    formStart = "";
    formEnd = "";
    formDeducts = true;
    formNotes = "";
    formError = "";
    showForm = true;
  }

  function openEdit(s: CompanyShutdown) {
    editId = s.id;
    formName = s.name;
    formStart = s.startDate.slice(0, 10);
    formEnd = s.endDate.slice(0, 10);
    formDeducts = s.deductsFromVacation;
    formNotes = s.notes ?? "";
    formError = "";
    showForm = true;
  }

  function closeForm() {
    showForm = false;
    editId = null;
  }

  async function saveShutdown() {
    if (!formName.trim() || !formStart || !formEnd) {
      formError = "Name, Start- und Enddatum sind Pflichtfelder.";
      return;
    }
    if (formStart > formEnd) {
      formError = "Startdatum muss vor Enddatum liegen.";
      return;
    }
    saving = true;
    formError = "";
    try {
      const body = {
        name: formName.trim(),
        startDate: formStart,
        endDate: formEnd,
        deductsFromVacation: formDeducts,
        notes: formNotes || undefined,
      };
      if (editId) {
        await api.patch(`/company-shutdowns/${editId}`, body);
      } else {
        await api.post("/company-shutdowns", body);
      }
      closeForm();
      await loadShutdowns();
    } catch {
      formError = "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  function askDeleteShutdown(id: string, name: string) {
    deleteConfirm = { open: true, id, name };
  }

  async function confirmDeleteShutdown() {
    if (!deleteConfirm.id) return;
    try {
      await api.delete(`/company-shutdowns/${deleteConfirm.id}`);
      await loadShutdowns();
    } catch {
      alert("Löschen fehlgeschlagen.");
    }
  }

  // ── Ausnahmen ─────────────────────────────────────────────────────────────
  function openExceptions(id: string) {
    exceptionShutdownId = id;
    addExceptionEmpId = "";
    addExceptionReason = "";
    exceptionModalOpen = true;
  }

  function closeExceptions() {
    exceptionModalOpen = false;
    exceptionShutdownId = null;
  }

  async function addException() {
    if (!addExceptionEmpId || !exceptionShutdownId) return;
    savingException = true;
    try {
      await api.post(`/company-shutdowns/${exceptionShutdownId}/exceptions`, {
        employeeId: addExceptionEmpId,
        reason: addExceptionReason || undefined,
      });
      addExceptionEmpId = "";
      addExceptionReason = "";
      await loadShutdowns();
    } catch {
      alert("Ausnahme konnte nicht hinzugefügt werden.");
    } finally {
      savingException = false;
    }
  }

  async function removeException(shutdownId: string, employeeId: string) {
    try {
      await api.delete(`/company-shutdowns/${shutdownId}/exceptions/${employeeId}`);
      await loadShutdowns();
    } catch {
      alert("Ausnahme konnte nicht entfernt werden.");
    }
  }

  // ── Hilfsfunktionen ───────────────────────────────────────────────────────
  function fmtDate(d: string) {
    return format(new Date(d), "dd.MM.yyyy", { locale: de });
  }

  function calcDays(start: string, end: string) {
    const s = new Date(start);
    const e = new Date(end);
    return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  }

  const currentShutdown = $derived(
    exceptionShutdownId ? shutdowns.find((s) => s.id === exceptionShutdownId) : null,
  );

  const availableEmployees = $derived(
    currentShutdown
      ? allEmployees.filter((e) => !currentShutdown.exceptions.some((ex) => ex.employeeId === e.id))
      : allEmployees,
  );

  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(String);
</script>

<div class="page">
<!-- ── Header (v1.5 PageHead) ─────────────────────────────────────────────── -->
<PageHead
  eyebrow="Administration"
  title="Betriebsurlaub"
  accent="Betriebsurlaub"
  sub="Schließzeiten verwalten und Ausnahmen festlegen."
>
  {#snippet actions()}
    <select class="form-input year-filter" bind:value={filterYear} onchange={loadShutdowns}>
      {#each years as y (y)}
        <option value={y}>{y}</option>
      {/each}
    </select>
    <button class="btn btn-primary btn-sm" onclick={openCreate}>+ Neu</button>
  {/snippet}
</PageHead>

<!-- ── Fehler ─────────────────────────────────────────────────────────────── -->
{#if error}
  <div class="alert alert-error">{error}</div>
{/if}

<!-- ── Inhalt ─────────────────────────────────────────────────────────────── -->
{#if loading}
  <Card animate class="loading-card"><span class="sr-only">Wird geladen…</span></Card>
{:else if shutdowns.length === 0}
  <Card animate class="empty-state">
    <span class="empty-icon">🏢</span>
    <h3>Keine Betriebsurlaube</h3>
    <p class="empty-state__text text-muted">Keine Betriebsurlaube für {filterYear} angelegt.</p>
    <button class="btn btn-primary" onclick={openCreate}>Ersten anlegen</button>
  </Card>
{:else}
  <Card animate class="shutdown-card-wrap">
    <CardHeader title={`Schließzeiten ${filterYear}`} sub="Übersicht aller geplanten Betriebsurlaube" />
    <div class="shutdown-list">
      {#each pagedShutdowns as s (s.id)}
        <div class="shutdown-card">
          <div class="shutdown-card__main">
            <div class="shutdown-card__info">
              <span class="shutdown-card__name">{s.name}</span>
              <span class="shutdown-card__dates">
                {fmtDate(s.startDate)} – {fmtDate(s.endDate)}
                <span class="badge badge-neutral">{calcDays(s.startDate, s.endDate)} Tage</span>
              </span>
              {#if s.notes}
                <span class="shutdown-card__notes">{s.notes}</span>
              {/if}
              <div class="shutdown-card__meta">
                {#if s.deductsFromVacation}
                  <span class="badge badge-warning">Zieht vom Urlaubskonto ab</span>
                {:else}
                  <span class="badge badge-neutral">Kein Urlaubsabzug</span>
                {/if}
                {#if s.exceptions.length > 0}
                  <span class="badge badge-info"
                    >{s.exceptions.length} Ausnahme{s.exceptions.length !== 1 ? "n" : ""}</span
                  >
                {/if}
              </div>
            </div>
            <div class="shutdown-card__actions">
              <button class="btn btn-ghost btn-sm" onclick={() => openExceptions(s.id)}>
                Ausnahmen
              </button>
              <button class="btn btn-ghost btn-sm" onclick={() => openEdit(s)}>Bearbeiten</button>
              <button
                class="btn btn-ghost btn-sm btn-danger"
                onclick={() => askDeleteShutdown(s.id, s.name)}
              >
                Löschen
              </button>
            </div>
          </div>

          <!-- Ausnahmen inline anzeigen -->
          {#if s.exceptions.length > 0}
            <div class="exception-list">
              <span class="exception-list__label">Ausnahmen:</span>
              {#each s.exceptions as ex (ex.id)}
                <span class="exception-chip">
                  {ex.employee.firstName}
                  {ex.employee.lastName}
                  {#if ex.reason}<span class="exception-chip__reason">({ex.reason})</span>{/if}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </Card>
  <Pagination total={shutdowns.length} bind:page={sdPage} bind:pageSize={sdPageSize} />
{/if}

<!-- ── Modal: Betriebsurlaub anlegen / bearbeiten ─────────────────────────── -->
<Modal
  bind:open={showForm}
  eyebrow={editId ? "Betriebsurlaub bearbeiten" : "Betriebsurlaub anlegen"}
  title="Schließzeit"
>
  {#if formError}
    <div class="alert alert-error">{formError}</div>
  {/if}
  <div class="form-group">
    <label class="form-label" for="sh-name">Bezeichnung *</label>
    <input
      id="sh-name"
      class="form-input"
      type="text"
      bind:value={formName}
      placeholder="z.B. Weihnachtsschließung 2025"
    />
  </div>
  <div class="form-row">
    <div class="form-group">
      <label class="form-label" for="sh-start">Startdatum *</label>
      <input id="sh-start" class="form-input" type="date" bind:value={formStart} />
    </div>
    <div class="form-group">
      <label class="form-label" for="sh-end">Enddatum *</label>
      <input id="sh-end" class="form-input" type="date" bind:value={formEnd} />
    </div>
  </div>
  <div class="form-group">
    <label class="checkbox-label">
      <input type="checkbox" bind:checked={formDeducts} />
      Vom Urlaubskonto abziehen
    </label>
    <p class="form-hint">
      Wenn aktiv, wird der Betriebsurlaub automatisch vom Jahresurlaub der Mitarbeiter abgezogen
      (außer bei Ausnahmen).
    </p>
  </div>
  <div class="form-group">
    <label class="form-label" for="sh-notes">Notiz (optional)</label>
    <textarea
      id="sh-notes"
      class="form-input"
      rows="2"
      bind:value={formNotes}
      placeholder="Interne Anmerkung …"
    ></textarea>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={closeForm}>Abbrechen</button>
    <button class="btn btn-primary" onclick={saveShutdown} disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Modal>

<!-- ── Bestätigung: Betriebsurlaub löschen ───────────────────────────────── -->
<ConfirmDialog
  bind:open={deleteConfirm.open}
  title="Betriebsurlaub löschen?"
  description={`„${deleteConfirm.name}" wird entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`}
  confirmLabel="Löschen"
  danger
  onConfirm={confirmDeleteShutdown}
/>

<!-- ── Modal: Ausnahmen verwalten ─────────────────────────────────────────── -->
{#if currentShutdown}
  <Modal bind:open={exceptionModalOpen} eyebrow="Ausnahmen" title={currentShutdown.name}>
    <p class="form-hint">
      Mitarbeiter in dieser Liste sind vom Betriebsurlaub ausgenommen — ihr Urlaubskonto wird nicht
      belastet.
    </p>

    <!-- Bestehende Ausnahmen -->
    {#if currentShutdown.exceptions.length === 0}
      <p class="text-muted exception-empty">Noch keine Ausnahmen angelegt.</p>
    {:else}
      <div class="table-responsive exception-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Nr.</th>
              <th>Grund</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each currentShutdown.exceptions as ex (ex.id)}
              <tr>
                <td>{ex.employee.firstName} {ex.employee.lastName}</td>
                <td class="text-muted">{ex.employee.employeeNumber}</td>
                <td class="text-muted">{ex.reason ?? "–"}</td>
                <td>
                  <button
                    class="btn btn-ghost btn-sm btn-danger"
                    onclick={() => removeException(currentShutdown!.id, ex.employeeId)}
                  >
                    Entfernen
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- Mitarbeiter hinzufügen -->
    <div class="exception-add">
      <h4 class="exception-add__title">Mitarbeiter hinzufügen</h4>
      <div class="form-row">
        <div class="form-group exception-add__field">
          <label class="form-label" for="ex-emp">Mitarbeiter</label>
          <select id="ex-emp" class="form-input" bind:value={addExceptionEmpId}>
            <option value="">– Mitarbeiter wählen –</option>
            {#each availableEmployees as emp (emp.id)}
              <option value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option>
            {/each}
          </select>
        </div>
        <div class="form-group exception-add__field">
          <label class="form-label" for="ex-reason">Grund (optional)</label>
          <input
            id="ex-reason"
            class="form-input"
            type="text"
            placeholder="z.B. Notdienstbereitschaft"
            bind:value={addExceptionReason}
          />
        </div>
      </div>
      <button
        class="btn btn-primary btn-sm"
        onclick={addException}
        disabled={!addExceptionEmpId || savingException}
      >
        {savingException ? "Hinzufügen …" : "Hinzufügen"}
      </button>
    </div>
    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeExceptions}>Schließen</button>
    {/snippet}
  </Modal>
{/if}
</div>

<style>
  .year-filter {
    width: auto;
    min-width: 90px;
  }

  /* ── Shutdown wrap card (v1.5) ── */
  :global(.shutdown-card-wrap) {
    padding: var(--pad-card);
  }
  :global(.loading-card) {
    height: 220px;
  }

  .shutdown-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .shutdown-card {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 1rem 1.25rem;
  }

  .shutdown-card__main {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .shutdown-card__info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .shutdown-card__name {
    font-weight: 600;
    color: var(--text);
    font-size: 1rem;
  }

  .shutdown-card__dates {
    font-size: 0.875rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .shutdown-card__notes {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .shutdown-card__meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }

  .shutdown-card__actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  /* ── Exception list inline ── */
  .exception-list {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .exception-list__label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .exception-chip {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.125rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--text);
  }

  .exception-chip__reason {
    color: var(--text-muted);
    margin-left: 0.25rem;
  }

  /* ── Empty state ── */
  :global(.empty-state) {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-muted);
  }

  .empty-icon {
    font-size: 2.5rem;
    margin-bottom: 0.25rem;
    display: block;
  }

  .empty-state__text {
    margin-bottom: 1rem;
  }

  /* ── Badges ── */
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .badge-neutral {
    background: var(--bg-subtle);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .badge-warning {
    background: var(--warn-soft, var(--bg-subtle));
    color: var(--warn);
    border: 1px solid var(--warn);
  }
  .badge-info {
    background: var(--brand-soft);
    color: var(--brand);
    border: 1px solid var(--brand);
  }

  /* ── Forms ── */
  .form-group {
    margin: 0;
  }

  .form-row {
    display: flex;
    gap: 1rem;
  }

  .form-row .form-group {
    flex: 1;
  }

  .form-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  /* ── Exception modal ── */
  .exception-empty {
    margin-bottom: 1.5rem;
  }

  .exception-table-wrap {
    margin-bottom: 1.5rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .data-table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--border);
  }

  .data-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .exception-add {
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .exception-add__title {
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0;
  }

  .exception-add__field {
    flex: 1;
  }

  /* ── Danger button variant ── */
  :global(.btn-danger) {
    color: var(--bad) !important;
  }

  :global(.btn-danger:hover) {
    background: var(--bg-subtle) !important;
  }

  /* ── Alert ── */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: var(--r-sm);
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: var(--bg-subtle);
    color: var(--bad);
    border: 1px solid var(--bad);
  }

  .text-muted {
    color: var(--text-muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 640px) {
    .form-row {
      flex-direction: column;
    }
  }
</style>
