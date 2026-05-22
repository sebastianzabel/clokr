<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

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
  let loading = $state(false);
  let error = $state("");

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
    error = "";
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
      error = e instanceof Error ? e.message : "Fehler beim Laden";
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

  let expandedId = $state<string | null>(null);

  // Tighten "has detail" check: API types old/newValue as `unknown`; the
  // underlying JSON column can return `null`, `undefined`, or an empty
  // object — only render the toggle / detail pane when there is real content.
  function hasDetail(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0)
      return false;
    return true;
  }

  function onPageKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && expandedId !== null) {
      expandedId = null;
    }
  }
</script>

<svelte:window onkeydown={onPageKeydown} />

<svelte:head>
  <title>Compliance & Audit – Clokr</title>
</svelte:head>

<section class="page">
  <PageHead
    eyebrow="Administration"
    title="Compliance & Audit"
    accent="Audit"
    sub="Audit-sicher · konfigurierbare Aufbewahrung (§ 147 AO, 10 Jahre Standard) · GoBD- und DSGVO-konform."
  />

  {#if error}
    <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
  {/if}

  <div class="grid grid-12">
    <!-- ── Left: Audit-Trail Timeline ─────────────────────────── -->
    <div class="col-7">
      <Card animate class="audit-card" style="--card-idx: 0;">
        <CardHeader title="Audit-Trail" sub="Manipulationssicheres Protokoll aller Aktionen">
          {#snippet actions()}
            <span class="chip">
              <span class="dot"></span>
              {total.toLocaleString("de-DE")} Einträge
            </span>
          {/snippet}
        </CardHeader>

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
              <li class="audit-row" class:is-expanded={expandedId === log.id}>
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
                    <button
                      id={`audit-toggle-${log.id}`}
                      class="btn btn-ghost xs audit-toggle"
                      onclick={() => (expandedId = expandedId === log.id ? null : log.id)}
                      aria-controls={`audit-detail-${log.id}`}
                      aria-expanded={expandedId === log.id}
                      aria-label={expandedId === log.id ? "Details ausblenden" : "Details anzeigen"}
                    >
                      {expandedId === log.id ? "▲" : "▼"}
                    </button>
                  {:else}
                    <span class="audit-toggle-spacer"></span>
                  {/if}
                </div>
                {#if expandedId === log.id}
                  <div
                    id={`audit-detail-${log.id}`}
                    role="region"
                    aria-labelledby={`audit-toggle-${log.id}`}
                    class="audit-detail"
                  >
                    {#if hasDetail(log.oldValue)}
                      <div class="audit-detail-block">
                        <p class="audit-detail-label">Vorher</p>
                        <pre class="audit-detail-pre">{JSON.stringify(log.oldValue, null, 2)}</pre>
                      </div>
                    {/if}
                    {#if hasDetail(log.newValue)}
                      <div class="audit-detail-block">
                        <p class="audit-detail-label">Nachher</p>
                        <pre class="audit-detail-pre">{JSON.stringify(log.newValue, null, 2)}</pre>
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>

          <div class="audit-pagination">
            <Pagination {total} bind:page bind:pageSize onChange={() => loadLogs()} />
          </div>
        {/if}
      </Card>
    </div>

    <!-- ── Right: Retention / 2FA / DSGVO ─────────────────────── -->
    <div class="col-5 right-stack">
      <!-- Aufbewahrung -->
      <Card animate style="--card-idx: 1;">
        <CardHeader title="Aufbewahrung" sub="Standard: 10 Jahre (GoBD, § 147 AO)" />
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
        <div class="card-foot">
          <span class="audit-spacer"></span>
          <button
            class="btn btn-primary sm"
            onclick={saveRetention}
            disabled={retentionSaving || retentionLoading}
          >
            {#if retentionSaving}<Spinner />{/if}
            Speichern
          </button>
        </div>
      </Card>

      <!-- 2FA (display-only — wiring deferred to a later milestone) -->
      <Card animate>
        <CardHeader title="2FA" sub="Optionale E-Mail-OTP">
          {#snippet actions()}
            <span class="chip"><span class="dot"></span>Inaktiv</span>
          {/snippet}
        </CardHeader>
        <p class="audit-card-body-text">
          E-Mail-OTP für Manager- und Admin-Rollen folgt in einem späteren Milestone. Code gültig 5
          Minuten.
        </p>
      </Card>

      <!-- DSGVO-Werkzeuge -->
      <Card animate>
        <CardHeader title="DSGVO-Werkzeuge" sub="Datenexport · Anonymisierung · Löschauftrag" />
        <div class="audit-dsgvo-actions">
          <a class="btn btn-outline audit-dsgvo-btn" href="/admin/employees">
            Datenexport pro Mitarbeiter:in
          </a>
          <a class="btn btn-outline audit-dsgvo-btn" href="/admin/employees">
            Anonymisierung verwalten
          </a>
        </div>
      </Card>
    </div>
  </div>
</section>

<style>
  .right-stack {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* ── Audit card (timeline container) ── */
  :global(.audit-card) {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Filter bar inside the audit card ── */
  .audit-filter-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
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

  /* Phase 39 (UI-15) — multiple 160px selects + count overflow at 390px.
     Drop selects to full-width and let the count claim its own row. */
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
    transition: background-color 160ms var(--ease);
  }

  .audit-row:last-child {
    border-bottom: none;
  }

  .audit-row.is-expanded {
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    padding-left: 8px;
    padding-right: 8px;
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

  .audit-toggle {
    padding: 2px 8px;
    font-size: 11px;
    min-height: 0;
  }

  .audit-toggle-spacer {
    width: 28px;
    display: inline-block;
  }

  /* ── Expanded detail block ── */
  .audit-detail {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 12px 0 4px;
  }

  .audit-detail-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin: 0 0 6px;
  }

  .audit-detail-pre {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 10px 12px;
    margin: 0;
    overflow-x: auto;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text);
    max-height: 220px;
  }

  /* ── Empty / skeleton state ── */
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

  .audit-empty {
    padding: 36px 16px;
    text-align: center;
    color: var(--text-muted);
  }

  .audit-empty-title {
    font-family: var(--font-serif);
    font-size: 18px;
    font-weight: 400;
    color: var(--text);
    margin: 0 0 6px;
  }

  .audit-empty-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }

  .audit-pagination {
    margin-top: 8px;
  }

  /* ── Right-rail field controls (retention card) ── */
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

  .audit-card-body-text {
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

  /* ── Responsive: collapse the dense timeline row on narrow screens ── */
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
    .audit-detail {
      grid-template-columns: 1fr;
    }
  }
</style>
