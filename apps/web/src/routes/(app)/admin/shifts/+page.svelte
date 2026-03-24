<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";

  // ── Typen ─────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }

  interface ShiftTemplate {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    color: string;
  }

  interface Shift {
    id: string;
    employeeId: string;
    templateId: string | null;
    date: string;
    startTime: string;
    endTime: string;
    label: string | null;
    note: string | null;
    employee: { id: string; firstName: string; lastName: string; employeeNumber: string };
    template: { name: string; color: string } | null;
  }

  interface WeekData {
    weekDays: string[];
    employees: Employee[];
    shifts: Shift[];
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let weekDays: string[] = $state([]);
  let employees: Employee[] = $state([]);
  let shifts: Shift[] = $state([]);
  let templates: ShiftTemplate[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Current week reference date (Monday)
  let currentDate = $state(getMondayOfWeek(new Date()));

  // Modal state
  let showModal = $state(false);
  let modalEmployeeId = $state("");
  let modalDate = $state("");
  let modalTemplateId = $state("");
  let modalStartTime = $state("08:00");
  let modalEndTime = $state("16:00");
  let modalLabel = $state("");
  let modalNote = $state("");
  let modalError = $state("");
  let saving = $state(false);

  // Quick-assign mode
  let quickMode = $state(false);
  let quickTemplateId = $state("");

  // Template management
  let showTemplatePanel = $state(false);
  let tplName = $state("");
  let tplStart = $state("06:00");
  let tplEnd = $state("14:00");
  let tplColor = $state("#3B82F6");
  let tplError = $state("");
  let tplSaving = $state(false);

  // ── Derived ───────────────────────────────────────────────────────────────
  const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  const quickTemplate = $derived(
    quickTemplateId ? templates.find(t => t.id === quickTemplateId) : null
  );

  const weekLabel = $derived(() => {
    if (weekDays.length < 7) return "";
    const start = formatDateShort(weekDays[0]);
    const end = formatDateShort(weekDays[6]);
    return `${start} – ${end}`;
  });

  // ── Hilfsfunktionen ─────────────────────────────────────────────────────
  function getMondayOfWeek(d: Date): string {
    const date = new Date(d);
    const dow = date.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  }

  function formatDateShort(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  }

  function formatDateFull(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function getShiftsForCell(employeeId: string, date: string): Shift[] {
    return shifts.filter(s => s.employeeId === employeeId && s.date.startsWith(date));
  }

  function shiftColor(shift: Shift): string {
    return shift.template?.color ?? "#6B7280";
  }

  // ── Lade-Funktionen ───────────────────────────────────────────────────────
  async function loadWeek() {
    loading = true;
    error = "";
    try {
      const data = await api.get<WeekData>(`/shifts/week?date=${currentDate}`);
      weekDays = data.weekDays;
      employees = data.employees;
      shifts = data.shifts;
    } catch {
      error = "Fehler beim Laden der Schichtdaten.";
    } finally {
      loading = false;
    }
  }

  async function loadTemplates() {
    try {
      templates = await api.get<ShiftTemplate[]>("/shifts/templates");
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadWeek();
    loadTemplates();
  });

  // ── Wochennavigation ──────────────────────────────────────────────────────
  function prevWeek() {
    const d = new Date(currentDate + "T00:00:00");
    d.setDate(d.getDate() - 7);
    currentDate = d.toISOString().split("T")[0];
    loadWeek();
  }

  function nextWeek() {
    const d = new Date(currentDate + "T00:00:00");
    d.setDate(d.getDate() + 7);
    currentDate = d.toISOString().split("T")[0];
    loadWeek();
  }

  function goToday() {
    currentDate = getMondayOfWeek(new Date());
    loadWeek();
  }

  // ── Zelle klicken ─────────────────────────────────────────────────────────
  async function onCellClick(employeeId: string, date: string) {
    if (quickMode && quickTemplate) {
      // Quick-assign: sofort erstellen
      try {
        const shift = await api.post<Shift>("/shifts", {
          employeeId,
          templateId: quickTemplate.id,
          date,
          startTime: quickTemplate.startTime,
          endTime: quickTemplate.endTime,
        });
        shifts = [...shifts, shift];
      } catch {
        alert("Schicht konnte nicht erstellt werden.");
      }
      return;
    }
    // Normaler Modus: Modal öffnen
    modalEmployeeId = employeeId;
    modalDate = date;
    modalTemplateId = "";
    modalStartTime = "08:00";
    modalEndTime = "16:00";
    modalLabel = "";
    modalNote = "";
    modalError = "";
    showModal = true;
  }

  function onTemplateSelect() {
    const tpl = templates.find(t => t.id === modalTemplateId);
    if (tpl) {
      modalStartTime = tpl.startTime;
      modalEndTime = tpl.endTime;
      modalLabel = tpl.name;
    }
  }

  async function saveShift() {
    if (!modalStartTime || !modalEndTime) {
      modalError = "Start- und Endzeit sind Pflichtfelder.";
      return;
    }
    saving = true;
    modalError = "";
    try {
      const shift = await api.post<Shift>("/shifts", {
        employeeId: modalEmployeeId,
        templateId: modalTemplateId || undefined,
        date: modalDate,
        startTime: modalStartTime,
        endTime: modalEndTime,
        label: modalLabel || undefined,
        note: modalNote || undefined,
      });
      shifts = [...shifts, shift];
      showModal = false;
    } catch {
      modalError = "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  async function deleteShift(shiftId: string) {
    if (!confirm("Schicht wirklich löschen?")) return;
    try {
      await api.delete(`/shifts/${shiftId}`);
      shifts = shifts.filter(s => s.id !== shiftId);
    } catch {
      alert("Löschen fehlgeschlagen.");
    }
  }

  // ── Template-Verwaltung ───────────────────────────────────────────────────
  async function createTemplate() {
    if (!tplName.trim() || !tplStart || !tplEnd) {
      tplError = "Name, Start- und Endzeit sind Pflichtfelder.";
      return;
    }
    tplSaving = true;
    tplError = "";
    try {
      await api.post("/shifts/templates", {
        name: tplName.trim(),
        startTime: tplStart,
        endTime: tplEnd,
        color: tplColor,
      });
      tplName = "";
      tplStart = "06:00";
      tplEnd = "14:00";
      tplColor = "#3B82F6";
      await loadTemplates();
    } catch {
      tplError = "Erstellen fehlgeschlagen.";
    } finally {
      tplSaving = false;
    }
  }

  async function deleteTemplate(id: string, name: string) {
    if (!confirm(`Vorlage "${name}" wirklich löschen?`)) return;
    try {
      await api.delete(`/shifts/templates/${id}`);
      await loadTemplates();
    } catch {
      alert("Löschen fehlgeschlagen.");
    }
  }

  // Modal employee name
  const modalEmployeeName = $derived(() => {
    const emp = employees.find(e => e.id === modalEmployeeId);
    return emp ? `${emp.firstName} ${emp.lastName}` : "";
  });
</script>

<!-- ── Header ─────────────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h2 class="page-title">Schichtplan</h2>
    <p class="page-subtitle">Wochenansicht der Schichtplanung</p>
  </div>
  <div class="header-actions">
    <button class="btn btn-secondary btn-sm" onclick={() => showTemplatePanel = !showTemplatePanel}>
      Vorlagen
    </button>
    <button
      class="btn btn-sm"
      class:btn-primary={quickMode}
      class:btn-secondary={!quickMode}
      onclick={() => quickMode = !quickMode}
    >
      Schnellzuweisung {quickMode ? "an" : "aus"}
    </button>
  </div>
</div>

<!-- ── Quick-assign bar ──────────────────────────────────────────────────── -->
{#if quickMode}
  <div class="quick-bar">
    <span class="quick-bar__label">Vorlage wählen:</span>
    <div class="quick-bar__templates">
      {#each templates as tpl (tpl.id)}
        <button
          class="template-chip"
          class:template-chip--active={quickTemplateId === tpl.id}
          style="--chip-color: {tpl.color}"
          onclick={() => quickTemplateId = tpl.id}
        >
          {tpl.name} ({tpl.startTime}–{tpl.endTime})
        </button>
      {/each}
      {#if templates.length === 0}
        <span class="text-muted">Keine Vorlagen vorhanden. Erstellen Sie zuerst eine Vorlage.</span>
      {/if}
    </div>
    {#if quickTemplate}
      <p class="quick-bar__hint">Klicken Sie auf leere Zellen, um die Schicht zuzuweisen.</p>
    {/if}
  </div>
{/if}

<!-- ── Template-Verwaltung ───────────────────────────────────────────────── -->
{#if showTemplatePanel}
  <div class="template-panel">
    <h3 class="template-panel__title">Schichtvorlagen</h3>
    {#if templates.length > 0}
      <div class="template-list">
        {#each templates as tpl (tpl.id)}
          <div class="template-item">
            <span class="template-item__color" style="background: {tpl.color}"></span>
            <span class="template-item__name">{tpl.name}</span>
            <span class="template-item__times">{tpl.startTime} – {tpl.endTime}</span>
            <button class="btn btn-ghost btn-sm btn-danger" onclick={() => deleteTemplate(tpl.id, tpl.name)}>
              Löschen
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="text-muted">Noch keine Vorlagen vorhanden.</p>
    {/if}

    <div class="template-form">
      <h4 class="template-form__title">Neue Vorlage</h4>
      {#if tplError}
        <div class="alert alert-error">{tplError}</div>
      {/if}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="tpl-name">Name</label>
          <input id="tpl-name" class="form-input" type="text" bind:value={tplName}
            placeholder="z.B. Frühschicht" />
        </div>
        <div class="form-group">
          <label class="form-label" for="tpl-start">Start</label>
          <input id="tpl-start" class="form-input" type="time" bind:value={tplStart} />
        </div>
        <div class="form-group">
          <label class="form-label" for="tpl-end">Ende</label>
          <input id="tpl-end" class="form-input" type="time" bind:value={tplEnd} />
        </div>
        <div class="form-group">
          <label class="form-label" for="tpl-color">Farbe</label>
          <input id="tpl-color" class="form-input form-input--color" type="color" bind:value={tplColor} />
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick={createTemplate} disabled={tplSaving}>
        {tplSaving ? "Erstellen …" : "Vorlage erstellen"}
      </button>
    </div>
  </div>
{/if}

<!-- ── Fehler ─────────────────────────────────────────────────────────────── -->
{#if error}
  <div class="alert alert-error">{error}</div>
{/if}

<!-- ── Wochennavigation ──────────────────────────────────────────────────── -->
<div class="week-nav">
  <button class="btn btn-ghost btn-sm" onclick={prevWeek}>&larr; Vorherige</button>
  <button class="btn btn-ghost btn-sm" onclick={goToday}>Heute</button>
  <span class="week-nav__label">{weekLabel()}</span>
  <button class="btn btn-ghost btn-sm" onclick={nextWeek}>Nächste &rarr;</button>
</div>

<!-- ── Grid ──────────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="skeleton-list">
    {#each [1,2,3] as _}
      <div class="skeleton-card"></div>
    {/each}
  </div>
{:else if employees.length === 0}
  <div class="empty-state">
    <p class="empty-state__text">Keine Mitarbeiter vorhanden.</p>
  </div>
{:else}
  <div class="grid-wrapper">
    <table class="shift-grid">
      <thead>
        <tr>
          <th class="grid-header grid-header--employee">Mitarbeiter</th>
          {#each weekDays as day, i}
            <th class="grid-header">
              <span class="grid-header__day">{DAY_NAMES[i]}</span>
              <span class="grid-header__date">{formatDateShort(day)}</span>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each employees as emp (emp.id)}
          <tr>
            <td class="grid-employee">
              <span class="grid-employee__name">{emp.lastName}, {emp.firstName}</span>
              <span class="grid-employee__nr">{emp.employeeNumber}</span>
            </td>
            {#each weekDays as day}
              {@const cellShifts = getShiftsForCell(emp.id, day)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <td
                class="grid-cell"
                class:grid-cell--empty={cellShifts.length === 0}
                onclick={() => { if (cellShifts.length === 0) onCellClick(emp.id, day); }}
                role={cellShifts.length === 0 ? "button" : undefined}
                tabindex={cellShifts.length === 0 ? 0 : undefined}
              >
                {#each cellShifts as shift (shift.id)}
                  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                  <div
                    class="shift-block"
                    style="background: {shiftColor(shift)}22; border-left: 3px solid {shiftColor(shift)}"
                    onclick={(e: MouseEvent) => { e.stopPropagation(); deleteShift(shift.id); }}
                    title="Klicken zum Löschen"
                  >
                    <span class="shift-block__label">{shift.label ?? shift.startTime + "–" + shift.endTime}</span>
                    <span class="shift-block__time">{shift.startTime}–{shift.endTime}</span>
                  </div>
                {/each}
                {#if cellShifts.length === 0}
                  <span class="grid-cell__plus">+</span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<!-- ── Modal: Schicht erstellen ──────────────────────────────────────────── -->
{#if showModal}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={(e) => { if (e.target === e.currentTarget) showModal = false; }}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shift-modal-title">
      <div class="modal-header">
        <h3 id="shift-modal-title" class="modal-title">Schicht zuweisen</h3>
        <button class="modal-close" onclick={() => showModal = false} aria-label="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <p class="modal-context">
          <strong>{modalEmployeeName()}</strong> am {formatDateFull(modalDate)}
        </p>
        {#if modalError}
          <div class="alert alert-error">{modalError}</div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="shift-tpl">Vorlage (optional)</label>
          <select id="shift-tpl" class="form-input" bind:value={modalTemplateId} onchange={onTemplateSelect}>
            <option value="">– Benutzerdefiniert –</option>
            {#each templates as tpl (tpl.id)}
              <option value={tpl.id}>{tpl.name} ({tpl.startTime}–{tpl.endTime})</option>
            {/each}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="shift-start">Startzeit *</label>
            <input id="shift-start" class="form-input" type="time" bind:value={modalStartTime} />
          </div>
          <div class="form-group">
            <label class="form-label" for="shift-end">Endzeit *</label>
            <input id="shift-end" class="form-input" type="time" bind:value={modalEndTime} />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="shift-label">Bezeichnung (optional)</label>
          <input id="shift-label" class="form-input" type="text" bind:value={modalLabel}
            placeholder="z.B. Frühschicht" />
        </div>
        <div class="form-group">
          <label class="form-label" for="shift-note">Notiz (optional)</label>
          <textarea id="shift-note" class="form-input" rows="2" bind:value={modalNote}
            placeholder="Zusätzliche Informationen…"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick={() => showModal = false}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveShift} disabled={saving}>
          {saving ? "Speichern …" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Page header ── */
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

  /* ── Quick-assign bar ── */
  .quick-bar {
    background: var(--color-surface);
    border: 1px solid var(--color-brand);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .quick-bar__label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
    margin-right: 0.5rem;
  }

  .quick-bar__templates {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .quick-bar__hint {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0.5rem 0 0;
  }

  .template-chip {
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    border: 2px solid var(--chip-color);
    background: transparent;
    color: var(--color-text);
    cursor: pointer;
    transition: background 0.12s;
  }

  .template-chip:hover {
    background: color-mix(in srgb, var(--chip-color) 15%, transparent);
  }

  .template-chip--active {
    background: var(--chip-color);
    color: white;
  }

  /* ── Template panel ── */
  .template-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .template-panel__title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 1rem;
  }

  .template-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .template-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .template-item__color {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .template-item__name {
    font-weight: 500;
    font-size: 0.9rem;
  }

  .template-item__times {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin-right: auto;
  }

  .template-form {
    border-top: 1px solid var(--color-border);
    padding-top: 1rem;
    margin-top: 0.5rem;
  }

  .template-form__title {
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
  }

  /* ── Week nav ── */
  .week-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .week-nav__label {
    font-weight: 600;
    font-size: 0.95rem;
    min-width: 140px;
    text-align: center;
  }

  /* ── Grid ── */
  .grid-wrapper {
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .shift-grid {
    width: 100%;
    border-collapse: collapse;
    min-width: 800px;
  }

  .grid-header {
    padding: 0.625rem 0.5rem;
    text-align: center;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
    background: var(--color-surface);
    border-bottom: 2px solid var(--color-border);
  }

  .grid-header--employee {
    text-align: left;
    min-width: 160px;
    padding-left: 0.75rem;
  }

  .grid-header__day {
    display: block;
  }

  .grid-header__date {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .grid-employee {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
    vertical-align: middle;
  }

  .grid-employee__name {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .grid-employee__nr {
    display: block;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .grid-cell {
    padding: 0.25rem;
    border-bottom: 1px solid var(--color-border);
    border-right: 1px solid var(--color-border);
    vertical-align: top;
    min-width: 90px;
    min-height: 48px;
    position: relative;
  }

  .grid-cell--empty {
    cursor: pointer;
    transition: background 0.12s;
  }

  .grid-cell--empty:hover {
    background: var(--color-surface-alt, rgba(59, 130, 246, 0.05));
  }

  .grid-cell__plus {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 40px;
    font-size: 1.25rem;
    color: var(--color-text-muted);
    opacity: 0;
    transition: opacity 0.12s;
  }

  .grid-cell--empty:hover .grid-cell__plus {
    opacity: 1;
  }

  /* ── Shift block ── */
  .shift-block {
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    margin-bottom: 0.125rem;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  .shift-block:hover {
    opacity: 0.7;
  }

  .shift-block__label {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .shift-block__time {
    display: block;
    font-size: 0.6875rem;
    color: var(--color-text-muted);
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
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.5; }
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

  /* ── Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }

  .modal {
    background: var(--color-surface);
    border-radius: var(--radius-lg);
    box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    width: 100%;
    max-width: 520px;
    max-height: 90vh;
    overflow-y: auto;
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

  .modal-context {
    font-size: 0.9rem;
    color: var(--color-text);
    margin: 0 0 1rem;
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

  .form-input--color {
    width: 48px;
    height: 36px;
    padding: 2px;
    cursor: pointer;
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

  .text-muted { color: var(--color-text-muted); }

  :global(.btn-danger) {
    color: var(--color-error, #dc2626) !important;
  }

  :global(.btn-danger:hover) {
    background: rgba(220, 38, 38, 0.08) !important;
  }
</style>
