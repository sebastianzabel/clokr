<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Modal from "$components/ui/Modal.svelte";

  // ── Types ───────────────────────────────────────────────────
  interface ShiftTemplate {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    color: string;
  }

  interface CoverageRule {
    id: string;
    templateId: string | null;
    dayOfWeek: number; // -1 = all days, 0..6 = Mo..So
    minStaff: number | string; // Decimal arrives as string from Prisma
    requiresNonSupervised: boolean;
  }

  interface StoreHourEntry {
    day: number; // 0..6 Mo..So
    open: string;
    close: string;
    closed?: boolean;
  }

  // Phase 48 — Pattern editor types
  interface PatternEmployee {
    id: string;
    firstName: string;
    lastName: string;
    workSchedules?: Array<{
      type: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
      weeklyHours: number | string | null;
    }>;
  }
  interface PatternRow {
    employeeId: string;
    dayOfWeek: number; // 0..6
    templateId: string | null;
  }
  interface ShiftWeekResponse {
    employees: PatternEmployee[];
  }

  const DAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const DAY_NAMES_LONG = [
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
    "Sonntag",
  ];

  // ── Role gate ───────────────────────────────────────────────
  let gated = $state(false);

  onMount(() => {
    const role = $authStore.user?.role;
    if (role !== "ADMIN") {
      gated = true;
      if (role === "MANAGER") {
        goto("/shifts");
      } else {
        goto("/dashboard");
      }
      return;
    }
    void loadAll();
  });

  // ── State ───────────────────────────────────────────────────
  let templates: ShiftTemplate[] = $state([]);
  let coverageRules: CoverageRule[] = $state([]);
  let storeHours: StoreHourEntry[] = $state([]);
  let shiftStoreHoursMode: "STRICT" | "DAY_ONLY" | "OFF" = $state("DAY_ONLY");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");

  // Template editor
  let tplModalOpen = $state(false);
  let tplName = $state("");
  let tplStart = $state("06:00");
  let tplEnd = $state("14:00");
  let tplColor = $state("");
  let tplError = $state("");
  let editingTplId: string | null = $state(null);

  // Coverage rule editor
  let ruleModalOpen = $state(false);
  let ruleEditingId: string | null = $state(null);
  let ruleTemplateId = $state(""); // "" = all templates
  let ruleDayOfWeek = $state<number>(-1);
  let ruleMinStaff = $state<number>(2);
  let ruleRequiresNonSupervised = $state(false);
  let ruleError = $state("");

  // Delete confirmations
  let tplDeleteConfirm = $state<{ open: boolean; id: string | null; name: string }>({
    open: false,
    id: null,
    name: "",
  });
  let ruleDeleteConfirm = $state<{ open: boolean; id: string | null }>({
    open: false,
    id: null,
  });

  // Store hours save state
  let storeHoursSaving = $state(false);
  let storeHoursMsg = $state("");

  // Phase 48 — Pattern editor state
  let shiftEmployees: PatternEmployee[] = $state([]);
  // matrix[employeeId][0..6] = templateId | null
  let patternMatrix: Record<string, Array<string | null>> = $state({});
  // mirror of initial server state for dirty detection
  let patternMatrixInitial: Record<string, Array<string | null>> = $state({});
  let patternsSaving = $state(false);
  let patternsMsg = $state("");

  // Palette for shift template colors (theme-independent)
  const SHIFT_PALETTE = [
    { token: "--shift-violet", label: "Violett" },
    { token: "--shift-blue", label: "Blau" },
    { token: "--shift-green", label: "Grün" },
    { token: "--shift-amber", label: "Bernstein" },
    { token: "--shift-rose", label: "Rose" },
    { token: "--shift-slate", label: "Schiefer" },
  ];

  function resolveShiftToken(name: string, fallback = ""): string {
    if (typeof window === "undefined") return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function pickPaletteColor(token: string) {
    tplColor = resolveShiftToken(token, tplColor);
  }

  // ── Load all config ─────────────────────────────────────────
  async function loadAll() {
    if (gated) return;
    loading = true;
    error = "";
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const [tpls, rules, work, week, patterns] = await Promise.all([
        api.get<ShiftTemplate[]>("/shifts/templates"),
        api.get<CoverageRule[]>("/shifts/coverage-rules"),
        api.get<{
          storeHours?: StoreHourEntry[];
          shiftStoreHoursMode?: "STRICT" | "DAY_ONLY" | "OFF";
        }>("/settings/work"),
        api.get<ShiftWeekResponse>(`/shifts/week?date=${todayIso}`),
        api.get<PatternRow[]>("/shift-patterns/tenant"),
      ]);
      templates = tpls;
      coverageRules = rules;
      storeHours = normalizeStoreHours(work.storeHours);
      shiftStoreHoursMode = work.shiftStoreHoursMode ?? "DAY_ONLY";

      // Phase 48 — Build pattern matrix from SHIFT_BASED employees + tenant patterns
      shiftEmployees = (week.employees ?? [])
        .filter((e) => e.workSchedules?.[0]?.type === "SHIFT_BASED")
        .sort((a, b) =>
          `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, "de"),
        );
      const matrix: Record<string, Array<string | null>> = {};
      for (const emp of shiftEmployees) matrix[emp.id] = Array(7).fill(null);
      for (const p of patterns) {
        if (matrix[p.employeeId] && p.dayOfWeek >= 0 && p.dayOfWeek <= 6) {
          matrix[p.employeeId][p.dayOfWeek] = p.templateId;
        }
      }
      patternMatrix = matrix;
      patternMatrixInitial = JSON.parse(JSON.stringify(matrix));
    } catch (e) {
      console.error(e);
      error = "Fehler beim Laden der Konfiguration.";
    } finally {
      loading = false;
    }
  }

  // Phase 48 — Pattern editor helpers
  function employeeFullName(e: PatternEmployee): string {
    return `${e.lastName}, ${e.firstName}`;
  }
  function isCellDirty(empId: string, dow: number): boolean {
    return (patternMatrix[empId]?.[dow] ?? null) !== (patternMatrixInitial[empId]?.[dow] ?? null);
  }
  function isRowDirty(empId: string): boolean {
    return [0, 1, 2, 3, 4, 5, 6].some((d) => isCellDirty(empId, d));
  }
  const dirtyEmployeeCount = $derived(
    shiftEmployees.filter((e) => isRowDirty(e.id)).length,
  );
  // Soll-Hint per Wochentag column: average weekly hours / 5 for Mo–Fr only.
  // Returns null for Sa/So (most stores closed) and when no clean signal is available.
  function sollHintForDow(dow: number): string | null {
    if (dow > 4) return null;
    if (shiftEmployees.length === 0) return null;
    const hrs = shiftEmployees
      .map((e) => Number(e.workSchedules?.[0]?.weeklyHours ?? NaN))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (hrs.length === 0) return null;
    const avg = hrs.reduce((s, n) => s + n, 0) / hrs.length;
    const perDay = avg / 5;
    return `Ø ${perDay.toFixed(1)}h`;
  }

  async function saveBulkPatterns() {
    const todayIso = new Date().toISOString().slice(0, 10);
    const dirtyEmps = shiftEmployees.filter((e) => isRowDirty(e.id));
    if (dirtyEmps.length === 0) return;
    patternsSaving = true;
    patternsMsg = "";
    const results = await Promise.allSettled(
      dirtyEmps.map((emp) => {
        const patterns = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
          dayOfWeek: dow,
          templateId: patternMatrix[emp.id]?.[dow] ?? null,
          validFrom: todayIso,
        }));
        return api.put(`/employees/${emp.id}/shift-patterns`, { patterns });
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    if (fail === 0) {
      toasts.success(`Schicht-Muster gespeichert (${ok} MA).`);
      patternMatrixInitial = JSON.parse(JSON.stringify(patternMatrix));
    } else if (ok === 0) {
      toasts.error(`Speichern fehlgeschlagen für alle ${fail} MA.`);
    } else {
      toasts.error(`Teilweise gespeichert: ${ok} OK, ${fail} Fehler. Bitte erneut versuchen.`);
    }
    patternsSaving = false;
    patternsMsg = fail === 0 ? "Gespeichert." : `${fail} Fehler.`;
    setTimeout(() => (patternsMsg = ""), 3000);
  }

  function normalizeStoreHours(raw: StoreHourEntry[] | undefined): StoreHourEntry[] {
    const fallback: StoreHourEntry[] = [
      { day: 0, open: "08:00", close: "20:00" },
      { day: 1, open: "08:00", close: "20:00" },
      { day: 2, open: "08:00", close: "20:00" },
      { day: 3, open: "08:00", close: "20:00" },
      { day: 4, open: "08:00", close: "20:00" },
      { day: 5, open: "08:00", close: "20:00" },
      { day: 6, open: "08:00", close: "20:00", closed: true },
    ];
    if (!raw || !Array.isArray(raw) || raw.length !== 7) return fallback;
    return [...raw].sort((a, b) => a.day - b.day);
  }

  // ── Templates ───────────────────────────────────────────────
  function openCreateTemplate() {
    editingTplId = null;
    tplName = "";
    tplStart = "06:00";
    tplEnd = "14:00";
    tplColor = resolveShiftToken("--shift-violet");
    tplError = "";
    tplModalOpen = true;
  }

  function openEditTemplate(tpl: ShiftTemplate) {
    editingTplId = tpl.id;
    tplName = tpl.name;
    tplStart = tpl.startTime;
    tplEnd = tpl.endTime;
    tplColor = tpl.color;
    tplError = "";
    tplModalOpen = true;
  }

  async function saveTemplate() {
    if (!tplName.trim() || !tplStart || !tplEnd) {
      tplError = "Name, Start- und Endzeit sind Pflichtfelder.";
      return;
    }
    saving = true;
    tplError = "";
    try {
      const payload = {
        name: tplName.trim(),
        startTime: tplStart,
        endTime: tplEnd,
        color: tplColor,
      };
      if (editingTplId) {
        await api.put(`/shifts/templates/${editingTplId}`, payload);
        toasts.success("Vorlage aktualisiert.");
      } else {
        await api.post("/shifts/templates", payload);
        toasts.success("Vorlage erstellt.");
      }
      tplModalOpen = false;
      editingTplId = null;
      await loadAll();
    } catch (e) {
      tplError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  function askDeleteTemplate(id: string, name: string) {
    tplDeleteConfirm = { open: true, id, name };
  }

  async function confirmDeleteTemplate() {
    if (!tplDeleteConfirm.id) return;
    try {
      await api.delete(`/shifts/templates/${tplDeleteConfirm.id}`);
      await loadAll();
      toasts.success("Vorlage gelöscht.");
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen.");
    }
  }

  // ── Coverage Rules ──────────────────────────────────────────
  function openCreateRule() {
    ruleEditingId = null;
    ruleTemplateId = "";
    ruleDayOfWeek = -1;
    ruleMinStaff = 2;
    ruleRequiresNonSupervised = false;
    ruleError = "";
    ruleModalOpen = true;
  }

  function openEditRule(rule: CoverageRule) {
    ruleEditingId = rule.id;
    ruleTemplateId = rule.templateId ?? "";
    ruleDayOfWeek = rule.dayOfWeek;
    ruleMinStaff = Number(rule.minStaff);
    ruleRequiresNonSupervised = rule.requiresNonSupervised;
    ruleError = "";
    ruleModalOpen = true;
  }

  async function saveRule() {
    if (ruleMinStaff < 0) {
      ruleError = "Min. Schicht-Gewicht muss >= 0 sein.";
      return;
    }
    saving = true;
    ruleError = "";
    try {
      const payload = {
        templateId: ruleTemplateId || null,
        dayOfWeek: ruleDayOfWeek,
        minStaff: ruleMinStaff,
        requiresNonSupervised: ruleRequiresNonSupervised,
      };
      if (ruleEditingId) {
        await api.put(`/shifts/coverage-rules/${ruleEditingId}`, payload);
      } else {
        await api.post("/shifts/coverage-rules", payload);
      }
      ruleModalOpen = false;
      await loadAll();
      toasts.success(ruleEditingId ? "Bedarfsregel aktualisiert." : "Bedarfsregel erstellt.");
    } catch (e) {
      ruleError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  function askDeleteRule(id: string) {
    ruleDeleteConfirm = { open: true, id };
  }

  async function confirmDeleteRule() {
    if (!ruleDeleteConfirm.id) return;
    try {
      await api.delete(`/shifts/coverage-rules/${ruleDeleteConfirm.id}`);
      await loadAll();
      toasts.success("Bedarfsregel gelöscht.");
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen.");
    }
  }

  function ruleTemplateName(rule: CoverageRule): string {
    if (!rule.templateId) return "Alle Vorlagen";
    return templates.find((t) => t.id === rule.templateId)?.name ?? "Unbekannte Vorlage";
  }

  function ruleDayLabel(rule: CoverageRule): string {
    if (rule.dayOfWeek === -1) return "Alle Tage";
    return DAY_NAMES_LONG[rule.dayOfWeek] ?? "—";
  }

  // ── Store hours ─────────────────────────────────────────────
  async function saveStoreHours() {
    storeHoursSaving = true;
    storeHoursMsg = "";
    try {
      await api.put("/settings/work", { storeHours, shiftStoreHoursMode });
      storeHoursMsg = "Gespeichert.";
      toasts.success("Ladenöffnungszeiten aktualisiert.");
    } catch (e) {
      storeHoursMsg = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
      toasts.error(storeHoursMsg);
    } finally {
      storeHoursSaving = false;
      setTimeout(() => (storeHoursMsg = ""), 2500);
    }
  }
</script>

<svelte:head>
  <title>Schicht-Konfiguration – Clokr</title>
</svelte:head>

<div class="page">
  <PageHead
    eyebrow="Administration"
    title="Schicht-Konfiguration"
    accent="Schicht"
    sub="Vorlagen, Bedarfsregeln und Ladenöffnungszeiten pflegen. Schichten zuweisen erfolgt in der Schichtplanung."
  />

  {#if error}
    <div class="callout error card-animate" role="alert">{error}</div>
  {/if}

  {#if loading}
    <div class="callout info card-animate">Lade Konfiguration …</div>
  {:else}
    <!-- ── Templates section ────────────────────────────────────── -->
    <Card animate>
      <CardHeader title="Schichtvorlagen" sub="Wiederkehrende Schichtmuster definieren" />

      {#if templates.length === 0}
        <p class="cfg-muted">Noch keine Vorlagen vorhanden.</p>
      {:else}
        <div class="cfg-table">
          <div class="cfg-row cfg-row--head">
            <div>Farbe</div>
            <div>Name</div>
            <div>Zeitraum</div>
            <div class="cfg-row__actions">Aktionen</div>
          </div>
          {#each templates as tpl (tpl.id)}
            <div class="cfg-row">
              <div>
                <span class="cfg-swatch" style:background={tpl.color} aria-hidden="true"></span>
              </div>
              <div class="cfg-cell-name">{tpl.name}</div>
              <div class="cfg-cell-num">{tpl.startTime} – {tpl.endTime}</div>
              <div class="cfg-row__actions">
                <button type="button" class="btn btn-ghost sm" onclick={() => openEditTemplate(tpl)}>
                  Bearbeiten
                </button>
                <button
                  type="button"
                  class="btn btn-ghost sm"
                  onclick={() => askDeleteTemplate(tpl.id, tpl.name)}
                >
                  Löschen
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="cfg-actions">
        <button type="button" class="btn btn-primary sm" onclick={openCreateTemplate}>
          Neue Vorlage
        </button>
      </div>
    </Card>

    <!-- ── Coverage Rules section ───────────────────────────────── -->
    <Card animate>
      <CardHeader
        title="Bedarfsregeln"
        sub="Mindest-Schicht-Gewicht je Vorlage und Wochentag. Spezifischste Regel gewinnt; Default = 2.0 wenn keine Regel."
      />

      {#if coverageRules.length === 0}
        <p class="cfg-muted">Noch keine Bedarfsregeln vorhanden. Default = 2.0 Schicht-Gewicht.</p>
      {:else}
        <div class="cfg-table">
          <div class="cfg-row cfg-row--head cfg-row--rules">
            <div>Vorlage</div>
            <div>Wochentag</div>
            <div>Min. Schicht-Gewicht</div>
            <div>Aufsicht erforderlich</div>
            <div class="cfg-row__actions">Aktionen</div>
          </div>
          {#each coverageRules as rule (rule.id)}
            <div class="cfg-row cfg-row--rules">
              <div class="cfg-cell-name">{ruleTemplateName(rule)}</div>
              <div>{ruleDayLabel(rule)}</div>
              <div class="cfg-cell-num">{Number(rule.minStaff).toFixed(2)}</div>
              <div>{rule.requiresNonSupervised ? "Ja" : "Nein"}</div>
              <div class="cfg-row__actions">
                <button type="button" class="btn btn-ghost sm" onclick={() => openEditRule(rule)}>
                  Bearbeiten
                </button>
                <button
                  type="button"
                  class="btn btn-ghost sm"
                  onclick={() => askDeleteRule(rule.id)}
                >
                  Löschen
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="cfg-actions">
        <button type="button" class="btn btn-primary sm" onclick={openCreateRule}>
          Neue Bedarfsregel
        </button>
      </div>
    </Card>

    <!-- ── Store hours section ──────────────────────────────────── -->
    <Card animate>
      <CardHeader
        title="Ladenöffnungszeiten"
        sub="Wochentägliche Öffnungs- und Schließzeiten. Schichtplanung warnt bei Konflikten."
      />

      <div class="cfg-table cfg-hours-table">
        <div class="cfg-row cfg-row--head cfg-row--hours">
          <div>Wochentag</div>
          <div>Geschlossen</div>
          <div>Öffnung</div>
          <div>Schließung</div>
        </div>
        {#each storeHours as h, idx (h.day)}
          <div class="cfg-row cfg-row--hours">
            <div class="cfg-cell-name">{DAY_NAMES_LONG[h.day]}</div>
            <div>
              <input
                id="hours-closed-{idx}"
                type="checkbox"
                checked={h.closed ?? false}
                onchange={(e) =>
                  (storeHours[idx] = {
                    ...h,
                    closed: (e.currentTarget as HTMLInputElement).checked,
                  })}
              />
            </div>
            <div>
              <input
                class="form-input"
                type="time"
                value={h.open}
                disabled={h.closed ?? false}
                onchange={(e) =>
                  (storeHours[idx] = {
                    ...h,
                    open: (e.currentTarget as HTMLInputElement).value,
                  })}
              />
            </div>
            <div>
              <input
                class="form-input"
                type="time"
                value={h.close}
                disabled={h.closed ?? false}
                onchange={(e) =>
                  (storeHours[idx] = {
                    ...h,
                    close: (e.currentTarget as HTMLInputElement).value,
                  })}
              />
            </div>
          </div>
        {/each}
      </div>

      <div class="cfg-section-title">Schicht-Zeiten an Öffnungszeiten binden</div>
      <div class="cfg-mode-options">
        <label class="cfg-mode-option">
          <input
            type="radio"
            name="shiftStoreHoursMode"
            value="DAY_ONLY"
            checked={shiftStoreHoursMode === "DAY_ONLY"}
            onchange={() => (shiftStoreHoursMode = "DAY_ONLY")}
          />
          <span>
            <strong>Nur geschlossene Tage blockieren</strong> (Standard) — Schichten dürfen vor
            Öffnung beginnen / nach Schließung enden (Vor- &amp; Nachbereitung). An geschlossenen
            Tagen ist keine Schicht möglich.
          </span>
        </label>
        <label class="cfg-mode-option">
          <input
            type="radio"
            name="shiftStoreHoursMode"
            value="STRICT"
            checked={shiftStoreHoursMode === "STRICT"}
            onchange={() => (shiftStoreHoursMode = "STRICT")}
          />
          <span>
            <strong>Strikt</strong> — Schichten müssen vollständig in den Öffnungszeiten liegen.
          </span>
        </label>
        <label class="cfg-mode-option">
          <input
            type="radio"
            name="shiftStoreHoursMode"
            value="OFF"
            checked={shiftStoreHoursMode === "OFF"}
            onchange={() => (shiftStoreHoursMode = "OFF")}
          />
          <span>
            <strong>Deaktiviert</strong> — keine Bindung an Öffnungszeiten.
          </span>
        </label>
      </div>

      <div class="cfg-actions">
        <button
          type="button"
          class="btn btn-primary sm"
          onclick={saveStoreHours}
          disabled={storeHoursSaving}
        >
          {storeHoursSaving ? "Speichern …" : "Öffnungszeiten speichern"}
        </button>
        {#if storeHoursMsg}
          <span class="cfg-muted cfg-msg">{storeHoursMsg}</span>
        {/if}
      </div>
    </Card>

    <!-- ── Pattern-Editor section (Phase 48) ─────────────────────── -->
    <Card animate>
      <CardHeader
        title="Schicht-Muster (Wochenrhythmus)"
        sub={'Wiederkehrendes Wochenmuster pro Mitarbeiter. Nur Mitarbeiter mit Arbeitszeitmodell „Schichtplan ist führend“ (SHIFT_BASED) erscheinen hier. Änderungen werden erst beim Klick auf „Muster speichern“ übernommen.'}
      />

      {#if shiftEmployees.length === 0}
        <div class="callout info">
          Keine SHIFT_BASED-Mitarbeiter konfiguriert. Wechsle das Arbeitszeitmodell unter
          <a href="/admin/vacation">Personalstruktur</a> zu „Schichtplan ist führend“, damit
          Mitarbeiter hier erscheinen.
        </div>
      {:else}
        <div class="pat-table">
          <div class="pat-row pat-row--head">
            <div>Mitarbeiter</div>
            {#each DAY_NAMES as dn, dow (dow)}
              <div class="pat-col-head">
                <span class="pat-dow">{dn}</span>
                {#if sollHintForDow(dow)}
                  <span class="pat-soll">{sollHintForDow(dow)}</span>
                {/if}
              </div>
            {/each}
          </div>
          {#each shiftEmployees as emp (emp.id)}
            <div class="pat-row" class:pat-row--dirty={isRowDirty(emp.id)}>
              <div class="cfg-cell-name">{employeeFullName(emp)}</div>
              {#each [0, 1, 2, 3, 4, 5, 6] as dow (dow)}
                <div class="pat-cell" class:pat-cell--dirty={isCellDirty(emp.id, dow)}>
                  <select
                    class="form-input pat-select"
                    value={patternMatrix[emp.id]?.[dow] ?? ""}
                    onchange={(e) => {
                      const v = (e.currentTarget as HTMLSelectElement).value;
                      const row = patternMatrix[emp.id] ?? Array(7).fill(null);
                      row[dow] = v === "" ? null : v;
                      patternMatrix = { ...patternMatrix, [emp.id]: row };
                    }}
                    aria-label="{employeeFullName(emp)} {DAY_NAMES_LONG[dow]}"
                  >
                    <option value="">—</option>
                    {#each templates as tpl (tpl.id)}
                      <option value={tpl.id}>{tpl.name}</option>
                    {/each}
                  </select>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}

      <div class="cfg-actions">
        <button
          type="button"
          class="btn btn-primary sm"
          onclick={saveBulkPatterns}
          disabled={patternsSaving || dirtyEmployeeCount === 0}
        >
          {patternsSaving
            ? "Speichern …"
            : `Muster speichern${dirtyEmployeeCount > 0 ? ` (${dirtyEmployeeCount})` : ""}`}
        </button>
        {#if patternsMsg}
          <span class="cfg-muted cfg-msg">{patternsMsg}</span>
        {/if}
      </div>
    </Card>
  {/if}

  <!-- ── Modal: Template ───────────────────────────────────────── -->
  <Modal
    bind:open={tplModalOpen}
    eyebrow="Schicht-Konfiguration"
    title={editingTplId ? "Vorlage bearbeiten" : "Neue Vorlage"}
  >
    {#if tplError}
      <div class="callout error" role="alert">{tplError}</div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="tpl-name">Name *</label>
      <input
        id="tpl-name"
        class="form-input"
        type="text"
        bind:value={tplName}
        placeholder="z.B. Frühschicht"
      />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="tpl-start">Startzeit *</label>
        <input id="tpl-start" class="form-input" type="time" bind:value={tplStart} />
      </div>
      <div class="form-group">
        <label class="form-label" for="tpl-end">Endzeit *</label>
        <input id="tpl-end" class="form-input" type="time" bind:value={tplEnd} />
      </div>
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
    <div class="cfg-palette" role="group" aria-label="Schichtfarbe wählen">
      {#each SHIFT_PALETTE as p (p.token)}
        <button
          type="button"
          class="cfg-swatch-btn"
          style:background="var({p.token})"
          title={p.label}
          aria-label={p.label}
          onclick={() => pickPaletteColor(p.token)}
        ></button>
      {/each}
    </div>
    {#snippet footer()}
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (tplModalOpen = false)}
        >Abbrechen</button
      >
      <button type="button" class="btn btn-primary sm" onclick={saveTemplate} disabled={saving}>
        {saving ? "Speichern …" : "Speichern"}
      </button>
    {/snippet}
  </Modal>

  <!-- ── Modal: Coverage Rule ──────────────────────────────────── -->
  <Modal
    bind:open={ruleModalOpen}
    eyebrow="Schicht-Konfiguration"
    title={ruleEditingId ? "Bedarfsregel bearbeiten" : "Neue Bedarfsregel"}
  >
    {#if ruleError}
      <div class="callout error" role="alert">{ruleError}</div>
    {/if}
    <p class="cfg-help">
      Die spezifischste Regel gewinnt: (Vorlage + Wochentag) &gt; (Alle Vorlagen + Wochentag) &gt;
      (Vorlage + Alle Tage) &gt; (Alle Vorlagen + Alle Tage). Default ist 2.0 Schicht-Gewicht.
    </p>
    <div class="form-group">
      <label class="form-label" for="rule-tpl">Vorlage</label>
      <select id="rule-tpl" class="form-input" bind:value={ruleTemplateId}>
        <option value="">Alle Vorlagen</option>
        {#each templates as tpl (tpl.id)}
          <option value={tpl.id}>{tpl.name}</option>
        {/each}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="rule-dow">Wochentag</label>
      <select id="rule-dow" class="form-input" bind:value={ruleDayOfWeek}>
        <option value={-1}>Alle Tage</option>
        {#each DAY_NAMES_LONG as name, i (i)}
          <option value={i}>{name}</option>
        {/each}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="rule-min">Min. Schicht-Gewicht *</label>
      <input
        id="rule-min"
        class="form-input"
        type="number"
        step="0.25"
        min="0"
        max="99"
        bind:value={ruleMinStaff}
      />
      <span class="cfg-muted cfg-hint">
        Summe der coverageWeight-Werte (z.B. Azubi 0.5 + Vollzeit 1.0 = 1.5).
      </span>
    </div>
    <div class="form-group">
      <label class="cfg-checkbox-label">
        <input type="checkbox" bind:checked={ruleRequiresNonSupervised} />
        Aufsicht erforderlich (mindestens 1 nicht-aufsichtspflichtiger Mitarbeiter)
      </label>
    </div>
    {#snippet footer()}
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (ruleModalOpen = false)}
        >Abbrechen</button
      >
      <button type="button" class="btn btn-primary sm" onclick={saveRule} disabled={saving}>
        {saving ? "Speichern …" : "Speichern"}
      </button>
    {/snippet}
  </Modal>

  <!-- ── Confirmations ─────────────────────────────────────────── -->
  <ConfirmDialog
    bind:open={tplDeleteConfirm.open}
    title="Vorlage löschen?"
    description={`Die Vorlage „${tplDeleteConfirm.name}" wird dauerhaft entfernt.`}
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDeleteTemplate}
  />

  <ConfirmDialog
    bind:open={ruleDeleteConfirm.open}
    title="Bedarfsregel löschen?"
    description="Die Bedarfsregel wird dauerhaft entfernt. Falls keine andere passende Regel existiert, gilt der Default (2.0)."
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDeleteRule}
  />
</div>

<style>
  .cfg-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0;
  }
  .cfg-row {
    display: grid;
    grid-template-columns: 60px 1fr 1fr 200px;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .cfg-row--rules {
    grid-template-columns: 1.5fr 1.2fr 1.2fr 1.5fr 180px;
  }
  .cfg-row--hours {
    grid-template-columns: 1.5fr 0.8fr 1fr 1fr;
  }
  .cfg-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
  }
  .cfg-row:last-child {
    border-bottom: none;
  }
  .cfg-row__actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .cfg-cell-name {
    font-weight: 600;
    color: var(--text);
  }
  .cfg-cell-num {
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
  }
  .cfg-swatch {
    display: inline-block;
    width: 24px;
    height: 24px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
  }
  .cfg-actions {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 12px;
  }
  .cfg-muted {
    color: var(--text-muted);
    font-size: 13.5px;
  }
  .cfg-msg {
    font-style: italic;
  }
  .cfg-help {
    background: var(--bg-subtle);
    border-radius: var(--r-md);
    padding: 10px 12px;
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 12px;
  }
  .cfg-hint {
    display: block;
    margin-top: 4px;
    font-size: 12.5px;
  }
  .cfg-checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--text);
    cursor: pointer;
  }
  .cfg-palette {
    display: flex;
    gap: 8px;
    margin: 8px 0 12px;
    flex-wrap: wrap;
  }
  .cfg-swatch-btn {
    width: 24px;
    height: 24px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
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

  @media (max-width: 720px) {
    .cfg-row,
    .cfg-row--rules,
    .cfg-row--hours {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .cfg-row__actions {
      justify-content: flex-start;
    }
  }
  /* Phase 47.5 — Mode radio block */
  .cfg-section-title {
    margin: 24px 0 8px;
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--text);
  }
  .cfg-mode-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .cfg-mode-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text);
    transition: border-color 0.12s var(--ease);
  }
  .cfg-mode-option:hover {
    border-color: var(--brand);
  }
  .cfg-mode-option input {
    margin-top: 2px;
  }
  .cfg-mode-option strong {
    color: var(--text);
  }

  /* Phase 48 — Pattern-Editor table */
  .pat-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0;
  }
  .pat-row {
    display: grid;
    grid-template-columns: minmax(160px, 1.4fr) repeat(7, minmax(110px, 1fr));
    gap: 8px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .pat-row:last-child {
    border-bottom: none;
  }
  .pat-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pat-row--dirty {
    background: var(--brand-soft);
    border-radius: var(--r-sm);
  }
  .pat-col-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pat-dow {
    color: var(--text-muted);
  }
  .pat-soll {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    font-family: var(--font-mono);
    text-transform: none;
    letter-spacing: 0;
  }
  .pat-cell {
    min-width: 0;
  }
  .pat-cell--dirty .pat-select {
    border-color: var(--brand);
    box-shadow: 0 0 0 1px var(--brand);
  }
  .pat-select {
    width: 100%;
    font-size: 13px;
    padding: 4px 6px;
  }
  @media (max-width: 900px) {
    .pat-row {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
