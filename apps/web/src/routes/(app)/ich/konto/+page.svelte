<script lang="ts">
  // Issue #594 / #598 (Phase 851, prototype v6 „Ich › Konto“): the own hours account with its
  // derivation month by month, the monthly records (Stundennachweis PDF) and the vacation account.
  // Every figure is an answer of its owning context - the live saldo and its split from
  // GET /overtime/:id (Arbeitszeitkonto, forecast wording from forecastLabel, #588), closed months
  // from their stored snapshots, open months from GET /overtime/month-saldo (the same chain as the
  // live saldo, #681), the vacation figures from GET /leave/entitlements (the one facade, #451). The
  // page sorts and labels; it computes no Soll and no saldo of its own.
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import { pageLabel } from "$lib/nav/page-labels";
  import PageHeader from "$components/ui/PageHeader.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";
  import { forecastLabel } from "$lib/saldo/forecast-label";
  import { mapVacationBalance, type VacationEntitlementRow } from "$lib/leave/vacation-balance";
  import {
    kontoDayRows,
    kontoMonthRows,
    openMonthsAfter,
    type KontoMonthRow,
    type MonthSaldoDay,
    type KontoSnapshot,
    type OpenMonthSaldo,
  } from "$lib/me/konto";
  import { downloadStundennachweis } from "$lib/me/stundennachweis";
  import { MONTH_STATUS_LABEL } from "$lib/saldo/month-status"; // Issue #598: one status wording

  interface OvertimeAnswer {
    balanceHours: number;
    confirmedMinutes?: number;
    openMonthMinutes?: number | null;
    hasClosedMonth?: boolean;
    unconfirmedMonths?: number | null;
  }

  interface MonthSaldoAnswer {
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    closed: boolean;
    days: MonthSaldoDay[];
  }

  interface OwnEmployee {
    hireDate: string;
  }

  const now = new Date();
  const today = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayLabel = yesterday.toLocaleDateString("de-DE", {
    day: "numeric",
    month: "numeric",
  });

  let loading = $state(true);
  let failed = $state(false);
  let overtime = $state<OvertimeAnswer | null>(null);
  let rows = $state<KontoMonthRow[]>([]);
  let hireDate = $state<Date | null>(null);
  let vacation = $state<ReturnType<typeof mapVacationBalance>>(null);
  let downloading = $state<string | null>(null);
  // Issue #594: the days of every fetched open month, and the month whose days are open.
  let monthDays = $state<Record<string, MonthSaldoDay[]>>({});
  let openMonthKey = $state<string | null>(null);
  const openMonth = $derived(rows.find((r) => r.key === openMonthKey) ?? null);
  const openDayRows = $derived(openMonthKey ? kontoDayRows(monthDays[openMonthKey] ?? []) : []);

  function toggleMonth(row: KontoMonthRow) {
    openMonthKey = openMonthKey === row.key ? null : row.key;
  }

  const employeeId = $derived($authStore.user?.employeeId ?? null);

  const totalMinutes = $derived(overtime ? Math.round(overtime.balanceHours * 60) : null);
  // The derivation reads from the start towards today (prototype); the records list stays newest first.
  const rowsAscending = $derived([...rows].reverse());
  const lastClosed = $derived(rows.find((r) => r.status === "CLOSED") ?? null);
  // A carry-over deadline is only news while it lies ahead.
  const carryDeadline = $derived(
    vacation?.carryOverDeadline && new Date(vacation.carryOverDeadline) >= now
      ? new Date(vacation.carryOverDeadline)
      : null,
  );
  const vacationRemaining = $derived(
    vacation ? vacation.total + vacation.carryOver - vacation.used : null,
  );

  const kpis = $derived<KpiItem[]>([
    {
      label: overtime
        ? `Stundenkonto · ${forecastLabel(overtime.unconfirmedMonths, overtime.hasClosedMonth)}`
        : "Stundenkonto",
      value: totalMinutes === null ? "–" : fmtBalance(totalMinutes),
      unit: "h",
      explanation: `Stand gestern, ${yesterdayLabel}`,
      deltaTone: totalMinutes !== null && totalMinutes < 0 ? "bad" : "neutral",
    },
    {
      label: "Davon bestätigt",
      value: overtime?.confirmedMinutes == null ? "–" : fmtBalance(overtime.confirmedMinutes),
      unit: "h",
      explanation: lastClosed
        ? `${lastClosed.label} abgeschlossen`
        : "noch kein Monat abgeschlossen",
    },
    {
      label: "Resturlaub",
      value: vacationRemaining === null ? "–" : vacationRemaining,
      unit: vacationRemaining === 1 ? "Tag" : "Tage",
      explanation: carryDeadline
        ? `Übertrag verfällt am ${carryDeadline.toLocaleDateString("de-DE")}`
        : `Urlaubsjahr ${today.year}`,
    },
  ]);

  const COLUMNS: DataTableColumn[] = [
    { key: "month", label: "Monat", primary: true },
    { key: "soll", label: "Soll", align: "end" },
    { key: "ist", label: "Ist", align: "end" },
    { key: "diff", label: "Differenz", align: "end" },
    { key: "stand", label: "Stand", align: "end" },
    { key: "status", label: "Status" },
  ];

  const DAY_COLUMNS: DataTableColumn[] = [
    { key: "day", label: "Tag", primary: true },
    { key: "soll", label: "Soll", align: "end" },
    { key: "ist", label: "Ist", align: "end" },
    { key: "diff", label: "Differenz", align: "end" },
    { key: "stand", label: "Stand", align: "end" },
  ];

  /** One tap to the day level (#594): the month in Ich › Zeiten shows every day with its difference. */
  function monthHref(row: KontoMonthRow): string {
    return `/ich/zeiten?date=${row.year}-${String(row.month).padStart(2, "0")}-01`;
  }

  function signed(min: number): string {
    return min === 0 ? "±0:00" : fmtBalance(min);
  }

  async function load() {
    const id = employeeId;
    if (!id) {
      loading = false;
      return;
    }
    loading = true;
    failed = false;
    try {
      const [ot, snaps, me, ent] = await Promise.all([
        api.get<OvertimeAnswer>(`/overtime/${id}`),
        api.get<KontoSnapshot[]>(`/overtime/snapshots/${id}`),
        api.get<OwnEmployee>(`/employees/${id}`).catch(() => null),
        api
          .get<VacationEntitlementRow[]>(`/leave/entitlements/${id}?year=${today.year}`)
          .catch(() => [] as VacationEntitlementRow[]),
      ]);
      overtime = ot;
      hireDate = me?.hireDate ? new Date(me.hireDate) : null;
      vacation = mapVacationBalance(ent.find((e) => e.typeCode === "VACATION"));

      const closed = kontoMonthRows(snaps, []);
      const newestClosed = closed[0] ? { year: closed[0].year, month: closed[0].month } : null;
      const first = hireDate
        ? { year: hireDate.getFullYear(), month: hireDate.getMonth() + 1 }
        : { year: today.year, month: 1 };
      const months = openMonthsAfter(newestClosed, first, today);
      const days: Record<string, MonthSaldoDay[]> = {};
      const open: OpenMonthSaldo[] = await Promise.all(
        months.map(async ({ year, month }) => {
          const r = await api.get<MonthSaldoAnswer>(
            `/overtime/month-saldo/${id}?year=${year}&month=${month}`,
          );
          const last = r.days.length > 0 ? r.days[r.days.length - 1] : null;
          days[`${year}-${String(month).padStart(2, "0")}`] = r.days;
          return {
            year,
            month,
            expectedMinutes: r.expectedMinutes,
            workedMinutes: r.workedMinutes,
            balanceMinutes: r.balanceMinutes,
            closed: r.closed,
            standMinutes: last ? last.cumulativeSaldoMinutes : null,
          };
        }),
      );
      monthDays = days;
      rows = kontoMonthRows(snaps, open);
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  async function download(row: KontoMonthRow) {
    if (!employeeId) return;
    downloading = row.key;
    try {
      await downloadStundennachweis(employeeId, row.year, row.month);
      toasts.success(`Stundennachweis ${row.label} heruntergeladen`);
    } catch (e) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "Der Stundennachweis ließ sich nicht erstellen. Bitte versuche es noch einmal.",
      );
    } finally {
      downloading = null;
    }
  }

  const statusTone = (s: KontoMonthRow["status"]) => (s === "CLOSED" ? "ok" : "info");

  onMount(load);
