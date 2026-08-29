<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import Pagination from "$components/ui/Pagination.svelte";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  // ── Tabs (Phase 58: split log from config) ─────────────────────────────────
  const TABS = [
    { id: "log", label: "Audit-Trail" },
    { id: "config", label: "Aufbewahrung & DSGVO" },
  ];
  let activeTab = $state<string>("log");

  interface AuditLog {
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    oldValue: unknown;
    newValue: unknown;
    ipAddress: string | null;
    createdAt: string;
    user: { email: string } | null;
  }

  interface AuditResponse {
    logs: AuditLog[];
    total: number;
    page: number;
    limit: number;
  }

  interface WorkSettings {
    dataRetentionYears?: number;
  }

  let logs: AuditLog[] = $state([]);
  let total = $state(0);
  // Phase 116 (issue #119) — starts TRUE. Genuine fix: `onMount` (:62) calls `loadLogs()`, which
  // fires AFTER mount, so the first painted frame hit the `{:else if logs.length === 0}` arm at
  // :208 and showed "Keine Audit-Einträge" before any request had been made. Safe: loadLogs is
  // `loading = true` → try → `finally { loading = false }`, no early return. `retentionLoading`
  // (:56) is a separate flag with its own finally and is deliberately NOT flipped.
  let loading = $state(true);
  let loadError = $state("");

  let filterAction = $state("");
  let filterEntity = $state("");
  let page = $state(1);
  let pageSize = $state(10);

  // Retention setting (Phase 31 — ADM-03)
  let retentionYears = $state(10);
  let retentionLoading = $state(false);
  let retentionSaving = $state(false);

  const ACTIONS = ["LOGIN", "CREATE", "UPDATE", "DELETE", "EXPORT"];
  const ENTITIES = ["TimeEntry", "LeaveRequest", "Employee", "User", "OvertimeAccount", "Settings"];

  onMount(() => {
    void loadLogs();
    void loadRetention();
  });

  async function loadLogs() {
    loading = true;
    loadError = "";
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        ...(filterAction ? { action: filterAction } : {}),
        ...(filterEntity ? { entity: filterEntity } : {}),
      });
      const res = await api.get<AuditResponse>(`/audit-logs?${params}`);
      logs = res.logs;
      total = res.total;
    } catch (e: unknown) {
      loadError = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  async function loadRetention() {
    retentionLoading = true;
    try {
      const cfg = await api.get<WorkSettings>("/settings/work");
      retentionYears = cfg.dataRetentionYears ?? 10;
    } catch {
      // keep default — non-blocking
    } finally {
      retentionLoading = false;
    }
  }

  async function saveRetention() {
    retentionSaving = true;
    try {
      await api.put("/settings/work", { dataRetentionYears: retentionYears });
      toasts.success("Aufbewahrungsfrist aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler beim Speichern");
    } finally {
      retentionSaving = false;
    }
  }

  async function applyFilter() {
    page = 1;
    await loadLogs();
  }

  function actionChip(action: string): string {
    const map: Record<string, string> = {
      LOGIN: "chip chip-good",
      CREATE: "chip chip-brand",
      UPDATE: "chip chip-warn",
      DELETE: "chip chip-bad",
      EXPORT: "chip",
    };
    return map[action] ?? "chip";
  }

  function fmtDate(iso: string): string {
    return format(new Date(iso), "dd.MM.yyyy HH:mm:ss", { locale: de });
  }

  function hasDetail(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0)
      return false;
    return true;
  }

  function navigateToEntry(id: string) {
    void goto(`/admin/audit/${id}`);
  }

  function onRowKeydown(e: KeyboardEvent, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void goto(`/admin/audit/${id}`);
    }
  }
</script>

<svelte:head>
  <title>Audit & Log – Clokr</title>
</svelte:head>

<SectionStack
  eyebrow="Compliance"
  title="Audit & Log"
  sub="Audit-Trail, Aufbewahrung und DSGVO"
  tabs={TABS}
  bind:activeTab
  animate
