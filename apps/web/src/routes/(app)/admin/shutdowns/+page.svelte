<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";

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
  let addExceptionEmpId = $state("");
  let addExceptionReason = $state("");
  let savingException = $state(false);

  // Jahresfilter
  let filterYear = $state(new Date().getFullYear().toString());

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

  async function deleteShutdown(id: string, name: string) {
    if (!confirm(`Betriebsurlaub "${name}" wirklich löschen?`)) return;
    try {
      await api.delete(`/company-shutdowns/${id}`);
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
  }

  function closeExceptions() {
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

<!-- ── Header ─────────────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h2 class="page-title">Betriebsurlaub</h2>
    <p class="page-subtitle">Schließzeiten verwalten und Ausnahmen festlegen</p>
  </div>
  <div class="header-actions">
    <select class="form-input" bind:value={filterYear} onchange={loadShutdowns}>
      {#each years as y (y)}
        <option value={y}>{y}</option>
      {/each}
    </select>
    <button class="btn btn-primary" onclick={openCreate}>+ Neu</button>
  </div>
</div>

<!-- ── Fehler ─────────────────────────────────────────────────────────────── -->
{#if error}
  <div class="alert alert-error">{error}</div>
{/if}

<!-- ── Inhalt ─────────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="skeleton-list">
    {#each [1, 2, 3] as _, i (i)}
      <div class="skeleton-card"></div>
    {/each}
  </div>
{:else if shutdowns.length === 0}
  <div class="empty-state">
    <p class="empty-state__text">Keine Betriebsurlaube für {filterYear} angelegt.</p>
    <button class="btn btn-primary" onclick={openCreate}>Ersten anlegen</button>
  </div>
{:else}
  <div class="shutdown-list">
    {#each shutdowns as s (s.id)}
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
              onclick={() => deleteShutdown(s.id, s.name)}
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
{/if}

<!-- ── Modal: Betriebsurlaub anlegen / bearbeiten ──────────────────────────── -->
{#if showForm}
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeForm();
    }}
  >
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shutdown-form-title"
      tabindex="-1"
    >
      <div class="modal-header">
        <h3 id="shutdown-form-title" class="modal-title">
          {editId ? "Betriebsurlaub bearbeiten" : "Betriebsurlaub anlegen"}
        </h3>
        <button class="modal-close" onclick={closeForm} aria-label="Schließen">✕</button>
      </div>
      <div class="modal-body">
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
            Wenn aktiv, wird der Betriebsurlaub automatisch vom Jahresurlaub der Mitarbeiter
            abgezogen (außer bei Ausnahmen).
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
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick={closeForm}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveShutdown} disabled={saving}>
          {saving ? "Speichern …" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Modal: Ausnahmen verwalten ─────────────────────────────────────────── -->
{#if exceptionShutdownId && currentShutdown}
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeExceptions();
    }}
  >
    <div
      class="modal modal--wide"
      role="dialog"
      aria-modal="true"
      aria-labelledby="exception-title"
      tabindex="-1"
    >
      <div class="modal-header">
        <h3 id="exception-title" class="modal-title">
          Ausnahmen: {currentShutdown.name}
        </h3>
        <button class="modal-close" onclick={closeExceptions} aria-label="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <p class="form-hint">
          Mitarbeiter in dieser Liste sind vom Betriebsurlaub ausgenommen — ihr Urlaubskonto wird
          nicht belastet.
        </p>

        <!-- Bestehende Ausnahmen -->
        {#if currentShutdown.exceptions.length === 0}
          <p class="text-muted" style="margin-bottom: 1.5rem;">Noch keine Ausnahmen angelegt.</p>
        {:else}
          <div class="table-responsive">
            <table class="data-table" style="margin-bottom: 1.5rem;">
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
            <div class="form-group" style="flex:1">
              <label class="form-label" for="ex-emp">Mitarbeiter</label>
              <select id="ex-emp" class="form-input" bind:value={addExceptionEmpId}>
                <option value="">– Mitarbeiter wählen –</option>
                {#each availableEmployees as emp (emp.id)}
                  <option value={emp.id}
                    >{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option
                  >
                {/each}
              </select>
            </div>
            <div class="form-group" style="flex:1">
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
            class="btn btn-primary"
            onclick={addException}
            disabled={!addExceptionEmpId || savingException}
          >
            {savingException ? "Hinzufügen …" : "Hinzufügen"}
          </button>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick={closeExceptions}>Schließen</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .page-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0 0 0.25rem;
  }

  .page-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .header-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  /* ── Shutdown Cards ── */
  .shutdown-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .shutdown-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
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
    color: var(--color-text);
    font-size: 1rem;
  }

  .shutdown-card__dates {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .shutdown-card__notes {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
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
    border-top: 1px solid var(--color-border);
  }

  .exception-list__label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .exception-chip {
    background: var(--color-surface-alt, var(--color-border));
    border-radius: 999px;
    padding: 0.125rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--color-text);
  }

  .exception-chip__reason {
    color: var(--color-text-muted);
    margin-left: 0.25rem;
  }

  /* ── Skeleton ── */
  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .skeleton-card {
    height: 80px;
    border-radius: var(--radius-md);
    background: var(--color-border);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  /* ── Empty state ── */
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-text-muted);
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
    background: var(--color-border);
    color: var(--color-text-muted);
  }
  .badge-warning {
    background: #fef3c7;
    color: #92400e;
  }
  .badge-info {
    background: #dbeafe;
    color: #1d4ed8;
  }

  /* ── Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }

  .modal {
    background: var(--color-surface);
    border-radius: var(--radius-lg);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
    width: 100%;
    max-width: 520px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal--wide {
    max-width: 680px;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
  }

  .modal-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.125rem;
    color: var(--color-text-muted);
    padding: 0.25rem;
    line-height: 1;
  }

  .modal-body {
    padding: 1.5rem;
  }

  .modal-footer {
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--color-border);
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  /* ── Forms ── */
  .form-group {
    margin-bottom: 1rem;
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
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  /* ── Exception add section ── */
  .exception-add {
    border-top: 1px solid var(--color-border);
    padding-top: 1rem;
  }

  .exception-add__title {
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
  }

  /* ── Danger button variant ── */
  :global(.btn-danger) {
    color: var(--color-error, #dc2626) !important;
  }

  :global(.btn-danger:hover) {
    background: rgba(220, 38, 38, 0.08) !important;
  }

  /* ── Alert ── */
  .alert {
    padding: 0.75rem 1rem;
    border-radius: var(--radius-sm);
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: rgba(220, 38, 38, 0.08);
    color: var(--color-error, #dc2626);
    border: 1px solid rgba(220, 38, 38, 0.2);
  }

  .text-muted {
    color: var(--color-text-muted);
  }

  .table-responsive {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  @media (max-width: 640px) {
    .form-row {
      flex-direction: column;
    }
  }
</style>
