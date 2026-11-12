<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { formatStaff } from "$lib/shifts/staffing"; // Issue #850 - "2", never "2.00"
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
  import {
    COVERAGE_RULE_SALON_INACTIVE_BADGE,
    coverageRuleSalonCell,
    coverageRuleSalonChoices,
    coverageRuleSalonPayload,
    showCoverageSalonColumn,
  } from "$lib/shifts/coverage-rule-salon";
  import {
    DAY_NAMES,
    DAY_NAMES_LONG,
    type CoverageRule,
    type PatternEmployee,
    type PatternRow,
    type ShiftTemplate,
  } from "$lib/shifts/dienstplan-config";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ShiftTemplatesPanel from "$lib/components/admin/dienstplan/ShiftTemplatesPanel.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  type ShiftWeekResponse = { employees: PatternEmployee[] };

  // The panels of the page, in the order of the tab strip; the URL hash names one (D-854-03).
  const TABS = [
    { value: "vorlagen", label: "Schichtvorlagen" },
    { value: "bedarf", label: "Bedarfsregeln" },
    { value: "muster", label: "Wochenmuster" },
  ] as const;
  const TAB_IDS = TABS.map((tab) => tab.value);
  let activeTab = $state<string>(TAB_IDS[0]);

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // Issue #83 (D-13): access is decided by the admin layout guard (admin-route-permissions.ts);
  // the API answers 403 regardless.
  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    void loadAll();
  });

  // ── State ───────────────────────────────────────────────────
  let templates: ShiftTemplate[] = $state([]);
  let coverageRules: CoverageRule[] = $state([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");

  // Coverage rule editor
  let ruleModalOpen = $state(false);
  let ruleEditingId: string | null = $state(null);
  let ruleTemplateId = $state(""); // "" = all templates
  let ruleDayOfWeek = $state<number>(-1);
  let ruleMinStaff = $state<number>(2);
  let ruleRequiresNonSupervised = $state(false);
  let ruleError = $state("");
  // Issue #647: "" = all salons (tenant-wide). Sent only while the select is shown.
  let ruleSalonId = $state("");
  // The #64 rule, in its one place: the salon choice and the list column appear only with salon options.
  const salonOptionsShown = $derived(showSalonOptions($salonContext));
  const salonColumnShown = $derived(showCoverageSalonColumn(salonOptionsShown, coverageRules));
  const ruleSalonChoices = $derived(
    coverageRuleSalonChoices(
      $salonContext.salons,
      coverageRules.find((r) => r.id === ruleEditingId) ?? null,
    ),
  );

  // Delete confirmation
  let ruleDeleteConfirm = $state<{ open: boolean; id: string | null }>({
    open: false,
    id: null,
  });

  // Phase 48 — Pattern editor state
  let shiftEmployees: PatternEmployee[] = $state([]);
  // matrix[employeeId][0..6] = templateId | null
  let patternMatrix: Record<string, Array<string | null>> = $state({});
  // mirror of initial server state for dirty detection
  let patternMatrixInitial: Record<string, Array<string | null>> = $state({});
  let patternsSaving = $state(false);
  let patternsMsg = $state("");

  // ── Load all config ─────────────────────────────────────────
  async function loadAll() {
    loading = true;
    error = "";
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const [tpls, rules, week, patterns] = await Promise.all([
        api.get<ShiftTemplate[]>("/shifts/templates"),
        api.get<CoverageRule[]>("/shifts/coverage-rules"),
        api.get<ShiftWeekResponse>(`/shifts/week?date=${todayIso}`),
        api.get<PatternRow[]>("/shift-patterns/tenant"),
      ]);
      templates = tpls;
      coverageRules = rules;
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
      snapshotsReady = true;
    } catch (e) {
      console.error(e);
      error = "Fehler beim Laden der Konfiguration.";
    } finally {
      loading = false;
    }
  }

  // Reloads the two lists a template or rule write can change; the pattern matrix and its unsaved
  // edits are left alone.
  async function reloadLists() {
    try {
      [templates, coverageRules] = await Promise.all([
        api.get<ShiftTemplate[]>("/shifts/templates"),
        api.get<CoverageRule[]>("/shifts/coverage-rules"),
      ]);
    } catch (e) {
      console.error(e);
      toasts.error("Die Listen konnten nicht neu geladen werden.");
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
  const dirtyEmployeeCount = $derived(shiftEmployees.filter((e) => isRowDirty(e.id)).length);

  // Phase 109 (D-11/D-12) — this page already had the baseline this phase's idiom prescribes
  // (patternMatrixInitial, taken in loadAll and re-taken only on a fully successful save), so no
  // second snapshot mechanism is introduced here. dirtyEmployeeCount IS the derivation.
  const patternsDirty = $derived(dirtyEmployeeCount > 0);

  // Gate the registration on "the baseline has been taken" (WR-01): loadAll can fail (its catch
  // sets `error`) or never run at all (a non-ADMIN is redirected out of onMount before loadAll),
  // and an unregistered page must not be able to arm the navigation guard.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-shifts", snapshotsReady && patternsDirty);
    return () => markUnsaved("admin-shifts", false);
  });
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
      toasts.success(`Schicht-Muster gespeichert (${ok} Personen).`);
      patternMatrixInitial = JSON.parse(JSON.stringify(patternMatrix));
    } else if (ok === 0) {
      toasts.error(`Speichern fehlgeschlagen für alle ${fail} Personen.`);
    } else {
      toasts.error(`Teilweise gespeichert: ${ok} OK, ${fail} Fehler. Bitte erneut versuchen.`);
    }
    patternsSaving = false;
    patternsMsg = fail === 0 ? "Gespeichert." : `${fail} Fehler.`;
    setTimeout(() => (patternsMsg = ""), 3000);
  }

  // ── Coverage Rules ──────────────────────────────────────────
  function openCreateRule() {
    ruleEditingId = null;
    ruleTemplateId = "";
    ruleDayOfWeek = -1;
    ruleMinStaff = 2;
    ruleRequiresNonSupervised = false;
    ruleSalonId = "";
    ruleError = "";
    ruleModalOpen = true;
  }

  function openEditRule(rule: CoverageRule) {
    ruleEditingId = rule.id;
    ruleTemplateId = rule.templateId ?? "";
    ruleDayOfWeek = rule.dayOfWeek;
    ruleMinStaff = Number(rule.minStaff);
    ruleRequiresNonSupervised = rule.requiresNonSupervised;
    ruleSalonId = rule.salonId ?? "";
    ruleError = "";
    ruleModalOpen = true;
  }

  async function saveRule() {
    if (ruleMinStaff < 0) {
      ruleError = "Die Mindestbesetzung darf nicht negativ sein.";
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
        ...coverageRuleSalonPayload(salonOptionsShown, ruleSalonId),
      };
      if (ruleEditingId) {
        await api.put(`/shifts/coverage-rules/${ruleEditingId}`, payload);
      } else {
        await api.post("/shifts/coverage-rules", payload);
      }
      ruleModalOpen = false;
      await reloadLists();
      toasts.success(
        ruleEditingId ? "Mindestbesetzung aktualisiert." : "Mindestbesetzung angelegt.",
      );
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
      await reloadLists();
      toasts.success("Mindestbesetzung gelöscht.");
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
</script>

<svelte:head>
  <title>{pageLabel("/admin/shifts")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/admin/shifts")}
  sub="Schichtvorlagen, Bedarfsregeln und Wochenmuster deines Unternehmens."
/>

{#if error}
  <ErrorState message={error} onRetry={loadAll} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else}
  <PageTabs
    tabs={[...TABS]}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche des Dienstplans"
  >
    {#snippet panel(value)}
      {#if value === "vorlagen"}
        <ShiftTemplatesPanel {templates} onChanged={reloadLists} />
      {:else if value === "bedarf"}
        <Section
          title="Mindestbesetzung"
          sub="Wie viele Personen je Vorlage und Wochentag mindestens eingeplant sein sollen. Die genaueste Regel gilt; ohne Regel sind es 2."
        >
          {#if coverageRules.length === 0}
            <p class="cfg-muted">
              Noch keine Mindestbesetzung festgelegt. Ohne Regel gelten 2 Personen.
            </p>
          {:else}
            <div class="cfg-table">
              <div
                class="cfg-row cfg-row--head cfg-row--rules"
                class:cfg-row--rules-salon={salonColumnShown}
              >
                {#if salonColumnShown}
                  <div>Salon</div>
                {/if}
                <div>Vorlage</div>
                <div>Wochentag</div>
                <div>Mindestens</div>
                <div>Aufsicht erforderlich</div>
                <div class="cfg-row__actions">Aktionen</div>
              </div>
              {#each coverageRules as rule (rule.id)}
                <div class="cfg-row cfg-row--rules" class:cfg-row--rules-salon={salonColumnShown}>
                  {#if salonColumnShown}
                    {@const salonCell = coverageRuleSalonCell(rule)}
                    <div>
                      {salonCell.label}
                      {#if salonCell.inactive}
                        <span class="badge badge-yellow">{COVERAGE_RULE_SALON_INACTIVE_BADGE}</span>
                      {/if}
                    </div>
                  {/if}
                  <div class="cfg-cell-name">{ruleTemplateName(rule)}</div>
                  <div>{ruleDayLabel(rule)}</div>
                  <div class="cfg-cell-num">{formatStaff(Number(rule.minStaff))}</div>
                  <div>{rule.requiresNonSupervised ? "Ja" : "Nein"}</div>
                  <div class="cfg-row__actions">
                    <button
                      type="button"
                      class="btn btn-ghost sm"
                      onclick={() => openEditRule(rule)}
                    >
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
          {#snippet footer()}
            <button type="button" class="btn btn-primary sm" onclick={openCreateRule}>
              Neue Mindestbesetzung
            </button>
          {/snippet}
        </Section>
      {:else if value === "muster"}
        <Section
          title="Schicht-Muster (Wochenrhythmus)"
          sub="Wiederkehrendes Wochenmuster je Person. Nur Mitarbeitende mit Arbeitszeitmodell „Nach Schichtplan“ erscheinen hier. Änderungen werden erst beim Klick auf „Muster speichern“ übernommen."
          dirty={patternsDirty}
        >
          {#if shiftEmployees.length === 0}
            <div class="callout info">
              Noch niemand arbeitet nach Schichtplan. Stell das Arbeitszeitmodell unter
              <a href="/admin/vacation">Personalstruktur</a> auf „Nach Schichtplan“ um, damit Mitarbeitende
              hier erscheinen.
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
          {#snippet footer()}
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
          {/snippet}
        </Section>
      {/if}
    {/snippet}
  </PageTabs>
{/if}

<!-- ── Modal: Coverage Rule ──────────────────────────────────── -->
<Modal
  bind:open={ruleModalOpen}
  eyebrow="Schicht-Konfiguration"
  title={ruleEditingId ? "Mindestbesetzung bearbeiten" : "Neue Mindestbesetzung"}
>
  {#if ruleError}
    <div class="callout error" role="alert">{ruleError}</div>
  {/if}
  <p class="cfg-help">
    Die genaueste Regel gilt: erst Vorlage und Wochentag, dann alle Vorlagen an diesem Wochentag,
    dann die Vorlage an allen Tagen, zuletzt alle Vorlagen an allen Tagen. Ohne Regel gelten 2
    Personen.
  </p>
  {#if salonOptionsShown}
    <div class="form-group">
      <label class="form-label" for="rule-salon">Salon</label>
      <select id="rule-salon" class="form-input" bind:value={ruleSalonId}>
        {#each ruleSalonChoices as choice (choice.value)}
          <option value={choice.value}>{choice.label}</option>
        {/each}
      </select>
    </div>
    <p class="cfg-help">
      Eine Regel für einen Salon geht auf derselben Stufe der Regel für alle Salons vor. Die Regel
      gilt, wenn die Wochenansicht genau diesen Salon zeigt: bei Wahl in der Kopfleiste, für alle,
      die nur diesen Salon planen, und in Unternehmen mit nur einem aktiven Salon. Sonst gelten nur
      die Regeln für alle Salons.
    </p>
  {/if}
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
    <label class="form-label" for="rule-min">Mindestens (Personen) *</label>
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
      Personen zählen nach ihrem Schicht-Gewicht, z. B. Vollzeit 1 und Azubi 0,5 – zusammen 1,5.
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
  bind:open={ruleDeleteConfirm.open}
  title="Mindestbesetzung löschen?"
  description="Die Regel wird dauerhaft entfernt. Gibt es keine andere passende Regel, gelten 2 Personen."
  confirmLabel="Löschen"
  danger
  onConfirm={confirmDeleteRule}
/>

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
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }
  .cfg-row--rules {
    grid-template-columns: 1.5fr 1.2fr 1.2fr 1.5fr 180px;
  }
  /* Issue #647: the same row with the salon column in front. */
  .cfg-row--rules-salon {
    grid-template-columns: 1.2fr 1.5fr 1.2fr 1.2fr 1.5fr 180px;
  }
  /* .cfg-row--hours / .cfg-hours-table moved to /admin/system#allgemein (Phase 58). */
  .cfg-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--line);
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
    font-family: var(--font-ui);
  }
  .cfg-muted {
    color: var(--text-2);
    font-size: 13.5px;
  }
  .cfg-help {
    background: var(--sunk);
    border-radius: var(--r-control);
    padding: 10px 12px;
    font-size: 13px;
    color: var(--text-2);
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
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  @media (max-width: 720px) {
    .cfg-row,
    .cfg-row--rules,
    .cfg-row--rules-salon {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .cfg-row__actions {
      justify-content: flex-start;
    }
  }
  /* Phase 47.5 mode radio block moved to /admin/system#allgemein (Phase 58). */

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
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }
  .pat-row:last-child {
    border-bottom: none;
  }
  .pat-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pat-row--dirty {
    background: var(--brand-soft);
    border-radius: var(--r-control);
  }
  .pat-col-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pat-dow {
    color: var(--text-2);
  }
  .pat-soll {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-2);
    font-family: var(--font-ui);
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
