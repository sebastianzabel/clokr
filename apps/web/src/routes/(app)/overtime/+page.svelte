<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";

  interface OvertimeTransaction {
    id: string;
    date: string;
    createdAt: string;
    type: string;
    hours: string;
    description: string | null;
  }

  interface OvertimeAccount {
    id: string;
    employeeId: string;
    balanceHours: string;
    status: "NORMAL" | "ELEVATED" | "CRITICAL";
    threshold: number;
    updatedAt: string;
    transactions: OvertimeTransaction[];
  }

  let account = $state<OvertimeAccount | null>(null);
  let loading = $state(false);
  let error = $state("");

  onMount(async () => {
    await loadData();
  });

  async function loadData() {
    loading = true;
    error = "";
    const employeeId = $authStore.user?.employeeId;
    if (!employeeId) {
      error = "Kein Benutzer angemeldet";
      loading = false;
      return;
    }
    try {
      account = await api.get<OvertimeAccount>(`/overtime/${employeeId}`);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  function balanceColor(balance: number): string {
    if (balance >= 60) return "text-red";
    if (balance >= 40) return "text-yellow";
    return "text-green";
  }

  function statusLabel(status: OvertimeAccount["status"]): string {
    return status === "CRITICAL" ? "Kritisch" :
           status === "ELEVATED" ? "Erhöht" : "Normal";
  }

  function statusBadge(status: OvertimeAccount["status"]): string {
    return status === "CRITICAL" ? "badge-red" :
           status === "ELEVATED" ? "badge-yellow" : "badge-green";
  }

  function hoursSign(hours: string): string {
    const val = parseFloat(hours);
    return val >= 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
  }

  function hoursColor(hours: string): string {
    const val = parseFloat(hours);
    return val > 0 ? "text-green" : val < 0 ? "text-red" : "";
  }

  function txTypeLabel(type: string): string {
    const map: Record<string, string> = {
      ACCRUAL: "Aufbau",
      REDUCTION: "Abbau",
      ADJUSTMENT: "Anpassung",
      PAYOUT: "Auszahlung",
    };
    return map[type] ?? type;
  }

  function formatDate(iso: string): string {
    return format(new Date(iso), "d. MMM yyyy", { locale: de });
  }

  let balance = $derived(account ? parseFloat(account.balanceHours) : 0);
  let isCritical = $derived(account?.status === "CRITICAL");

  // Filters
  let filterTxType = $state("");
  let filteredTransactions = $derived(
    account?.transactions.filter(tx => !filterTxType || tx.type === filterTxType) ?? []
  );
</script>

<svelte:head>
  <title>Überstundenkonto – Clokr</title>
</svelte:head>

<div class="page-header">
  <h1>Überstundenkonto</h1>
  <p>Ihr aktueller Überstundenstand und Verlauf</p>
</div>

{#if error}
  <div class="alert alert-error" role="alert">
    <span>⚠</span>
    <span>{error}</span>
  </div>
{:else if loading}
  <div class="balance-card card card-body skeleton-card">
    <div class="skeleton" style="height:3rem;width:8rem;margin-bottom:0.5rem;"></div>
    <div class="skeleton" style="height:1rem;width:5rem;"></div>
  </div>
{:else if account}
  <!-- Critical Banner -->
  {#if isCritical}
    <div class="alert alert-warning critical-banner" role="alert">
      <span style="font-size:1.25rem;">⚠️</span>
      <span>
        <strong>Überstunden kritisch.</strong>
        Bitte sprechen Sie mit Ihrem Vorgesetzten über einen Abbauplan.
      </span>
    </div>
  {/if}

  <!-- Balance Card -->
  <div class="balance-card card card-body">
    <div class="balance-main">
      <div class="balance-number {balanceColor(balance)}">
        {balance >= 0 ? "+" : ""}{balance.toFixed(1)}<span class="balance-unit">h</span>
      </div>
      <div class="balance-meta">
        <span class="badge {statusBadge(account.status)}">{statusLabel(account.status)}</span>
        <p class="balance-threshold text-muted">
          Schwellenwert: {account.threshold.toFixed(0)} Stunden
        </p>
      </div>
    </div>

    <div class="balance-bar-wrapper" aria-hidden="true">
      <div
        class="balance-bar"
        style="
          width: {Math.min(100, Math.abs(balance) / account.threshold * 100)}%;
          background-color: {balance >= 60 ? 'var(--color-red)' : balance >= 40 ? 'var(--color-yellow)' : 'var(--color-green)'};
        "
      ></div>
    </div>

    <p class="balance-updated text-muted">
      Zuletzt aktualisiert: {formatDate(account.updatedAt)}
    </p>
  </div>

  <!-- Transactions -->
  <div class="section-header">
    <h2>Verlauf</h2>
  </div>

  {#if account.transactions.length === 0}
    <div class="empty-state card card-body">
      <span class="empty-icon">⏱️</span>
      <h3>Keine Buchungen vorhanden</h3>
      <p class="text-muted">Es sind noch keine Überstundenbuchungen vorhanden.</p>
    </div>
  {:else}
    <div class="filter-bar">
      <select class="form-input filter-select" bind:value={filterTxType} aria-label="Nach Buchungsart filtern">
        <option value="">Alle Arten</option>
        <option value="ACCRUAL">Aufbau</option>
        <option value="REDUCTION">Abbau</option>
        <option value="ADJUSTMENT">Anpassung</option>
        <option value="PAYOUT">Auszahlung</option>
      </select>
      <span class="filter-count">{filteredTransactions.length} von {account.transactions.length}</span>
    </div>

    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Art</th>
            <th>Stunden</th>
            <th>Beschreibung</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredTransactions as tx}
            <tr>
              <td>{formatDate(tx.createdAt)}</td>
              <td>{txTypeLabel(tx.type)}</td>
              <td class="font-mono font-medium {hoursColor(tx.hours)}">
                {hoursSign(tx.hours)}h
              </td>
              <td class="text-muted">{tx.description ?? "–"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  .critical-banner {
    margin-bottom: 1.25rem;
  }

  .balance-card {
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .skeleton-card {
    min-height: 8rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .balance-main {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .balance-number {
    font-size: 3.5rem;
    font-weight: 700;
    font-family: var(--font-mono);
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .balance-unit {
    font-size: 2rem;
    font-weight: 600;
  }

  .balance-meta {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .balance-threshold {
    font-size: 0.875rem;
  }

  .balance-bar-wrapper {
    height: 6px;
    background-color: var(--gray-200);
    border-radius: 999px;
    overflow: hidden;
    max-width: 400px;
  }

  .balance-bar {
    height: 100%;
    border-radius: 999px;
    transition: width 0.4s ease;
  }

  .balance-updated {
    font-size: 0.8125rem;
  }

  .section-header {
    margin-bottom: 0.875rem;
  }

  .section-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
  }

  .empty-icon {
    font-size: 2.5rem;
    margin-bottom: 0.25rem;
  }

  .empty-state h3 {
    font-size: 1.0625rem;
  }
</style>