>
  {#snippet tabContent(currentTab)}
    {#if currentTab === "log"}
      <!-- ── Audit-Trail ───────────────────────────────────────── -->
      <Section title="Audit-Trail" sub="Manipulationssicheres Protokoll aller Aktionen">
        {#snippet actions()}
          <span class="chip">
            <span class="dot"></span>
            {total.toLocaleString("de-DE")} Einträge
          </span>
        {/snippet}

        {#if loadError}
          <div class="alert alert-error" role="alert"><span>⚠</span><span>{loadError}</span></div>
        {/if}

        <div class="audit-filter-bar">
          <select
            class="form-input"
            bind:value={filterAction}
            onchange={applyFilter}
            aria-label="Nach Aktion filtern"
          >
            <option value="">Alle Aktionen</option>
            {#each ACTIONS as a (a)}
              <option value={a}>{a}</option>
            {/each}
          </select>
          <select
            class="form-input"
            bind:value={filterEntity}
            onchange={applyFilter}
            aria-label="Nach Entität filtern"
          >
            <option value="">Alle Entitäten</option>
            {#each ENTITIES as e (e)}
              <option value={e}>{e}</option>
            {/each}
          </select>
          <span class="audit-filter-count">{logs.length} von {total}</span>
        </div>

        {#if loading}
          <div class="audit-skeleton">
            <div class="skeleton audit-skel-row-1"></div>
            <div class="skeleton audit-skel-row-2"></div>
          </div>
        {:else if logs.length === 0}
          <EmptyState
            icon="search"
            title="Keine Audit-Einträge"
            description="Wähle einen anderen Zeitraum oder Filter."
          />
        {:else}
          <ul class="audit-timeline" aria-label="Audit-Einträge">
            {#each logs as log (log.id)}
              <li
                class="audit-row"
                role="button"
                tabindex="0"
                aria-label="Audit-Eintrag {log.action} {log.entity} vom {fmtDate(
                  log.createdAt,
                )} öffnen"
                onclick={() => navigateToEntry(log.id)}
                onkeydown={(e) => onRowKeydown(e, log.id)}
              >
                <div class="audit-row-main">
                  <span class="audit-time">{fmtDate(log.createdAt)}</span>
                  <span class="audit-actor">
                    {#if log.user?.email}{log.user.email}{:else}<span class="audit-muted"
                        >System</span
                      >{/if}
                  </span>
                  <span class={actionChip(log.action)}>
                    <span class="dot"></span>{log.action}
                  </span>
                  <span class="audit-entity">{log.entity}</span>
                  <span class="audit-hash">
                    {log.entityId ? log.entityId.slice(0, 8) + "…" : "—"}
                  </span>
                  <span class="audit-ip">{log.ipAddress ?? "—"}</span>
                  {#if hasDetail(log.oldValue) || hasDetail(log.newValue)}
                    <span class="audit-has-detail" aria-label="Hat Details">↗</span>
                  {:else}
                    <span class="audit-toggle-spacer"></span>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>

          <div class="audit-pagination">
            <Pagination {total} bind:page bind:pageSize onChange={() => loadLogs()} />
          </div>
        {/if}
      </Section>
    {:else if currentTab === "config"}
      <!-- ── Aufbewahrung ──────────────────────────────────────── -->
      <Section title="Aufbewahrung" sub="Standard: 10 Jahre (GoBD, § 147 AO)">
        {#snippet footer()}
          <span class="audit-spacer"></span>
          <button
            class="btn btn-primary sm"
            onclick={saveRetention}
            disabled={retentionSaving || retentionLoading}
          >
            {#if retentionSaving}<Spinner />{/if}
            Speichern
          </button>
        {/snippet}

        <label class="audit-field">
          <span class="audit-field-label">Aufbewahrungsfrist</span>
          <select class="form-input" bind:value={retentionYears} disabled={retentionLoading}>
            <option value={10} translate="no">10 Jahre (GoBD)</option>
            <option value={6} translate="no">6 Jahre (§ 41 EStG Lohnkonten)</option>
            <option value={3}>3 Jahre</option>
            <option value={2} translate="no">2 Jahre (Minimum § 16 ArbZG)</option>
          </select>
          <span class="audit-field-hint">
            Nach Ablauf werden Daten automatisch anonymisiert. Aggregierte Salden bleiben erhalten.
            Hinweis: <span translate="no">§ 147 AO</span> verlangt 10 Jahre für lohnrelevante Belege;
            kürzere Fristen nur, wenn keine Buchungsbelege betroffen sind.
          </span>
        </label>
      </Section>

      <!--
        2FA toggle lives on /admin/system#sicherheit (single source of truth).
        It used to also appear here as a placeholder card, but a duplicate
        "Inaktiv" stub with no working control was just confusing.
      -->

      <!-- ── DSGVO-Werkzeuge ───────────────────────────────────── -->
      <Section title="DSGVO-Werkzeuge" sub="Datenexport · Anonymisierung · Löschauftrag">
        <div class="audit-dsgvo-actions">
          <a class="btn btn-outline audit-dsgvo-btn" href="/admin/employees">
            Datenexport pro Mitarbeiter:in
          </a>
          <a class="btn btn-outline audit-dsgvo-btn" href="/admin/employees">
            Anonymisierung verwalten
          </a>
        </div>
      </Section>
    {/if}
  {/snippet}
</SectionStack>

<style>
  /* ── Filter bar ── */
  .audit-filter-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 6px;
  }

  .audit-filter-bar select {
    width: auto;
    min-width: 160px;
    flex: 0 0 auto;
  }

  .audit-filter-count {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }

  @media (max-width: 480px) {
    .audit-filter-bar select {
      flex: 1 1 100%;
      min-width: 0;
      width: 100%;
    }
    .audit-filter-count {
      flex: 1 1 100%;
      margin-left: 0;
      text-align: left;
    }
  }

  /* ── Timeline list ── */
  .audit-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .audit-row {
    border-bottom: 1px solid var(--border);
    padding: 10px 0;
    cursor: pointer;
    transition: background-color 160ms var(--ease);
    border-radius: var(--r-sm);
  }

  .audit-row:last-child {
    border-bottom: none;
  }

  .audit-row:hover,
  .audit-row:focus-visible {
    background: var(--bg-subtle);
    padding-left: 8px;
    padding-right: 8px;
    outline: none;
  }

  .audit-row:focus-visible {
    box-shadow: 0 0 0 2px var(--brand);
  }

  .audit-row-main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto auto auto;
    align-items: center;
    gap: 12px;
  }

  .audit-time {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .audit-actor {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-muted {
    color: var(--text-muted);
    font-style: italic;
  }

  .audit-entity {
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .audit-hash {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .audit-ip {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .audit-has-detail {
    font-size: 13px;
    color: var(--brand);
    width: 28px;
    display: inline-block;
    text-align: center;
  }

  .audit-toggle-spacer {
    width: 28px;
    display: inline-block;
  }

  /* ── Skeleton state ── */
  .audit-skeleton {
    padding: 20px 0;
  }
  .audit-skel-row-1 {
    height: 1.5rem;
    width: 60%;
    margin-bottom: 0.75rem;
  }
  .audit-skel-row-2 {
    height: 1.5rem;
    width: 80%;
  }

  .audit-pagination {
    margin-top: 8px;
  }

  /* ── Retention field controls ── */
  .audit-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .audit-field-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
  }

  .audit-field-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin-top: 4px;
  }

  .audit-spacer {
    flex: 1 1 auto;
  }

  .audit-body-text {
    font-size: 13px;
    color: var(--text-muted);
    margin: 4px 0 0;
    line-height: 1.55;
  }

  .audit-dsgvo-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }

  .audit-dsgvo-btn {
    justify-content: flex-start;
  }

  /* ── Responsive ── */
  @media (max-width: 720px) {
    .audit-row-main {
      grid-template-columns: 1fr auto;
      gap: 6px 12px;
    }
    .audit-time {
      grid-column: 1 / -1;
    }
    .audit-entity,
    .audit-hash,
    .audit-ip {
      grid-column: 1 / -1;
    }
  }
</style>
