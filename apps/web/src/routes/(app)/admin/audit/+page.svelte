<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";

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

  let logs: AuditLog[] = $state([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state("");

  let filterAction = $state("");
  let filterEntity = $state("");
  let page = $state(1);
  const LIMIT = 50;

  let totalPages = $derived(Math.ceil(total / LIMIT));

  const ACTIONS = ["LOGIN", "CREATE", "UPDATE", "DELETE", "EXPORT"];
  const ENTITIES = ["TimeEntry", "LeaveRequest", "Employee", "User", "OvertimeAccount", "Settings"];

  onMount(loadLogs);

  async function loadLogs() {
    loading = true;
    error = "";
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
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

  async function applyFilter() {
    page = 1;
    await loadLogs();
  }

  async function goPage(p: number) {
    page = p;
    await loadLogs();
  }

  function actionBadge(action: string): string {
    const map: Record<string, string> = {
      LOGIN:  "badge-blue",
      CREATE: "badge-green",
      UPDATE: "badge-yellow",
      DELETE: "badge-red",
      EXPORT: "badge-purple",
    };
    return map[action] ?? "badge-gray";
  }

  function fmtDate(iso: string): string {
    return format(new Date(iso), "dd.MM.yyyy HH:mm:ss", { locale: de });
  }

  let expandedId = $state<string | null>(null);
</script>

<svelte:head>
  <title>Audit Log – Clokr</title>
</svelte:head>

<div class="page-header-row" style="margin-bottom:1.5rem">
  <div>
    <h2 style="font-size:1.125rem;font-weight:600;">Audit Log</h2>
    <p class="text-muted" style="font-size:0.875rem;margin-top:0.125rem;">
      Alle sicherheitsrelevanten Aktionen im System
    </p>
  </div>
  <span class="badge badge-gray">{total.toLocaleString("de-DE")} Einträge</span>
</div>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<div class="filter-bar" style="margin-bottom:1.25rem">
  <select class="form-input filter-select" bind:value={filterAction} onchange={applyFilter} aria-label="Nach Aktion filtern">
    <option value="">Alle Aktionen</option>
    {#each ACTIONS as a}
      <option value={a}>{a}</option>
    {/each}
  </select>
  <select class="form-input filter-select" bind:value={filterEntity} onchange={applyFilter} aria-label="Nach Entität filtern">
    <option value="">Alle Entitäten</option>
    {#each ENTITIES as e}
      <option value={e}>{e}</option>
    {/each}
  </select>
  <span class="filter-count">{logs.length} von {total}</span>
</div>

{#if loading}
  <div class="card card-body" style="height:200px">
    <div class="skeleton" style="height:1.5rem;width:60%;margin-bottom:0.75rem"></div>
    <div class="skeleton" style="height:1.5rem;width:80%"></div>
  </div>
{:else if logs.length === 0}
  <div class="empty-state card card-body" style="text-align:center;padding:3rem 2rem">
    <span style="font-size:2.5rem">🔍</span>
    <h3 style="margin-top:0.75rem">Keine Einträge</h3>
    <p class="text-muted">Für die gewählten Filter wurden keine Audit-Einträge gefunden.</p>
  </div>
{:else}
  <div class="table-wrapper">
    <table class="data-table">
      <thead>
        <tr>
          <th>Zeitpunkt</th>
          <th>Benutzer</th>
          <th>Aktion</th>
          <th>Entität</th>
          <th>ID</th>
          <th>IP</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each logs as log}
          <tr class:row-expanded={expandedId === log.id}>
            <td class="font-mono" style="font-size:0.8125rem;white-space:nowrap">{fmtDate(log.createdAt)}</td>
            <td style="font-size:0.875rem">
              {#if log.user?.email}{log.user.email}{:else}<span class="text-muted">–</span>{/if}
            </td>
            <td><span class="badge {actionBadge(log.action)}">{log.action}</span></td>
            <td style="font-size:0.875rem">{log.entity}</td>
            <td class="font-mono text-muted" style="font-size:0.75rem">{log.entityId ? log.entityId.slice(0, 8) + "…" : "–"}</td>
            <td class="font-mono text-muted" style="font-size:0.75rem">{log.ipAddress ?? "–"}</td>
            <td>
              {#if log.oldValue !== null || log.newValue !== null}
                <button
                  class="btn btn-sm btn-ghost"
                  style="font-size:0.75rem;padding:0.2rem 0.5rem"
                  onclick={() => expandedId = expandedId === log.id ? null : log.id}
                  aria-expanded={expandedId === log.id}
                >
                  {expandedId === log.id ? "▲" : "▼"}
                </button>
              {/if}
            </td>
          </tr>
          {#if expandedId === log.id}
            <tr class="detail-row">
              <td colspan="7">
                <div class="detail-grid">
                  {#if log.oldValue !== null}
                    <div class="detail-block">
                      <p class="detail-label">Vorher</p>
                      <pre class="detail-pre">{JSON.stringify(log.oldValue, null, 2)}</pre>
                    </div>
                  {/if}
                  {#if log.newValue !== null}
                    <div class="detail-block">
                      <p class="detail-label">Nachher</p>
                      <pre class="detail-pre">{JSON.stringify(log.newValue, null, 2)}</pre>
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  {#if totalPages > 1}
    <div class="pagination">
      <button class="btn btn-sm btn-ghost" disabled={page <= 1} onclick={() => goPage(page - 1)}>
        ← Zurück
      </button>
      <span class="page-info">Seite {page} von {totalPages}</span>
      <button class="btn btn-sm btn-ghost" disabled={page >= totalPages} onclick={() => goPage(page + 1)}>
        Weiter →
      </button>
    </div>
  {/if}
{/if}

<style>
  .row-expanded td {
    background-color: var(--color-bg-subtle);
  }

  .detail-row td {
    padding: 0;
    background-color: var(--color-bg-subtle);
    border-bottom: 1px solid var(--color-border);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    padding: 1rem 1.25rem;
  }

  @media (max-width: 640px) {
    .detail-grid {
      grid-template-columns: 1fr;
    }
  }

  .detail-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    margin-bottom: 0.375rem;
  }

  .detail-pre {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text);
    max-height: 200px;
    overflow-y: auto;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 1.25rem;
  }

  .page-info {
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }
</style>
