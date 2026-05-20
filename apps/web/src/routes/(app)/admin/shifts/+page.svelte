<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Modal from "$components/ui/Modal.svelte";

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

  // ── Default-Farbe aus Token ──────────────────────────────────────────────
  // `<input type="color">` benötigt einen literalen Hex-Wert; daher lesen wir
  // den Token-Wert beim Mount aus den computed styles. Kein Inline-Hex-Fallback —
  // wenn der Token nicht aufgelöst werden kann (z. B. SSR), bleibt der Wert leer
  // und der Browser zeigt die Default-Farbe des color-Inputs.
  function resolveShiftToken(name: string, fallback = ""): string {
    if (typeof window === "undefined") return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let weekDays: string[] = $state([]);
  let employees: Employee[] = $state([]);
  let shifts: Shift[] = $state([]);
  let templates: ShiftTemplate[] = $state([]);

  // Pagination for template management list
  let tplPage = $state(1);
  let tplPageSize = $state(10);
  let pagedTemplates = $derived(
    templates.slice((tplPage - 1) * tplPageSize, tplPage * tplPageSize),
  );
  let loading = $state(true);
  let error = $state("");
  let timeEntries: Array<{
    employeeId: string;
    date: string;
    startTime: string;
    endTime: string | null;
    breakMinutes: number;
  }> = $state([]);

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

  // Edit state
  let editingShiftId: string | null = $state(null);

  // Quick-assign mode
  let quickMode = $state(false);
  let quickTemplateId = $state("");

  // Template management
  let showTemplatePanel = $state(false);
  let tplName = $state("");
  let tplStart = $state("06:00");
  let tplEnd = $state("14:00");
  // Default-Farbe wird beim Mount aus var(--shift-violet) gelesen.
  // Leerer Initialwert vermeidet Inline-Hex; `<input type=color>` zeigt
  // Schwarz an, bis onMount() den Token-Wert befüllt (geschieht synchron
  // beim ersten Render, da Pagination etc. ohnehin client-only laden).
  let tplColor = $state("");
  let tplError = $state("");
  let tplSaving = $state(false);

  // Bestätigungs-Dialoge
  let shiftDeleteConfirm = $state<{ open: boolean; id: string | null; closeAfter: boolean }>({
    open: false,
    id: null,
    closeAfter: false,
  });
  let templateDeleteConfirm = $state<{ open: boolean; id: string | null; name: string }>({
    open: false,
    id: null,
    name: "",
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  const quickTemplate = $derived(
    quickTemplateId ? templates.find((t) => t.id === quickTemplateId) : null,
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

  function isTodayIso(iso: string): boolean {
    const today = new Date();
    const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return iso.slice(0, 10) === t;
  }

  function getShiftsForCell(employeeId: string, date: string): Shift[] {
    return shifts.filter((s) => s.employeeId === employeeId && s.date.startsWith(date));
  }

  function getActualHours(employeeId: string, date: string): number | null {
    const entries = timeEntries.filter(
      (e) => e.employeeId === employeeId && (e.date as string).startsWith(date) && e.endTime,
    );
    if (entries.length === 0) return null;
    return entries.reduce((sum, e) => {
      const start = new Date(e.startTime).getTime();
      const end = new Date(e.endTime!).getTime();
      return sum + (end - start) / 3600000 - (e.breakMinutes ?? 0) / 60;
    }, 0);
  }

  function shiftLabel(s: Shift): string {
    return s.label ?? `${s.startTime.slice(0, 5)}–${s.endTime.slice(0, 5)}`;
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

      // Also load time entries for the same week
      try {
        const from = weekDays[0];
        const to = weekDays[6];
        timeEntries = await api.get<typeof timeEntries>(`/time-entries?from=${from}&to=${to}`);
      } catch (err) {
        console.error("Failed to load time entries for shift view:", err);
      }
    } catch {
      error = "Fehler beim Laden der Schichtdaten.";
    } finally {
      loading = false;
    }
  }

  async function loadTemplates() {
    try {
      templates = await api.get<ShiftTemplate[]>("/shifts/templates");
    } catch (err) {
      console.error("Failed to load shift templates:", err);
    }
  }

  onMount(() => {
    // Initialer Farbwert aus Token (Schicht-Palette, theme-unabhängig).
    tplColor = resolveShiftToken("--shift-violet");
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
    editingShiftId = null;
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
    const tpl = templates.find((t) => t.id === modalTemplateId);
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
      if (editingShiftId) {
        // Update existing
        const updated = await api.put<Shift>(`/shifts/${editingShiftId}`, {
          templateId: modalTemplateId || undefined,
          startTime: modalStartTime,
          endTime: modalEndTime,
          label: modalLabel || undefined,
          note: modalNote || undefined,
        });
        shifts = shifts.map((s) => (s.id === editingShiftId ? updated : s));
      } else {
        // Create new
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
      }
      showModal = false;
      editingShiftId = null;
    } catch {
      modalError = "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  function askDeleteShift(shiftId: string, closeAfter = false) {
    shiftDeleteConfirm = { open: true, id: shiftId, closeAfter };
  }

  async function confirmDeleteShift() {
    const id = shiftDeleteConfirm.id;
    if (!id) return;
    try {
      await api.delete(`/shifts/${id}`);
      shifts = shifts.filter((s) => s.id !== id);
      if (shiftDeleteConfirm.closeAfter) {
        showModal = false;
        editingShiftId = null;
      }
    } catch {
      alert("Löschen fehlgeschlagen.");
    }
  }

  function openEditShift(shift: Shift) {
    editingShiftId = shift.id;
    modalEmployeeId = shift.employeeId;
    modalDate = shift.date.split("T")[0];
    modalTemplateId = shift.templateId ?? "";
    modalStartTime = shift.startTime;
    modalEndTime = shift.endTime;
    modalLabel = shift.label ?? "";
    modalNote = shift.note ?? "";
    modalError = "";
    showModal = true;
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
      tplColor = resolveShiftToken("--shift-violet");
      await loadTemplates();
    } catch {
      tplError = "Erstellen fehlgeschlagen.";
    } finally {
      tplSaving = false;
    }
  }

  function askDeleteTemplate(id: string, name: string) {
    templateDeleteConfirm = { open: true, id, name };
  }

  async function confirmDeleteTemplate() {
    if (!templateDeleteConfirm.id) return;
    try {
      await api.delete(`/shifts/templates/${templateDeleteConfirm.id}`);
      await loadTemplates();
    } catch {
      alert("Löschen fehlgeschlagen.");
    }
  }

  // Schnellauswahl-Palette (theme-unabhängige Schichtfarben aus tokens.css)
  const SHIFT_PALETTE = [
    { token: "--shift-violet", label: "Violett" },
    { token: "--shift-blue", label: "Blau" },
    { token: "--shift-green", label: "Grün" },
    { token: "--shift-amber", label: "Bernstein" },
    { token: "--shift-rose", label: "Rose" },
    { token: "--shift-slate", label: "Schiefer" },
  ];

  function pickPaletteColor(token: string) {
    tplColor = resolveShiftToken(token, tplColor);
  }

  // Modal employee name
  const modalEmployeeName = $derived(() => {
    const emp = employees.find((e) => e.id === modalEmployeeId);
    return emp ? `${emp.firstName} ${emp.lastName}` : "";
  });
</script>

<svelte:head>
  <title>Schichtplan – Clokr</title>
</svelte:head>

<div class="page">
  <PageHead
    eyebrow="Administration"
    title="Schichtplan"
    accent="Schicht"
    sub="Wochenansicht der Schichtplanung — Vorlagen verwalten und Schichten zuweisen."
  />

  <!-- ── Action toolbar ──────────────────────────────────────────────────────── -->
  <div class="toolbar card-animate">
    <button
      type="button"
      class="btn btn-outline sm"
      onclick={() => (showTemplatePanel = !showTemplatePanel)}
    >
      Vorlagen {showTemplatePanel ? "schließen" : "verwalten"}
    </button>
    <button
      type="button"
      class="btn sm"
      class:btn-primary={quickMode}
      class:btn-outline={!quickMode}
      onclick={() => (quickMode = !quickMode)}
    >
      Schnellzuweisung {quickMode ? "an" : "aus"}
    </button>
  </div>

  <!-- ── Quick-assign bar ──────────────────────────────────────────────────── -->
  {#if quickMode}
    <Card animate class="quick-bar">
      <CardHeader title="Schnellzuweisung" sub="Vorlage wählen und freie Zellen anklicken" />
      <div class="quick-bar__templates">
        {#each templates as tpl (tpl.id)}
          <button
            type="button"
            class="template-chip"
            class:template-chip--active={quickTemplateId === tpl.id}
            style:--chip-color={tpl.color}
            onclick={() => (quickTemplateId = tpl.id)}
          >
            {tpl.name} ({tpl.startTime}–{tpl.endTime})
          </button>
        {/each}
        {#if templates.length === 0}
          <span class="muted">Keine Vorlagen vorhanden. Erstellen Sie zuerst eine Vorlage.</span>
        {/if}
      </div>
      {#if quickTemplate}
        <p class="quick-bar__hint">Klicken Sie auf leere Zellen, um die Schicht zuzuweisen.</p>
      {/if}
    </Card>
  {/if}

  <!-- ── Template-Verwaltung ───────────────────────────────────────────────── -->
  {#if showTemplatePanel}
    <Card animate class="template-panel">
      <CardHeader title="Schichtvorlagen" sub="Wiederkehrende Schichtmuster pflegen" />

      {#if templates.length > 0}
        <div class="template-list">
          {#each pagedTemplates as tpl (tpl.id)}
            <div class="template-item">
              <span class="template-item__color" style:background={tpl.color} aria-hidden="true"
              ></span>
              <span class="template-item__name">{tpl.name}</span>
              <span class="template-item__times">{tpl.startTime} – {tpl.endTime}</span>
              <button
                type="button"
                class="btn btn-ghost sm"
                onclick={() => askDeleteTemplate(tpl.id, tpl.name)}
              >
                Löschen
              </button>
            </div>
          {/each}
        </div>
        <Pagination total={templates.length} bind:page={tplPage} bind:pageSize={tplPageSize} />
      {:else}
        <p class="muted">Noch keine Vorlagen vorhanden.</p>
      {/if}

      <div class="template-form">
        <div class="serif-eyebrow template-form__eyebrow">Neue Vorlage</div>
        {#if tplError}
          <div class="callout error" role="alert">{tplError}</div>
        {/if}
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="tpl-name">Name</label>
            <input
              id="tpl-name"
              class="form-input"
              type="text"
              bind:value={tplName}
              placeholder="z.B. Frühschicht"
            />
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
            <input
              id="tpl-color"
              class="form-input form-input--color"
              type="color"
              bind:value={tplColor}
            />
          </div>
        </div>
        <div class="palette-row" role="group" aria-label="Schichtfarbe wählen">
          {#each SHIFT_PALETTE as p (p.token)}
            <button
              type="button"
              class="palette-swatch"
              style:background="var({p.token})"
              title={p.label}
              aria-label={p.label}
              onclick={() => pickPaletteColor(p.token)}
            ></button>
          {/each}
        </div>
        <button
          type="button"
          class="btn btn-primary sm"
          onclick={createTemplate}
          disabled={tplSaving}
        >
          {tplSaving ? "Erstellen …" : "Vorlage erstellen"}
        </button>
      </div>
    </Card>
  {/if}

  <!-- ── Fehler ─────────────────────────────────────────────────────────────── -->
  {#if error}
    <div class="callout error card-animate" role="alert">{error}</div>
  {/if}

  <!-- ── Grid card ─────────────────────────────────────────────────────────── -->
  <div class="card card-animate week-card">
    <div class="week-header">
      <div class="serif-eyebrow week-label">
        Woche {weekLabel()}
      </div>
      <div class="spacer"></div>
      <button type="button" class="btn btn-ghost sm" onclick={prevWeek} aria-label="Vorherige Woche"
        >‹</button
      >
      <button type="button" class="btn btn-ghost sm" onclick={goToday}>Heute</button>
      <button type="button" class="btn btn-ghost sm" onclick={nextWeek} aria-label="Nächste Woche"
        >›</button
      >
    </div>

    <div class="week-body">
      {#if loading}
        <div class="state-msg">Lade Woche …</div>
      {:else if employees.length === 0}
        <div class="state-msg">Keine Mitarbeiter vorhanden.</div>
      {:else}
        {#if templates.length === 0}
          <div class="callout brand template-hint">
            <span class="ico" aria-hidden="true">ⓘ</span>
            <div>
              Erstellen Sie zuerst eine Schichtvorlage über den Button <b>Vorlagen verwalten</b>, um
              Schichten zuweisen zu können.
            </div>
          </div>
        {/if}

        <div class="shift-grid">
          <div class="head">Person</div>
          {#each weekDays as day, i (day)}
            <div class="head" class:today-col={isTodayIso(day)}>
              <div>{DAY_NAMES[i]}</div>
              <div class="head-date">{formatDateShort(day)}</div>
            </div>
          {/each}

          {#each employees as emp (emp.id)}
            <div class="who-cell">
              <div class="name">{emp.lastName}, {emp.firstName}</div>
              <div class="role">{emp.employeeNumber}</div>
            </div>
            {#each weekDays as day (day)}
              {@const cellShifts = getShiftsForCell(emp.id, day)}
              {@const actual = getActualHours(emp.id, day)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="shift-cell"
                class:off={cellShifts.length === 0}
                class:assignable={cellShifts.length === 0}
                onclick={() => {
                  if (cellShifts.length === 0) onCellClick(emp.id, day);
                }}
                onkeydown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && cellShifts.length === 0)
                    onCellClick(emp.id, day);
                }}
                role={cellShifts.length === 0 ? "button" : undefined}
                tabindex={cellShifts.length === 0 ? 0 : undefined}
              >
                {#if cellShifts.length > 0}
                  <div class="shift-stack">
                    {#each cellShifts as shift (shift.id)}
                      <button
                        type="button"
                        class="shift-pill"
                        onclick={(e: MouseEvent) => {
                          e.stopPropagation();
                          openEditShift(shift);
                        }}
                        title="Klicken zum Bearbeiten"
                      >
                        {shiftLabel(shift)}
                      </button>
                    {/each}
                    {#if actual !== null}
                      <span class="cell-actual">IST: {actual.toFixed(1)}h</span>
                    {/if}
                  </div>
                {:else if actual !== null && actual > 0}
                  <span class="cell-actual unplanned">{actual.toFixed(1)}h ungeplant</span>
                {:else}
                  frei
                {/if}
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- ── Modal: Schicht erstellen ──────────────────────────────────────────── -->
  <Modal
    bind:open={showModal}
    eyebrow="Schichtplanung"
    title={editingShiftId ? "Schicht bearbeiten" : "Schicht zuweisen"}
  >
    <p class="modal-context">
      <strong>{modalEmployeeName()}</strong> am {formatDateFull(modalDate)}
    </p>
    {#if modalError}
      <div class="callout error" role="alert">{modalError}</div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="shift-tpl">Vorlage (optional)</label>
      <select
        id="shift-tpl"
        class="form-input"
        bind:value={modalTemplateId}
        onchange={onTemplateSelect}
      >
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
      <input
        id="shift-label"
        class="form-input"
        type="text"
        bind:value={modalLabel}
        placeholder="z.B. Frühschicht"
      />
    </div>
    <div class="form-group">
      <label class="form-label" for="shift-note">Notiz (optional)</label>
      <textarea
        id="shift-note"
        class="form-input"
        rows="2"
        bind:value={modalNote}
        placeholder="Zusätzliche Informationen…"
      ></textarea>
    </div>
    {#snippet footer()}
      {#if editingShiftId}
        <button
          type="button"
          class="btn btn-danger sm"
          onclick={() => askDeleteShift(editingShiftId!, true)}
        >
          Löschen
        </button>
      {/if}
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (showModal = false)}
        >Abbrechen</button
      >
      <button type="button" class="btn btn-primary sm" onclick={saveShift} disabled={saving}>
        {saving ? "Speichern …" : "Speichern"}
      </button>
    {/snippet}
  </Modal>

  <!-- ── Bestätigungs-Dialoge ──────────────────────────────────────────────── -->
  <ConfirmDialog
    bind:open={shiftDeleteConfirm.open}
    title="Schicht löschen?"
    description="Diese Schicht und alle Zuweisungen werden gelöscht."
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDeleteShift}
  />

  <ConfirmDialog
    bind:open={templateDeleteConfirm.open}
    title="Vorlage löschen?"
    description={`Die Vorlage „${templateDeleteConfirm.name}" wird dauerhaft entfernt.`}
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDeleteTemplate}
  />
</div>

<style>
  /* ── Action toolbar ── */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 18px;
  }

  /* ── Quick-assign card ── */
  .quick-bar {
    margin-bottom: 18px;
  }
  .quick-bar__templates {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .quick-bar__hint {
    font-size: 13px;
    color: var(--text-muted);
    margin: 12px 0 0;
  }

  .template-chip {
    padding: 4px 12px;
    border-radius: var(--r-pill);
    font-size: 12.5px;
    font-weight: 500;
    border: 2px solid var(--chip-color);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s var(--ease);
  }
  .template-chip:hover {
    background: color-mix(in srgb, var(--chip-color) 15%, transparent);
  }
  .template-chip--active {
    background: var(--chip-color);
    color: var(--text-on-brand);
  }

  /* ── Template panel ── */
  .template-panel {
    margin-bottom: 18px;
  }
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 14px 0 12px;
  }
  .template-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .template-item:last-child {
    border-bottom: none;
  }
  .template-item__color {
    width: 16px;
    height: 16px;
    border-radius: var(--r-sm);
    flex-shrink: 0;
  }
  .template-item__name {
    font-weight: 500;
    font-size: 14px;
    color: var(--text);
  }
  .template-item__times {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-right: auto;
    font-variant-numeric: tabular-nums;
  }

  .template-form {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-top: 12px;
  }
  .template-form__eyebrow {
    font-size: 13px;
    margin-bottom: 10px;
  }
  .palette-row {
    display: flex;
    gap: 8px;
    margin: 4px 0 14px;
    flex-wrap: wrap;
  }
  .palette-swatch {
    width: 24px;
    height: 24px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
    transition:
      transform 0.12s var(--ease),
      box-shadow 0.12s var(--ease);
  }
  .palette-swatch:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-sm);
  }

  /* ── Week card ── */
  .week-card {
    padding: 0;
    overflow: hidden;
  }
  .week-header {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .week-header .spacer {
    flex: 1;
  }
  .week-label {
    font-size: 15px;
  }
  .week-body {
    padding: 18px;
  }
  .state-msg {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .head-date {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text);
    margin-top: 2px;
  }

  /* ── Shift cell content (assignable / stack) ── */
  /* `.shift-cell` and `.shift-cell.off` come from the global app.css recipe.
     We only add interactive states + the inner stack here. */
  :global(.shift-cell.assignable) {
    cursor: pointer;
    transition: background 0.12s var(--ease);
    position: relative;
  }
  :global(.shift-cell.assignable:hover) {
    background: var(--bg-subtle);
  }
  .shift-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    align-items: center;
  }
  .cell-actual {
    display: block;
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    font-variant-numeric: tabular-nums;
  }
  .cell-actual.unplanned {
    color: var(--warn);
    font-style: normal;
  }

  /* Shift pill rendered as a button — reset native button chrome */
  :global(.shift-cell .shift-pill) {
    border: none;
    cursor: pointer;
    transition: opacity 0.12s var(--ease);
  }
  :global(.shift-cell .shift-pill:hover) {
    opacity: 0.78;
  }

  /* ── Template hint callout spacing ── */
  .template-hint {
    margin-bottom: 14px;
  }

  /* ── Modal context line ── */
  .modal-context {
    font-size: 14px;
    color: var(--text);
    margin: 0;
  }

  /* ── Form layout ── */
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .form-row {
    display: flex;
    gap: 12px;
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

  .muted {
    color: var(--text-muted);
    font-size: 13.5px;
  }
</style>