</script>

<svelte:head><title>{pageLabel("/ich/konto")} – Clokr</title></svelte:head>

<PageHeader
  title={pageLabel("/ich/konto")}
  subtitle="Stundenkonto, Urlaubskonto und deine Monatsnachweise"
/>

{#if loading}
  <Skeleton shape="card" lines={3} />
{:else if failed}
  <ErrorState
    message="Dein Konto ist gerade nicht erreichbar."
    hint="Bitte versuche es noch einmal."
    onRetry={load}
  />
{:else}
  <div class="konto" data-testid="konto-page">
    <KpiStrip band ariaLabel="Stundenkonto und Resturlaub" items={kpis} />

    {#if hireDate && rows.length === 0}
      <Note tone="info"
        >Dein Konto beginnt am {hireDate.toLocaleDateString("de-DE")}. Sobald du Zeiten erfasst,
        siehst du hier, wie es sich zusammensetzt.</Note
      >
    {/if}

    <section class="konto-sec" aria-labelledby="konto-herleitung">
      <h2 id="konto-herleitung" class="konto-h2">So setzt sich dein Stundenkonto zusammen</h2>
      <DataTable
        caption="Herleitung des Stundenkontos nach Monaten"
        columns={COLUMNS}
        rows={rowsAscending}
        rowKey={(r) => r.key}
        rowTestId={(r) => `konto-month-${r.key}`}
      >
        {#snippet cell(row, column)}
          {#if column.key === "month"}
            <button
              type="button"
              class="konto-month-btn"
              aria-expanded={openMonthKey === row.key}
              aria-controls="konto-days"
              onclick={() => toggleMonth(row)}
              data-testid="konto-month-toggle-{row.key}">{row.label}</button
            >
          {:else if column.key === "soll"}
            {fmtMin(row.sollMinutes)}
          {:else if column.key === "ist"}
            {fmtMin(row.istMinutes)}
          {:else if column.key === "diff"}
            <span class:pos={row.diffMinutes > 0} class:neg={row.diffMinutes < 0}
              >{signed(row.diffMinutes)}</span
            >
          {:else if column.key === "stand"}
            <b>{row.standMinutes === null ? "—" : signed(row.standMinutes)}</b>
          {:else}
            <Chip tone={statusTone(row.status)}>{MONTH_STATUS_LABEL[row.status]}</Chip>
          {/if}
        {/snippet}
      </DataTable>
      {#if openMonth}
        <div id="konto-days" class="konto-days" data-testid="konto-days">
          <h3 class="konto-h3">Tage im {openMonth.label}</h3>
          {#if openMonth.status === "CLOSED"}
            <p class="konto-hint">
              Der Monat ist abgeschlossen; gespeichert sind seine Monatswerte. Die einzelnen Tage
              siehst du unter <a class="konto-link" href={monthHref(openMonth)}>Zeiten</a> und im Stundennachweis.
            </p>
          {:else if openDayRows.length === 0}
            <p class="konto-hint">
              In diesem Monat gibt es bis gestern keinen Tag mit Soll oder Zeit.
            </p>
          {:else}
            <DataTable
              caption="Tage im {openMonth.label}"
              columns={DAY_COLUMNS}
              rows={openDayRows}
              rowKey={(d) => d.date}
              rowTestId={(d) => `konto-day-${d.date}`}
            >
              {#snippet cell(day, column)}
                {#if column.key === "day"}
                  <a class="konto-link" href="/ich/zeiten?date={day.date}">{day.label}</a>
                {:else if column.key === "soll"}
                  {fmtMin(day.sollMinutes)}
                {:else if column.key === "ist"}
                  {fmtMin(day.istMinutes)}
                {:else if column.key === "diff"}
                  <span class:pos={day.diffMinutes > 0} class:neg={day.diffMinutes < 0}
                    >{signed(day.diffMinutes)}</span
                  >
                {:else}
                  {signed(day.standMinutes)}
                {/if}
              {/snippet}
            </DataTable>
          {/if}
        </div>
      {/if}
      {#if hireDate}
        <p class="konto-hint">Eintritt am {hireDate.toLocaleDateString("de-DE")}.</p>
      {/if}
      {#if totalMinutes !== null && totalMinutes > 0}
        <Note tone="info"
          >Plusstunden kannst du als freie Tage nehmen: beantrage dafür einen Überstundenausgleich
          unter <a class="konto-link" href="/ich/abwesenheiten">Abwesenheiten</a>.</Note
        >
      {/if}
      <p class="konto-hint">
        Tippe auf einen Monat, um seine Tage mit Soll, Ist und Differenz zu sehen. Das Stundenkonto
        zählt bis gestern; der heutige Tag kommt morgen dazu.
      </p>
    </section>

    <div class="konto-wrap">
      <div class="konto-grid">
        <div class="konto-col">
          <section class="konto-sec" aria-labelledby="konto-nachweise">
            <h2 id="konto-nachweise" class="konto-h2">Monatsnachweise</h2>
            {#if rows.length === 0}
              <p class="konto-hint">Noch kein Monat mit erfassten Zeiten.</p>
            {:else}
              <List ariaLabel="Monatsnachweise">
                {#each rows as row (row.key)}
                  <ListRow
                    avatar={false}
                    title={row.label}
                    subtitle={row.status === "CLOSED"
                      ? row.closedAt
                        ? `abgeschlossen am ${new Date(row.closedAt).toLocaleDateString("de-DE")}`
                        : "abgeschlossen"
                      : "vorläufig · ändert sich bis zum Abschluss"}
                  >
                    {#snippet trailing()}
                      <span class="konto-row-end">
                        <Chip tone={statusTone(row.status)}>{MONTH_STATUS_LABEL[row.status]}</Chip>
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          disabled={downloading === row.key}
                          onclick={() => download(row)}
                          aria-label="Stundennachweis {row.label} als PDF"
                        >
                          {#if downloading === row.key}<Spinner
                              size={14}
                              label="Wird erstellt"
                            />{/if}
                          PDF
                        </button>
                      </span>
                    {/snippet}
                  </ListRow>
                {/each}
              </List>
            {/if}
          </section>
        </div>

        <div class="konto-col">
          <section class="konto-sec" aria-labelledby="konto-urlaub">
            <h2 id="konto-urlaub" class="konto-h2">Urlaubskonto {today.year}</h2>
            {#if vacation}
              <dl class="ledger">
                <div class="ledger-row">
                  <dt>Jahresanspruch</dt>
                  <dd>{vacation.total} Tage</dd>
                </div>
                <div class="ledger-row">
                  <dt>Übertrag aus {today.year - 1}</dt>
                  <dd>{vacation.carryOver} Tage</dd>
                </div>
                <div class="ledger-row">
                  <dt>Genommen und genehmigt</dt>
                  <dd>− {vacation.used} Tage</dd>
                </div>
                <div class="ledger-row ledger-total">
                  <dt>Verbleibend</dt>
                  <dd>{vacationRemaining} Tage</dd>
                </div>
              </dl>
              {#if carryDeadline && vacation.carryOver > 0}
                <p class="konto-hint">
                  Der Übertrag verfällt am {carryDeadline.toLocaleDateString("de-DE")}, wenn du ihn
                  bis dahin nicht nimmst.
                </p>
              {/if}
            {:else}
              <p class="konto-hint">Für {today.year} ist noch kein Urlaubsanspruch hinterlegt.</p>
            {/if}
          </section>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .konto {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
  .konto-wrap {
    container-type: inline-size;
  }
  .konto-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-6);
  }
  @container (min-width: 760px) {
    .konto-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  .konto-col {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  .konto-sec {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .konto-h2 {
    font-size: var(--fs-h2);
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }
  .konto-hint {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .konto-link {
    color: var(--brand);
    text-decoration: none;
    font-weight: 500;
  }
  .konto-link:hover {
    text-decoration: underline;
  }
  /* Issue #594: the month opens its days in place; it reads like the link it replaces. */
  .konto-month-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-weight: 500;
    color: var(--brand);
    cursor: pointer;
    text-align: start;
  }
  .konto-month-btn::after {
    content: "";
    width: 6px;
    height: 6px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg) translateY(-2px);
    transition: transform 120ms var(--ease);
  }
  .konto-month-btn[aria-expanded="true"]::after {
    transform: rotate(-135deg) translate(-2px, 0);
  }
  .konto-month-btn:hover {
    text-decoration: underline;
  }
  .konto-month-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .konto-days {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .konto-h3 {
    font-size: var(--fs-base);
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }
  .konto-row-end {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  .pos {
    color: var(--ok);
  }
  .neg {
    color: var(--bad);
  }
  .ledger {
    margin: 0;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: var(--s-2) var(--s-4);
  }
  .ledger-row {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }
  .ledger-row:last-child {
    border-bottom: 0;
  }
  .ledger-row dt {
    color: var(--text-2);
  }
  .ledger-row dd {
    margin: 0;
  }
  .ledger-total dt,
  .ledger-total dd {
    color: var(--text);
    font-weight: 600;
  }
</style>
