<script lang="ts">
  import { run, preventDefault, self } from 'svelte/legacy';

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";

  // ── Typen ─────────────────────────────────────────────────────────────────
  type Status   = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";
  type TypeCode = "VACATION" | "OVERTIME_COMP" | "SPECIAL" | "UNPAID" | "SICK" | "SICK_CHILD" | "EDUCATION" | "HOLIDAY" | "MATERNITY" | "PARENTAL";

  interface LeaveRequest {
    id:         string;
    employeeId: string;
    typeCode:   TypeCode;
    leaveType:  { name: string };
    employee:   { firstName: string; lastName: string; employeeNumber?: string };
    startDate:  string;
    endDate:    string;
    days:       number;
    halfDay:    boolean;
    status:     Status;
    note:       string | null;
    reviewNote: string | null;
    createdAt:  string;
    attestPresent:    boolean;
    attestValidFrom:  string | null;
    attestValidTo:    string | null;
  }

  interface OverlapEntry {
    id:           string;
    employeeName: string;
    typeName:     string;
    startDate:    string;
    endDate:      string;
    status:       Status;
  }

  // ── Konstanten ────────────────────────────────────────────────────────────
  const TYPE_OPTIONS: { code: TypeCode; label: string }[] = [
    { code: "VACATION",      label: "Urlaub" },
    { code: "OVERTIME_COMP", label: "Überstundenausgleich" },
    { code: "SPECIAL",       label: "Sonderurlaub" },
    { code: "EDUCATION",     label: "Bildungsurlaub" },
    { code: "SICK",          label: "Krankmeldung" },
    { code: "SICK_CHILD",    label: "Kinderkrank" },
    { code: "UNPAID",        label: "Unbezahlter Urlaub" },
    { code: "MATERNITY",     label: "Mutterschutz" },
    { code: "PARENTAL",      label: "Elternzeit" },
  ];

  function typeName(code: TypeCode): string {
    return TYPE_OPTIONS.find(t => t.code === code)?.label ?? code;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const isManager = ["ADMIN", "MANAGER"].includes($authStore.user?.role ?? "");

  // ── State ─────────────────────────────────────────────────────────────────
  let myRequests:      LeaveRequest[] = $state([]);
  let pendingRequests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error   = $state("");

  // Formular
  let showForm       = $state(false);
  let editingRequest: LeaveRequest | null = $state(null);  // gesetztes Objekt = Bearbeitungsmodus
  let formType:    TypeCode = $state("VACATION");
  let formStart   = $state("");
  let formEnd     = $state("");
  let formHalfDay = $state(false);
  let formNote    = $state("");
  let formSaving  = $state(false);
  let formError   = $state("");

  // Überstunden- / Urlaubskontostand
  let overtimeBalance:  number | null = $state(null);
  let vacationBalance = $state<{ total: number; used: number; carryOver: number; carryOverDeadline: string | null } | null>(null);

  // Stunden- und Tage-Vorschau (vom Server berechnet, Feiertage berücksichtigt)
  let hoursPreview:       number | null = $state(null);
  let serverDays:         number | null = $state(null);   // Feiertags-bereinigte Tage vom Server
  let hoursPreviewLoading = $state(false);
  let hoursPreviewTimer:  ReturnType<typeof setTimeout> | null = null;


  // Parallele Abwesenheiten im Formular
  let overlapEntries: OverlapEntry[] = $state([]);
  let overlapLoading  = $state(false);
  let overlapTimer:   ReturnType<typeof setTimeout> | null = null;

  // Review-Modal
  let reviewModal:  LeaveRequest | null = $state(null);
  let reviewOverlap: OverlapEntry[] = $state([]);
  let reviewNote    = $state("");
  let reviewSaving  = $state(false);
  let reviewError   = $state("");

  // Attest-State (im Review-Modal und Standalone)
  let reviewAttestPresent  = $state(false);
  let reviewAttestFrom     = $state("");
  let reviewAttestTo       = $state("");

  // Attest-Modal (für bereits genehmigte Krankmeldungen)
  let attestModal:    LeaveRequest | null = $state(null);
  let attestPresent   = $state(false);
  let attestFrom      = $state("");
  let attestTo        = $state("");
  let attestSaving    = $state(false);
  let attestError     = $state("");

  const SICK_CODES: TypeCode[] = ["SICK", "SICK_CHILD"];

  // ── Kalender ──────────────────────────────────────────────────────────────
  interface CalEntry {
    id:        string;
    isOwn:     boolean;
    firstName: string;
    lastName:  string;
    typeCode:  TypeCode | null;
    typeName:  string | null;
    startDate: string;
    endDate:   string;
    halfDay:   boolean;
    status:    Status;
    isHoliday: boolean;
  }

  type View = "calendar" | "list";
  let view: View = $state("calendar");

  const now = new Date();
  let calYear  = $state(now.getFullYear());
  let calMonth = $state(now.getMonth() + 1); // 1-12

  let calEntries: CalEntry[] = $state([]);
  let calLoading = $state(false);


  function buildCalMap(entries: CalEntry[]): Map<string, CalEntry[]> {
    const map = new Map<string, CalEntry[]>();
    for (const e of entries) {
      const cur = new Date(e.startDate);
      const end = new Date(e.endDate);
      while (cur <= end) {
        const k = cur.toISOString().split("T")[0];
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(e);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }

  interface CalDay {
    date:     Date;
    dateStr:  string;
    dayNum:   number;
    isCurrentMonth: boolean;
    isToday:  boolean;
    isWeekend: boolean;
  }

  function buildCalDays(y: number, m: number): CalDay[] {
    const days: CalDay[] = [];
    const first = new Date(y, m - 1, 1);
    // Woche beginnt Montag: 0=Mo..6=So
    let startDow = first.getDay(); // 0=So
    startDow = startDow === 0 ? 6 : startDow - 1;

    const todayStr = new Date().toISOString().split("T")[0];

    // Vortage aus Vormonat
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(y, m - 1, -i);
      days.push(mkCalDay(d, false, todayStr));
    }
    // Aktueller Monat
    const lastDay = new Date(y, m, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      days.push(mkCalDay(new Date(y, m - 1, d), true, todayStr));
    }
    // Folgetage bis 42 Zellen
    while (days.length < 42) {
      const d = new Date(y, m, days.length - lastDay - startDow + 1);
      days.push(mkCalDay(d, false, todayStr));
    }
    return days;
  }

  function mkCalDay(d: Date, isCurrentMonth: boolean, todayStr: string): CalDay {
    const dateStr = d.toISOString().split("T")[0];
    const dow = d.getDay();
    return {
      date: d, dateStr, dayNum: d.getDate(),
      isCurrentMonth,
      isToday:   dateStr === todayStr,
      isWeekend: dow === 0 || dow === 6,
    };
  }

  async function loadCalendar() {
    calLoading = true;
    try {
      calEntries = await api.get<CalEntry[]>(`/leave/calendar?year=${calYear}&month=${calMonth}`);
    } catch { calEntries = []; }
    finally { calLoading = false; }
  }

  function prevMonth() {
    if (calMonth === 1) { calMonth = 12; calYear--; }
    else calMonth--;
    loadCalendar();
  }
  function nextMonth() {
    if (calMonth === 12) { calMonth = 1; calYear++; }
    else calMonth++;
    loadCalendar();
  }

  const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni",
    "Juli","August","September","Oktober","November","Dezember"];

  // Typ → Hintergrundfarbe (approved=satt, pending=heller)
  function typeColor(code: TypeCode | null, status: Status, isOwn: boolean): string {
    if (!isOwn || !code) return status === "APPROVED" ? "#9e9e9e" : "#bdbdbd";
    const colors: Record<TypeCode, string> = {
      VACATION:      "#4caf50",
      OVERTIME_COMP: "#9c27b0",
      SPECIAL:       "#2196f3",
      EDUCATION:     "#00bcd4",
      SICK:          "#f44336",
      SICK_CHILD:    "#ff9800",
      UNPAID:        "#795548",
      HOLIDAY:       "#f59e0b",
    };
    const base = colors[code] ?? "#607d8b";
    return status === "APPROVED" ? base : base + "88";
  }


  // ── Laden ─────────────────────────────────────────────────────────────────
  onMount(() => { loadData(); loadCalendar(); loadVacationSummary(); });

  async function loadData() {
    loading = true; error = "";
    try {
      const year = new Date().getFullYear();
      const [mine, all] = await Promise.all([
        api.get<LeaveRequest[]>(`/leave/requests?year=${year}`),
        isManager
          ? api.get<LeaveRequest[]>(`/leave/requests?status=PENDING`)
          : Promise.resolve([] as LeaveRequest[]),
      ]);
      myRequests      = mine;
      // Manager-Liste: offene Anträge die ggf. auch eigene sind (dedupliziert)
      pendingRequests = all.filter(r => !mine.find(m => m.id === r.id));
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  async function loadVacationSummary() {
    const userId = $authStore.user?.employeeId;
    if (!userId) return;
    try {
      const year = new Date().getFullYear();
      const entitlements = await api.get<Array<{
        typeCode: string;
        leaveType: { name: string };
        totalDays: number; usedDays: number; carriedOverDays: number;
        effectiveCarryOverDays: number; carryOverDeadline: string | null;
      }>>(`/leave/entitlements/${userId}?year=${year}`);
      const vac = entitlements.find(e => e.typeCode === "VACATION");
      vacationBalance = vac
        ? {
            total:             Number(vac.totalDays),
            used:              Number(vac.usedDays),
            carryOver:         Number(vac.effectiveCarryOverDays ?? vac.carriedOverDays),
            carryOverDeadline: vac.carryOverDeadline,
          }
        : null;
    } catch { /* silent */ }
  }

  // ── Overlap laden ─────────────────────────────────────────────────────────
  function scheduleOverlapLoad() {
    if (overlapTimer) clearTimeout(overlapTimer);
    if (!formStart || !formEnd || formStart > formEnd) { overlapEntries = []; return; }
    overlapTimer = setTimeout(doLoadOverlap, 300);
  }

  async function doLoadOverlap(start = formStart, end = formEnd) {
    if (!start || !end || start > end) return;
    overlapLoading = true;
    try {
      overlapEntries = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${start}&endDate=${end}`
      );
    } catch { overlapEntries = []; }
    finally { overlapLoading = false; }
  }


  function scheduleHoursPreview() {
    if (hoursPreviewTimer) clearTimeout(hoursPreviewTimer);
    if (!formStart || !formEnd || formStart > formEnd) {
      hoursPreview = null; serverDays = null; return;
    }
    hoursPreviewTimer = setTimeout(loadHoursPreview, 300);
  }

  async function loadHoursPreview() {
    if (!formStart || !formEnd) return;
    hoursPreviewLoading = true;
    try {
      const r = await api.get<{ hours: number; days: number }>(
        `/leave/hours-preview?startDate=${formStart}&endDate=${formEnd}&halfDay=${formHalfDay}`
      );
      hoursPreview = r.hours;
      serverDays   = r.days;
    } catch { hoursPreview = null; serverDays = null; }
    finally { hoursPreviewLoading = false; }
  }


  async function loadBalanceForType(type: TypeCode) {
    if (type === "OVERTIME_COMP") {
      try {
        const r = await api.get<{ balanceHours: number }>("/leave/overtime-balance");
        overtimeBalance = r.balanceHours;
      } catch { overtimeBalance = null; }
    } else if (type === "VACATION") {
      try {
        const year = new Date().getFullYear();
        const userId = $authStore.user?.employeeId;
        if (!userId) return;
        const entitlements = await api.get<Array<{
          typeCode: string;
          leaveType: { name: string };
          totalDays: number; usedDays: number; carriedOverDays: number;
          effectiveCarryOverDays: number; carryOverDeadline: string | null;
        }>>(`/leave/entitlements/${userId}?year=${year}`);
        const vac = entitlements.find(e => e.typeCode === "VACATION");
        vacationBalance = vac
          ? {
              total:      Number(vac.totalDays),
              used:       Number(vac.usedDays),
              carryOver:  Number(vac.effectiveCarryOverDays ?? vac.carriedOverDays),
              carryOverDeadline: vac.carryOverDeadline,
            }
          : null;
      } catch { vacationBalance = null; }
    }
  }

  // ── Formular zurücksetzen ─────────────────────────────────────────────────
  function resetForm() {
    showForm = false; editingRequest = null;
    formType = "VACATION"; formStart = formEnd = formNote = ""; formHalfDay = false;
    overlapEntries = []; hoursPreview = null; serverDays = null;
  }

  // ── Antrag einreichen / bearbeiten ────────────────────────────────────────
  async function submitRequest() {
    formSaving = true; formError = "";
    try {
      if (editingRequest) {
        await api.patch(`/leave/requests/${editingRequest.id}`, {
          startDate: formStart,
          endDate:   formEnd,
          halfDay:   formHalfDay,
          note:      formNote || null,
        });
      } else {
        await api.post("/leave/requests", {
          type:      formType,
          startDate: formStart,
          endDate:   formEnd,
          halfDay:   formHalfDay,
          note:      formNote || null,
        });
      }
      resetForm();
      await Promise.all([loadData(), loadCalendar(), loadVacationSummary()]);
    } catch (e: unknown) {
      formError = e instanceof Error ? e.message : "Fehler";
    } finally { formSaving = false; }
  }

  // ── Antrag zurückziehen / Stornierung beantragen ──────────────────────────
  async function cancelRequest(id: string) {
    try {
      await api.delete(`/leave/requests/${id}`);
      await Promise.all([loadData(), loadCalendar(), loadVacationSummary()]);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler";
    }
  }

  // ── Antrag bearbeiten (Formular öffnen) ───────────────────────────────────
  function openEditForm(req: LeaveRequest) {
    editingRequest = req;
    formType    = req.typeCode as TypeCode;
    formStart   = req.startDate;
    formEnd     = req.endDate;
    formHalfDay = req.halfDay;
    formNote    = req.note ?? "";
    showForm    = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Review-Modal öffnen ───────────────────────────────────────────────────
  async function openReview(req: LeaveRequest) {
    reviewModal = req; reviewNote = ""; reviewError = ""; reviewOverlap = [];
    // Attest-Felder vorbelegen
    reviewAttestPresent = req.attestPresent ?? false;
    reviewAttestFrom    = req.attestValidFrom ?? "";
    reviewAttestTo      = req.attestValidTo   ?? "";
    try {
      reviewOverlap = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${req.startDate}&endDate=${req.endDate}`
      );
    } catch { /* ignore */ }
  }

  function closeReview() { reviewModal = null; }

  async function submitReview(status: "APPROVED" | "REJECTED") {
    if (!reviewModal) return;
    reviewSaving = true; reviewError = "";
    try {
      await api.patch(`/leave/requests/${reviewModal.id}/review`, {
        status, reviewNote: reviewNote || null,
      });
      // Attest für Krankmeldungen gleichzeitig speichern
      if (SICK_CODES.includes(reviewModal.typeCode)) {
        await api.patch(`/leave/requests/${reviewModal.id}/attest`, {
          attestPresent:   reviewAttestPresent,
          attestValidFrom: reviewAttestPresent && reviewAttestFrom ? reviewAttestFrom : null,
          attestValidTo:   reviewAttestPresent && reviewAttestTo   ? reviewAttestTo   : null,
        });
      }
      reviewModal = null;
      await Promise.all([loadData(), loadCalendar(), loadVacationSummary()]);
    } catch (e: unknown) {
      reviewError = e instanceof Error ? e.message : "Fehler";
    } finally { reviewSaving = false; }
  }

  // ── Attest-Modal (für bereits genehmigte Krankmeldungen) ─────────────────
  function openAttestModal(req: LeaveRequest) {
    attestModal   = req;
    attestPresent = req.attestPresent ?? false;
    attestFrom    = req.attestValidFrom ?? "";
    attestTo      = req.attestValidTo   ?? "";
    attestError   = "";
  }

  function closeAttestModal() { attestModal = null; }

  async function saveAttest() {
    if (!attestModal) return;
    attestSaving = true; attestError = "";
    try {
      await api.patch(`/leave/requests/${attestModal.id}/attest`, {
        attestPresent,
        attestValidFrom: attestPresent && attestFrom ? attestFrom : null,
        attestValidTo:   attestPresent && attestTo   ? attestTo   : null,
      });
      attestModal = null;
      await loadData();
    } catch (e: unknown) {
      attestError = e instanceof Error ? e.message : "Fehler";
    } finally { attestSaving = false; }
  }

  // ── Helfer ────────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function statusClass(s: Status) {
    return s === "APPROVED"               ? "badge-green"
         : s === "PENDING"                ? "badge-yellow"
         : s === "REJECTED"               ? "badge-red"
         : s === "CANCELLATION_REQUESTED" ? "badge-orange"
         : "badge-gray";
  }

  function statusLabel(s: Status) {
    return s === "APPROVED"               ? "Genehmigt"
         : s === "PENDING"                ? "Ausstehend"
         : s === "REJECTED"               ? "Abgelehnt"
         : s === "CANCELLATION_REQUESTED" ? "Stornierung beantragt"
         : "Zurückgezogen";
  }

  function daysLabel(days: number, halfDay: boolean): string {
    if (halfDay) return "½ Tag";
    return days === 1 ? "1 Tag" : `${days} Tage`;
  }

  function calcDays(start: string, end: string, halfDay: boolean): number {
    if (!start || !end || start > end) return 0;
    if (halfDay) return 0.5;
    let days = 0;
    const cur = new Date(start);
    const endD = new Date(end);
    while (cur <= endD) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) days++;
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function fmtH(h: number): string {
    const abs = Math.abs(h);
    const hh  = Math.floor(abs);
    const mm  = Math.round((abs - hh) * 60);
    return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
  }
  // Abgeleitete Werte
  let formDays     = $derived(calcDays(formStart, formEnd, formHalfDay));
  let effectiveDays = $derived(serverDays ?? formDays);        // Server-Wert bevorzugen (Feiertage)
  let hoursNeeded  = $derived(hoursPreview ?? formDays * 8);   // Fallback auf ×8 solange Preview lädt
  let vacRemaining = $derived(vacationBalance
      ? vacationBalance.total + vacationBalance.carryOver - vacationBalance.used
      : null);
  let vacAfter     = $derived(vacRemaining !== null ? vacRemaining - effectiveDays : null);
  // Abgeleiteter Kalender: Map<dateStr, CalEntry[]>
  let calMap = $derived(buildCalMap(calEntries));
  let calDays = $derived(buildCalDays(calYear, calMonth));
  // ── Urlaubszusammenfassung (über dem Kalender) ────────────────────────────
  let pendingVacDays = $derived(myRequests
    .filter(r => r.typeCode === "VACATION" && r.status === "PENDING")
    .reduce((sum, r) => sum + Number(r.days), 0));
  let vacSummaryTotal     = $derived(vacationBalance?.total ?? 0);
  let vacSummaryCarryOver          = $derived(vacationBalance?.carryOver ?? 0);
  let vacSummaryUsed               = $derived(vacationBalance?.used ?? 0);
  let vacSummaryPlanned            = $derived(pendingVacDays);
  let vacSummaryCarryOverRemaining = $derived(Math.max(0, vacSummaryCarryOver - vacSummaryUsed));
  let vacSummaryLeft               = $derived(vacSummaryTotal + vacSummaryCarryOver - vacSummaryUsed - vacSummaryPlanned);
  let showVacSummary               = $derived(vacationBalance !== null);

  // Filters for list view
  let filterLeaveStatus = $state<Status | "">("");
  let filterLeaveType   = $state<TypeCode | "">("");
  let filteredMyRequests = $derived(myRequests.filter(req => {
    if (filterLeaveStatus && req.status !== filterLeaveStatus) return false;
    if (filterLeaveType   && req.typeCode !== filterLeaveType)  return false;
    return true;
  }));
  
  run(() => {
    if (showForm) { formStart; formEnd; scheduleOverlapLoad(); }
  });
  run(() => {
    if (showForm) { formStart; formEnd; formHalfDay; scheduleHoursPreview(); }
  });
  // Kontostände laden wenn Typ wechselt oder Formular öffnet
  run(() => {
    if (showForm) loadBalanceForType(formType);
  });
</script>

<svelte:head>
  <title>Abwesenheiten – Clokr</title>
</svelte:head>

<!-- ── Header ─────────────────────────────────────────────────────────────── -->
<div class="page-header-row page-header">
  <div>
    <h1>Abwesenheiten</h1>
    <p>Urlaub, Überstundenausgleich und weitere Abwesenheiten verwalten</p>
  </div>
  {#if !showForm}
    <button class="btn btn-primary" onclick={() => { editingRequest = null; showForm = true; }}>✚ Neuer Antrag</button>
  {/if}
</div>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<!-- ── View-Toggle ────────────────────────────────────────────────────────── -->
<div class="view-tabs">
  <button class="view-tab" class:view-tab--active={view === "calendar"} onclick={() => (view = "calendar")}>
    📅 Kalender
  </button>
  <button class="view-tab" class:view-tab--active={view === "list"} onclick={() => (view = "list")}>
    📋 Liste
  </button>
</div>

<!-- ── Neuer Antrag ────────────────────────────────────────────────────────── -->
{#if showForm}
  <div class="card card-body form-card">
    <div class="form-card-header">
      <h2>{editingRequest ? "Antrag bearbeiten" : "Neuer Abwesenheitsantrag"}</h2>
      <button class="btn-icon" onclick={resetForm} aria-label="Schließen">✕</button>
    </div>

    {#if formError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem">
        <span>⚠</span><span>{formError}</span>
      </div>
    {/if}

    <form onsubmit={preventDefault(submitRequest)} class="form-grid">
      <div class="form-group">
        <label class="form-label" for="f-type">Art der Abwesenheit</label>
        <select id="f-type" bind:value={formType} class="form-input" disabled={!!editingRequest}>
          {#each TYPE_OPTIONS as t}
            <option value={t.code}>{t.label}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label" for="f-start">Von</label>
        <input id="f-start" type="date" bind:value={formStart} required class="form-input" />
      </div>

      <div class="form-group">
        <label class="form-label" for="f-end">Bis</label>
        <input id="f-end" type="date" bind:value={formEnd} required min={formStart} class="form-input" />
      </div>

      <!-- Überstundensaldo-Info -->
      {#if formType === "OVERTIME_COMP" && overtimeBalance !== null}
        <div class="form-group form-group--full">
          <div class="balance-box">
            <div class="balance-row">
              <span class="balance-label">Guthaben</span>
              <span class="balance-value">{fmtH(overtimeBalance)}</span>
            </div>
            {#if effectiveDays > 0 || formHalfDay}
              <div class="balance-row">
                <span class="balance-label">
                  Wird genutzt ({daysLabel(effectiveDays, formHalfDay)})
                </span>
                <span class="balance-value balance-deduct">
                  {#if hoursPreviewLoading}
                    <span class="text-muted">…</span>
                  {:else}
                    − {fmtH(hoursNeeded)}
                  {/if}
                </span>
              </div>
              <div class="balance-divider"></div>
              <div class="balance-row">
                <span class="balance-label">Verbleibend</span>
                <span class="balance-value {overtimeBalance - hoursNeeded < 0 ? 'balance-warn' : ''}">
                  {#if hoursPreviewLoading}
                    <span class="text-muted">…</span>
                  {:else}
                    {fmtH(overtimeBalance - hoursNeeded)}
                  {/if}
                </span>
              </div>
              {#if !hoursPreviewLoading && overtimeBalance - hoursNeeded < 0}
                <p class="balance-hint-warn">⚠ Nicht genug Überstunden vorhanden</p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      <!-- Tage-Info (sofort sichtbar, kein Ladeindikator) -->
      {#if formStart && formEnd && formStart <= formEnd && (formDays > 0 || formHalfDay)}
        <div class="form-group form-group--full">
          <div class="days-info-bar">
            <span class="days-info-icon">📅</span>
            <span class="days-info-text">
              <strong>{daysLabel(effectiveDays, formHalfDay)}</strong>
              {#if hoursPreviewLoading}
                <span class="days-info-note">(Feiertage werden geprüft…)</span>
              {:else if serverDays !== null && serverDays !== formDays}
                <span class="days-info-note">(Feiertage berücksichtigt)</span>
              {/if}
            </span>
          </div>
        </div>
      {/if}

      <!-- Urlaubssaldo-Info -->
      {#if formType === "VACATION" && vacationBalance !== null}
        <div class="form-group form-group--full">
          <div class="balance-box">
            <div class="balance-row">
              <span class="balance-label">Jahresanspruch</span>
              <span class="balance-value">{vacationBalance.total} Tage</span>
            </div>
            {#if vacationBalance.carryOver > 0}
              <div class="balance-row">
                <span class="balance-label">
                  Resturlaub Vorjahr
                  {#if vacationBalance.carryOverDeadline}
                    <span class="balance-meta">(verfällt {fmtDate(vacationBalance.carryOverDeadline)})</span>
                  {/if}
                </span>
                <span class="balance-value">+ {vacationBalance.carryOver} Tage</span>
              </div>
            {/if}
            <div class="balance-row">
              <span class="balance-label">Genommen</span>
              <span class="balance-value">− {vacationBalance.used} Tage</span>
            </div>
            <div class="balance-row">
              <span class="balance-label">Verfügbar</span>
              <span class="balance-value">{vacRemaining} Tage</span>
            </div>
            {#if effectiveDays > 0 || formHalfDay}
              <div class="balance-row">
                <span class="balance-label">
                  Wird genutzt
                  {#if hoursPreviewLoading}
                    <span class="text-muted">…</span>
                  {:else}
                    ({daysLabel(effectiveDays, formHalfDay)}{#if serverDays !== null && serverDays !== formDays}, Feiertage abgezogen{/if})
                  {/if}
                </span>
                <span class="balance-value balance-deduct">
                  {#if hoursPreviewLoading}
                    <span class="text-muted">…</span>
                  {:else}
                    − {effectiveDays} {effectiveDays === 1 ? "Tag" : "Tage"}
                  {/if}
                </span>
              </div>
              <div class="balance-divider"></div>
              <div class="balance-row">
                <span class="balance-label">Verbleibend</span>
                <span class="balance-value {(vacAfter ?? 0) < 0 ? 'balance-warn' : ''}">
                  {#if hoursPreviewLoading}
                    <span class="text-muted">…</span>
                  {:else}
                    {vacAfter} {(vacAfter ?? 0) === 1 ? "Tag" : "Tage"}
                  {/if}
                </span>
              </div>
              {#if !hoursPreviewLoading && (vacAfter ?? 0) < 0}
                <p class="balance-hint-warn">⚠ Nicht genug Resturlaub vorhanden</p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      <div class="form-group form-group--full">
        <label class="form-label" for="f-note">Anmerkung (optional)</label>
        <input id="f-note" type="text" bind:value={formNote} class="form-input"
          placeholder="z.B. Hochzeit, Arzttermin …" />
      </div>

      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={formHalfDay} class="toggle-cb" />
          <span>Halber Tag</span>
        </label>
      </div>

      <!-- Parallele Abwesenheiten -->
      {#if formStart && formEnd && formStart <= formEnd}
        <div class="form-group form-group--full">
          <div class="overlap-box">
            <p class="overlap-title">
              Kolleg:innen im gleichen Zeitraum
              {#if overlapLoading}<span class="text-muted"> laden…</span>{/if}
            </p>
            {#if !overlapLoading && overlapEntries.filter(o => o.status === "APPROVED").length === 0}
              <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
            {:else}
              <div class="overlap-list">
                {#each overlapEntries.filter(o => o.status === "APPROVED") as o}
                  <div class="overlap-row">
                    <span class="overlap-name">{o.employeeName}</span>
                    <span class="overlap-type">abwesend</span>
                    <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="form-actions form-group--full">
        <button type="submit" class="btn btn-primary" disabled={formSaving}>
          {formSaving ? "Speichern…" : editingRequest ? "Änderungen speichern" : "Antrag einreichen"}
        </button>
        <button type="button" class="btn btn-ghost" onclick={resetForm}>
          Abbrechen
        </button>
      </div>
    </form>
  </div>
{/if}

<!-- ── Kalender-Ansicht ───────────────────────────────────────────────────── -->
{#if view === "calendar"}

  <!-- Urlaubsübersicht -->
  {#if showVacSummary}
    <div class="vac-summary">
      <div class="vac-summary-item">
        <span class="vac-summary-label">Jahresanspruch</span>
        <span class="vac-summary-value">{vacSummaryTotal} Tage</span>
      </div>
      {#if vacSummaryCarryOver > 0}
        <div class="vac-summary-item">
          <span class="vac-summary-label">Resturlaub</span>
          <span class="vac-summary-value {vacSummaryCarryOverRemaining === 0 ? '' : 'vac-summary-carry'}">
            {vacSummaryCarryOverRemaining === 0 ? '0' : '+' + vacSummaryCarryOverRemaining} Tage
          </span>
        </div>
      {/if}
      <div class="vac-summary-item">
        <span class="vac-summary-label">Genommen</span>
        <span class="vac-summary-value">{vacSummaryUsed} Tage</span>
      </div>
      {#if vacSummaryPlanned > 0}
        <div class="vac-summary-item">
          <span class="vac-summary-label">Geplant</span>
          <span class="vac-summary-value vac-summary-planned">{vacSummaryPlanned} Tage</span>
        </div>
      {/if}
      <div class="vac-summary-divider"></div>
      <div class="vac-summary-item vac-summary-item--highlight">
        <span class="vac-summary-label">Verbleibend</span>
        <span class="vac-summary-value {vacSummaryLeft < 0 ? 'vac-summary-warn' : 'vac-summary-left'}">{vacSummaryLeft} Tage</span>
      </div>
    </div>
  {/if}

  <div class="cal-section card">
    <!-- Navigation -->
    <div class="cal-nav">
      <button class="nav-btn" onclick={prevMonth} title="Vorheriger Monat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span class="cal-nav-title">{MONTH_NAMES[calMonth - 1]} {calYear}</span>
      <button class="nav-btn" onclick={nextMonth} title="Nächster Monat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>

    <!-- Wochentag-Header -->
    <div class="cal-grid cal-header-row">
      {#each ["Mo","Di","Mi","Do","Fr","Sa","So"] as wd}
        <div class="cal-dow">{wd}</div>
      {/each}
    </div>

    <!-- Tage -->
    <div class="cal-grid {calLoading ? 'cal-loading' : ''}">
      {#each calDays as day}
        {@const entries    = calMap.get(day.dateStr) ?? []}
        {@const holidays   = entries.filter(e => e.isHoliday)}
        {@const absences   = entries.filter(e => !e.isHoliday)}
        {@const isHoliday  = holidays.length > 0}
        {@const hasEntries = absences.filter(e => e.isOwn || isManager || e.status === "APPROVED").length > 0}
        <div class="cal-cell"
          class:cal-other={!day.isCurrentMonth && !hasEntries && !day.isWeekend}
          class:cal-today={day.isToday}
          class:cal-weekend={day.isWeekend}
          class:cal-holiday={isHoliday && day.isCurrentMonth}>
          <span class="cal-day-num">{day.dayNum}</span>
          {#if isHoliday && day.isCurrentMonth}
            <div class="cal-holiday-label" title={holidays[0].typeName ?? ""}>
              🎌 {holidays[0].firstName}
            </div>
          {/if}
          <div class="cal-chips">
            {#each absences.filter(e => e.isOwn || isManager || e.status === "APPROVED") as e}
              <div
                class="cal-chip"
                class:cal-chip--pending={e.status === "PENDING" || e.status === "CANCELLATION_REQUESTED"}
                class:cal-chip--own={e.isOwn}
                style="background:{typeColor(e.typeCode, e.status, e.isOwn || isManager)}"
                title="{e.firstName} {e.lastName}{(e.isOwn || isManager) && e.typeName ? ' · ' + e.typeName : ''}{e.status === 'PENDING' ? ' (ausstehend)' : ''}"
              >
                <span class="cal-chip-name">{e.firstName}</span>
                {#if (e.isOwn || isManager) && e.typeName}
                  <span class="cal-chip-type">{e.typeName}</span>
                {:else}
                  <span class="cal-chip-type">abwesend</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    <!-- Legende -->
    <div class="cal-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#4caf50"></span>Urlaub</span>
      <span class="legend-item"><span class="legend-dot" style="background:#9c27b0"></span>ÜSt-Ausgleich</span>
      <span class="legend-item"><span class="legend-dot" style="background:#f44336"></span>Krank</span>
      <span class="legend-item"><span class="legend-dot" style="background:#ff9800"></span>Kinderkrank</span>
      <span class="legend-item"><span class="legend-dot" style="background:#2196f3"></span>Sonderurlaub</span>
      <span class="legend-item"><span class="legend-dot" style="background:#00bcd4"></span>Bildungsurlaub</span>
      <span class="legend-item"><span class="legend-dot" style="background:#9e9e9e"></span>Abwesend</span>
      <span class="legend-item"><span class="legend-holiday-dot"></span>Feiertag</span>
      <span class="legend-item legend-pending">gestrichelt = ausstehend</span>
    </div>
  </div>
{/if}

<!-- ── Listen-Ansicht ────────────────────────────────────────────────────── -->
{#if view === "list"}

<!-- ── Manager: Offene Anträge ─────────────────────────────────────────────── -->
{#if isManager && !loading && pendingRequests.length > 0}
  <div class="section-header">
    <h2>Offene Anträge</h2>
    <span class="badge badge-yellow">{pendingRequests.length}</span>
  </div>

  <div class="pending-list">
    {#each pendingRequests as req}
      <div class="pending-card card">
        <div class="pending-info">
          <span class="pending-name">{req.employee.firstName} {req.employee.lastName}</span>
          {#if req.status === "CANCELLATION_REQUESTED"}
            <span class="badge badge-orange" style="font-size:0.75rem">Stornierung beantragt</span>
          {:else}
            <span class="pending-type">{typeName(req.typeCode)}</span>
          {/if}
          <span class="pending-dates">{fmtDate(req.startDate)} – {fmtDate(req.endDate)}</span>
          <span class="pending-days text-muted">{daysLabel(Number(req.days), req.halfDay)}</span>
          {#if req.note}
            <span class="pending-note text-muted">„{req.note}"</span>
          {/if}
        </div>
        <button class="btn btn-sm btn-ghost" onclick={() => openReview(req)}>
          {req.status === "CANCELLATION_REQUESTED" ? "Stornierung prüfen →" : "Prüfen →"}
        </button>
      </div>
    {/each}
  </div>
{/if}

<!-- ── Anträge-Tabelle ─────────────────────────────────────────────────────── -->
<div class="section-header" style="margin-top:{(isManager && pendingRequests.length > 0) ? '1rem' : '0'}">
  <h2>{isManager ? "Alle Anträge" : "Meine Anträge"}</h2>
</div>

{#if loading}
  <div class="card card-body" style="height:180px"></div>
{:else if myRequests.length === 0}
  <div class="empty-state card card-body">
    <span class="empty-icon">🏖️</span>
    <h3>Noch keine Anträge</h3>
    <p class="text-muted">Erstelle deinen ersten Abwesenheitsantrag.</p>
  </div>
{:else}
  <div class="filter-bar">
    <select class="form-input filter-select" bind:value={filterLeaveStatus} aria-label="Nach Status filtern">
      <option value="">Alle Status</option>
      <option value="PENDING">Ausstehend</option>
      <option value="APPROVED">Genehmigt</option>
      <option value="REJECTED">Abgelehnt</option>
      <option value="CANCELLED">Storniert</option>
      <option value="CANCELLATION_REQUESTED">Stornierung beantragt</option>
    </select>
    <select class="form-input filter-select" bind:value={filterLeaveType} aria-label="Nach Art filtern">
      <option value="">Alle Arten</option>
      {#each TYPE_OPTIONS as t}
        <option value={t.code}>{t.label}</option>
      {/each}
    </select>
    <span class="filter-count">{filteredMyRequests.length} von {myRequests.length}</span>
  </div>

  <div class="table-wrapper">
    <table class="data-table">
      <thead>
        <tr>
          {#if isManager}<th>Mitarbeiter</th>{/if}
          <th>Art</th>
          <th>Von</th>
          <th>Bis</th>
          <th class="text-center">Umfang</th>
          <th>Status</th>
          <th>Anmerkung</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredMyRequests as req}
          {@const isOwn = req.employeeId === $authStore.user?.employeeId}
          <tr>
            {#if isManager}
              <td class="font-medium">{req.employee.firstName} {req.employee.lastName}</td>
            {/if}
            <td>{typeName(req.typeCode)}</td>
            <td class="font-mono">{fmtDate(req.startDate)}</td>
            <td class="font-mono">{fmtDate(req.endDate)}</td>
            <td class="text-center">{daysLabel(Number(req.days), req.halfDay)}</td>
            <td>
              <span class="badge {statusClass(req.status)}">{statusLabel(req.status)}</span>
              {#if SICK_CODES.includes(req.typeCode) && req.status === "APPROVED"}
                <span class="badge {req.attestPresent ? 'badge-green' : 'badge-gray'}" style="margin-left:0.25rem;font-size:0.7rem">
                  {req.attestPresent ? "Attest" : "Kein Attest"}
                </span>
              {/if}
            </td>
            <td class="note-cell text-muted">
              {#if req.status === "REJECTED" && req.reviewNote}
                <span class="text-red" title={req.reviewNote}>⚠ {req.reviewNote}</span>
              {:else}
                {req.note ?? "—"}
              {/if}
            </td>
            <td class="action-cell">
              {#if isOwn && req.status === "PENDING"}
                <button class="btn btn-sm btn-ghost" onclick={() => openEditForm(req)}>Bearbeiten</button>
                <button class="btn btn-sm btn-ghost text-red" onclick={() => cancelRequest(req.id)}>Zurückziehen</button>
              {/if}
              {#if isOwn && req.status === "APPROVED"}
                <button class="btn btn-sm btn-ghost text-red" onclick={() => cancelRequest(req.id)}>Stornieren</button>
              {/if}
              {#if isManager && SICK_CODES.includes(req.typeCode) && (req.status === "APPROVED" || req.status === "PENDING")}
                <button class="btn btn-sm btn-ghost" onclick={() => openAttestModal(req)}>Attest</button>
              {/if}
              {#if isManager && (req.status === "PENDING" || req.status === "CANCELLATION_REQUESTED")}
                <button class="btn btn-sm btn-ghost" onclick={() => openReview(req)}>
                  {req.status === "CANCELLATION_REQUESTED" ? "Stornierung prüfen" : "Prüfen"}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{/if}<!-- Ende Liste -->

<!-- ── Review-Modal ─────────────────────────────────────────────────────────── -->
{#if reviewModal}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={self(closeReview)} role="dialog" aria-modal="true">
    <div class="modal-card card">

      <div class="modal-header">
        <h2>{reviewModal.status === "CANCELLATION_REQUESTED" ? "Stornierungsantrag prüfen" : "Antrag prüfen"}</h2>
        <button class="btn-icon" onclick={closeReview} aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body">
        <!-- Antrag-Details -->
        <div class="review-grid">
          <div class="review-field">
            <span class="review-label">Mitarbeiter</span>
            <span class="review-value">{reviewModal.employee.firstName} {reviewModal.employee.lastName}</span>
          </div>
          <div class="review-field">
            <span class="review-label">Art</span>
            <span class="review-value">{typeName(reviewModal.typeCode)}</span>
          </div>
          <div class="review-field">
            <span class="review-label">Zeitraum</span>
            <span class="review-value font-mono">{fmtDate(reviewModal.startDate)} – {fmtDate(reviewModal.endDate)}</span>
          </div>
          <div class="review-field">
            <span class="review-label">Umfang</span>
            <span class="review-value">{daysLabel(Number(reviewModal.days), reviewModal.halfDay)}</span>
          </div>
          {#if reviewModal.note}
            <div class="review-field review-field--full">
              <span class="review-label">Anmerkung Mitarbeiter</span>
              <span class="review-value">„{reviewModal.note}"</span>
            </div>
          {/if}
        </div>

        <!-- Parallele Abwesenheiten -->
        <div class="overlap-box" style="margin-top:1.25rem">
          <p class="overlap-title">Kolleg:innen im gleichen Zeitraum</p>
          {#if reviewOverlap.filter(o => o.status === "APPROVED").length === 0}
            <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
          {:else}
            <div class="overlap-list">
              {#each reviewOverlap.filter(o => o.status === "APPROVED") as o}
                <div class="overlap-row">
                  <span class="overlap-name">{o.employeeName}</span>
                  <span class="overlap-type">abwesend</span>
                  <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Attest (nur für Krankmeldungen) -->
        {#if SICK_CODES.includes(reviewModal.typeCode)}
          <div class="attest-box" style="margin-top:1.25rem">
            <p class="attest-title">Attest / Arbeitsunfähigkeitsbescheinigung</p>
            <label class="toggle-label">
              <input type="checkbox" bind:checked={reviewAttestPresent} class="toggle-cb" />
              <span>Attest liegt vor</span>
            </label>
            {#if reviewAttestPresent}
              <div class="attest-dates">
                <div class="form-group">
                  <label class="form-label" for="r-attest-from">Gültig von</label>
                  <input id="r-attest-from" type="date" bind:value={reviewAttestFrom} class="form-input" style="max-width:160px" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="r-attest-to">Gültig bis</label>
                  <input id="r-attest-to" type="date" bind:value={reviewAttestTo} class="form-input" style="max-width:160px" />
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Review-Notiz -->
        <div class="form-group" style="margin-top:1.25rem">
          <label class="form-label" for="review-note">Anmerkung (optional)</label>
          <input id="review-note" type="text" bind:value={reviewNote} class="form-input"
            placeholder="Grund für Ablehnung o.ä." />
        </div>

        {#if reviewError}
          <div class="alert alert-error" role="alert" style="margin-top:0.75rem">
            <span>⚠</span><span>{reviewError}</span>
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeReview} disabled={reviewSaving}>
          Abbrechen
        </button>
        {#if reviewModal.status === "CANCELLATION_REQUESTED"}
          <button class="btn btn-ghost" onclick={() => submitReview("REJECTED")} disabled={reviewSaving}>
            {reviewSaving ? "…" : "Stornierung ablehnen"}
          </button>
          <button class="btn btn-danger" onclick={() => submitReview("APPROVED")} disabled={reviewSaving}>
            {reviewSaving ? "…" : "Stornierung genehmigen"}
          </button>
        {:else}
          <button class="btn btn-danger" onclick={() => submitReview("REJECTED")} disabled={reviewSaving}>
            {reviewSaving ? "…" : "Ablehnen"}
          </button>
          <button class="btn btn-primary" onclick={() => submitReview("APPROVED")} disabled={reviewSaving}>
            {reviewSaving ? "…" : "Genehmigen"}
          </button>
        {/if}
      </div>

    </div>
  </div>
{/if}

<!-- ── Attest-Modal ─────────────────────────────────────────────────────────── -->
{#if attestModal}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={self(closeAttestModal)} role="dialog" aria-modal="true">
    <div class="modal-card card">
      <div class="modal-header">
        <h2>Attest: {attestModal.employee.firstName} {attestModal.employee.lastName}</h2>
        <button class="btn-icon" onclick={closeAttestModal} aria-label="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <p class="text-muted" style="font-size:0.875rem;margin-bottom:1rem;">
          {fmtDate(attestModal.startDate)} – {fmtDate(attestModal.endDate)} · {typeName(attestModal.typeCode)}
        </p>
        <div class="attest-box">
          <label class="toggle-label">
            <input type="checkbox" bind:checked={attestPresent} class="toggle-cb" />
            <span>Attest liegt vor</span>
          </label>
          {#if attestPresent}
            <div class="attest-dates">
              <div class="form-group">
                <label class="form-label" for="a-from">Gültig von</label>
                <input id="a-from" type="date" bind:value={attestFrom} class="form-input" style="max-width:160px" />
              </div>
              <div class="form-group">
                <label class="form-label" for="a-to">Gültig bis</label>
                <input id="a-to" type="date" bind:value={attestTo} class="form-input" style="max-width:160px" />
              </div>
            </div>
          {/if}
        </div>
        {#if attestError}
          <div class="alert alert-error" role="alert" style="margin-top:0.75rem">
            <span>⚠</span><span>{attestError}</span>
          </div>
        {/if}
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeAttestModal} disabled={attestSaving}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveAttest} disabled={attestSaving}>
          {attestSaving ? "Speichern…" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Layout ───────────────────────────────────────────────────────── */
  .page-header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 0.875rem;
  }
  .section-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }

  /* ── Form Card ────────────────────────────────────────────────────── */
  .form-card { margin-bottom: 2rem; }
  .form-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.25rem;
  }
  .form-card-header h2 { font-size: 1.0625rem; font-weight: 600; margin: 0; }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .form-group--full { grid-column: 1 / -1; }

  .form-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding-top: 0.25rem;
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
  }
  .toggle-cb { width: 1rem; height: 1rem; accent-color: var(--brand); }

  /* ── Overlap ──────────────────────────────────────────────────────── */
  .overlap-box {
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 0.875rem 1rem;
  }
  .overlap-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    margin: 0 0 0.5rem;
  }
  .overlap-empty { font-size: 0.9375rem; margin: 0; }
  .overlap-list  { display: flex; flex-direction: column; gap: 0.5rem; }
  .overlap-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.9375rem;
  }
  .overlap-name  { font-weight: 600; }
  .overlap-type  { color: var(--color-text-muted); font-size: 0.875rem; }
  .overlap-dates { font-family: var(--font-mono); font-size: 0.875rem; margin-left: auto; }

  /* ── Attest ───────────────────────────────────────────────────────── */
  .attest-box {
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.875rem 1rem;
  }
  .attest-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.625rem;
  }
  .attest-dates {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
  }
  .toggle-cb { width: 16px; height: 16px; accent-color: var(--color-brand); }

  /* ── Pending Cards ────────────────────────────────────────────────── */
  .pending-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.5rem; }
  .pending-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
  }
  .pending-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  .pending-name  { font-weight: 600; white-space: nowrap; }
  .pending-type  { color: var(--brand); font-weight: 500; }
  .pending-dates { font-family: var(--font-mono); font-size: 0.9375rem; white-space: nowrap; }
  .pending-days  { font-size: 0.875rem; }
  .pending-note  { font-size: 0.875rem; font-style: italic; overflow: hidden; text-overflow: ellipsis; }

  /* ── Table ────────────────────────────────────────────────────────── */
  .text-center { text-align: center; }
  .btn-sm  { padding: 0.25rem 0.625rem; font-size: 0.8125rem; }
  .text-red { color: var(--color-red, #dc2626); }
  .note-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-cell { white-space: nowrap; display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; }

  /* ── Empty ────────────────────────────────────────────────────────── */
  .empty-state {
    text-align: center; padding: 3rem 2rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.625rem;
  }
  .empty-icon { font-size: 2.5rem; }
  .empty-state h3 { font-size: 1.0625rem; }

  /* ── Modal ────────────────────────────────────────────────────────── */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; padding: 1rem;
    backdrop-filter: blur(2px);
  }
  .modal-card {
    width: 100%; max-width: 560px;
    padding: 0; overflow: hidden;
    animation: modal-in 0.18s ease;
  }
  @keyframes modal-in {
    from { opacity: 0; transform: translateY(12px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1.25rem 1.5rem 1rem;
    border-bottom: 1px solid var(--gray-200);
  }
  .modal-header h2 { font-size: 1.0625rem; font-weight: 600; margin: 0; }
  .modal-body   { padding: 1.25rem 1.5rem; }
  .modal-footer {
    display: flex; justify-content: flex-end; gap: 0.625rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--gray-200);
    background: var(--gray-50, #f9fafb);
  }

  /* ── Review Grid ──────────────────────────────────────────────────── */
  .review-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem 1.5rem;
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  .review-field       { display: flex; flex-direction: column; gap: 0.125rem; }
  .review-field--full { grid-column: 1 / -1; }
  .review-label {
    font-size: 0.75rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .review-value { font-size: 0.9375rem; font-weight: 500; }

  /* ── Buttons ──────────────────────────────────────────────────────── */
  .btn-danger {
    background: var(--color-red, #dc2626);
    color: #fff; border: none; border-radius: 8px;
    padding: 0.5rem 1.25rem;
    font-size: 0.9375rem; font-weight: 600; cursor: pointer;
  }
  .btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }

  .btn-icon {
    background: none; border: none; cursor: pointer;
    padding: 0.25rem; border-radius: 4px;
    font-size: 1rem; color: var(--color-text-muted);
  }

  /* ── Balance Box ──────────────────────────────────────────────────── */
  .balance-box {
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    font-size: 0.9375rem;
  }
  .balance-label { color: var(--color-text-muted); }
  .balance-value { font-weight: 600; font-family: var(--font-mono); }
  .balance-meta  { font-size: 0.8125rem; font-weight: 400; color: var(--color-text-muted); margin-left: 0.25rem; }
  .balance-deduct { color: var(--color-text-muted); }
  .balance-warn   { color: var(--color-red, #dc2626); }
  .balance-divider {
    height: 1px;
    background: var(--gray-200);
    margin: 0.125rem 0;
  }
  .balance-hint-warn {
    font-size: 0.8125rem;
    color: var(--color-red, #dc2626);
    margin: 0.25rem 0 0;
  }

  /* ── View Tabs ────────────────────────────────────────────────────── */
  .view-tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1.5rem;
    border-bottom: 2px solid var(--gray-200);
  }
  .view-tab {
    background: none; border: none; cursor: pointer;
    padding: 0.625rem 1.25rem;
    font-size: 0.9375rem; font-weight: 500;
    color: var(--color-text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    border-radius: 4px 4px 0 0;
    transition: color 0.15s, border-color 0.15s;
  }
  .view-tab:hover     { color: var(--color-text); }
  .view-tab--active   { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }

  /* ── Urlaubsübersicht ─────────────────────────────────────────────── */
  .vac-summary {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 10px;
    padding: 0.75rem 1.25rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    gap: 0.25rem 0;
  }
  .vac-summary-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 80px;
    padding: 0.25rem 0.5rem;
    border-right: 1px solid var(--gray-200);
  }
  .vac-summary-item:last-child { border-right: none; }
  .vac-summary-divider {
    width: 1px;
    height: 36px;
    background: var(--gray-300, #d1d5db);
    margin: 0 0.5rem;
    align-self: center;
  }
  .vac-summary-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .vac-summary-value {
    font-size: 1.125rem;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-text);
    margin-top: 0.125rem;
  }
  .vac-summary-carry  { color: #2196f3; }
  .vac-summary-planned { color: #ff9800; }
  .vac-summary-left   { color: #4caf50; }
  .vac-summary-warn   { color: var(--color-red, #dc2626); }
  .vac-summary-item--highlight .vac-summary-label { color: var(--color-text); }

  /* ── Days-Info Bar ────────────────────────────────────────────────── */
  .days-info-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--brand-light, #eff6ff);
    border: 1px solid var(--brand-border, #bfdbfe);
    border-radius: 8px;
    padding: 0.5rem 0.875rem;
    font-size: 0.9375rem;
    color: var(--brand, #2563eb);
  }
  .days-info-icon   { font-size: 1rem; }
  .days-info-note   { font-size: 0.8125rem; opacity: 0.75; margin-left: 0.25rem; }
  .days-info-loading { color: var(--color-text-muted); font-size: 0.875rem; }

  /* ── Kalender ─────────────────────────────────────────────────────── */
  .cal-section { padding: 0; overflow: hidden; margin-bottom: 1rem; }

  .cal-nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.875rem 1.25rem;
    border-bottom: 1px solid var(--gray-100, #f3f4f6);
  }
  .nav-btn {
    background: none; border: 1.5px solid var(--gray-200, #e5e7eb);
    border-radius: 8px; padding: 0.375rem; cursor: pointer;
    display: flex; align-items: center; color: var(--color-text);
    transition: background 0.15s;
  }
  .nav-btn:hover { background: var(--gray-100, #f3f4f6); }
  .cal-nav-title { font-size: 1.0625rem; font-weight: 700; text-transform: capitalize; }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
  }
  .cal-header-row {
    border-bottom: 1.5px solid var(--gray-200, #e5e7eb);
    background: var(--gray-50, #f9fafb);
  }
  .cal-dow {
    padding: 0.4rem; text-align: center;
    font-size: 0.6875rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .cal-loading { opacity: 0.5; pointer-events: none; }

  .cal-cell {
    background: #fff;
    min-height: 90px;
    padding: 0.375rem 0.5rem 0.5rem;
    border-right: 1px solid var(--gray-100, #f3f4f6);
    border-bottom: 1px solid var(--gray-100, #f3f4f6);
    display: flex; flex-direction: column; gap: 0.25rem;
  }
  .cal-cell:nth-child(7n) { border-right: none; }

  .cal-other   { opacity: 0.3; cursor: default; background: var(--gray-50, #f9fafb) !important; }
  .cal-weekend { background: #f4f0fa; }
  .cal-today   { box-shadow: inset 0 0 0 2px var(--brand); }
  .cal-holiday { background: #ede7f6 !important; border-left: 3px solid #80377B; }

  .cal-day-num {
    font-size: 0.8rem; font-weight: 600;
    color: var(--color-text-muted); line-height: 1;
  }
  .cal-today .cal-day-num {
    background: var(--brand); color: white;
    width: 20px; height: 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.7rem;
  }

  .cal-holiday-label {
    font-size: 0.6875rem; color: #6b21a8; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    padding: 1px 2px;
  }

  .cal-chips { display: flex; flex-direction: column; gap: 2px; }
  .cal-chip {
    display: flex; align-items: baseline; gap: 0.25rem;
    padding: 2px 5px; border-radius: 4px;
    color: #fff; font-size: 0.75rem; line-height: 1.4;
    overflow: hidden; cursor: default;
  }
  .cal-chip--pending {
    outline: 1.5px dashed rgba(255,255,255,0.7);
    outline-offset: -2px; opacity: 0.85;
  }
  .cal-chip-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60px; }
  .cal-chip-type { font-size: 0.6875rem; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Legende */
  .cal-legend {
    display: flex; gap: 1rem; padding: 0.6rem 1rem;
    border-top: 1px solid var(--gray-100, #f3f4f6); flex-wrap: wrap;
  }
  .legend-item { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; color: var(--color-text-muted); }
  .legend-dot  { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; display: inline-block; }
  .legend-holiday-dot {
    width: 10px; height: 10px; background: #ede7f6;
    border: 1.5px solid #80377B; border-radius: 2px;
    flex-shrink: 0; display: inline-block;
  }
  .legend-pending { font-style: italic; }

  /* ── Responsive ───────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .form-grid     { grid-template-columns: 1fr 1fr; }
    .review-grid   { grid-template-columns: 1fr; }
    .pending-info  { gap: 0.5rem; }
    .overlap-dates { margin-left: 0; }
    .cal-chip-type { display: none; }
  }
  @media (max-width: 480px) {
    .form-grid { grid-template-columns: 1fr; }
  }
</style>
