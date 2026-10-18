<script lang="ts">
  // Issue #612 (ADD-1, owner decision 1, UI-SPEC "Tab Heute") - the former „Heutige Anwesenheit“
  // card of /reports, moved here unchanged in content: status chips, the table with the words of
  // the one status vocabulary (#587), the two action links of a „Fehlt“ row, the salon badge
  // (#542) and the pagination. Only the sub title is new: today's state has no period. The page
  // loads the data (and wires the salon); this component renders what it is given.
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte"; // Issue #542
  import { DAY_STATUS_LABEL, attendanceStatusText } from "$lib/dashboard/day-status-label"; // Issue #587
  import { teamDayHref, teamLeaveCreateHref } from "$lib/dashboard/team-day-links"; // Issue #587
  import type { TodayAttendanceData, TodayEmployee } from "$lib/reports/today-attendance";

  interface Props {
    /** The answer of `GET /dashboard/today-attendance`; null until the first one. */
    attendance: TodayAttendanceData | null;
    loading: boolean;
    /** The load failed (the server's or a generic message); empty when it did not. */
    error: string;
    /** The server answered the one 404 for the chosen salon. */
    rejected: boolean;
    // Issue #587 (D-587-4): the two action links of a „Fehlt“ row; the target pages and the API
    // enforce their own rules, these only decide whether the link is offered.
    canAddTeamEntry: boolean;
    canRecordTeamAbsence: boolean;
  }

  let { attendance, loading, error, rejected, canAddTeamEntry, canRecordTeamAbsence }: Props =
    $props();

  const showAttendanceActions = $derived(canAddTeamEntry || canRecordTeamAbsence);

  let todayPage = $state(1);
  let todayPageSize = $state(10);
  const pagedTodayRows = $derived(
    (attendance?.employees ?? []).slice((todayPage - 1) * todayPageSize, todayPage * todayPageSize),
  );

  // A new list returns to page 1.
  $effect(() => {
    void attendance?.employees?.length;
    todayPage = 1;
  });

  function statusClass(status: TodayEmployee["status"]): string {
    return `status-badge status-${status.replace("_", "-")}`;
  }
</script>

<Card animate class="widget-card" style="--card-idx: 1;">
  <CardHeader title="Heutige Anwesenheit" sub="Stand heute, unabhängig vom Zeitraum">
    {#snippet actions()}
      {#if attendance}
        <span class="section-date">{attendance.date}</span>
      {/if}
    {/snippet}
  </CardHeader>

  {#if loading}
    <p class="section-placeholder">Lade Anwesenheit…</p>
  {:else if rejected}
    <SalonScopeLabel label={null} rejected={true} />
  {:else if error}
    <p class="section-error">{error}</p>
  {:else if attendance}
    <div class="attendance-summary">
      <div class="summary-chip">
        <span class="label">Anwesend</span>
        <span class="value">{attendance.summary.present}</span>
      </div>
      <div class="summary-chip">
        <span class="label">Eingestempelt</span>
        <span class="value">{attendance.summary.clockedIn}</span>
      </div>
      <div class="summary-chip">
        <span class="label">Abwesend</span>
        <span class="value">{attendance.summary.absent}</span>
      </div>
      <div class="summary-chip">
        <span class="label">{DAY_STATUS_LABEL.missing}</span>
        <span class="value">{attendance.summary.missing}</span>
      </div>
      {#if attendance.summary.holiday > 0}
        <div class="summary-chip">
          <span class="label">Feiertag</span>
          <span class="value">{attendance.summary.holiday}</span>
        </div>
      {/if}
    </div>

    <div class="table-wrap">
      <table class="attendance-table">
        <thead>
          <tr>
            <th>Mitarbeiter</th>
            <th>Nr.</th>
            <th>Status</th>
            {#if showAttendanceActions}
              <th>Aktionen</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each pagedTodayRows as row (row.id)}
            <tr>
              <td>{row.name}</td>
              <td>{row.employeeNumber}</td>
              <td
                ><span class={statusClass(row.status)}>{attendanceStatusText(row)}</span>
                {#if row.workedElsewhere}
                  <span class="badge badge-gray" title="In einem anderen Salon gearbeitet"
                    >anderer Salon</span
                  >
                {/if}</td
              >
              {#if showAttendanceActions}
                <td class="attendance-actions">
                  <div class="row-actions__group">
                    {#if row.status === "missing"}
                      {@const entryHref = teamDayHref(row.id, attendance.date)}
                      {@const absenceHref = teamLeaveCreateHref(row.id, attendance.date)}
                      {#if canAddTeamEntry && entryHref !== null}
                        <a class="btn btn-ghost xs" href={entryHref}>Eintrag nachtragen</a>
                      {/if}
                      {#if canRecordTeamAbsence && absenceHref !== null}
                        <a class="btn btn-ghost xs" href={absenceHref}>Abwesenheit erfassen</a>
                      {/if}
                    {/if}
                  </div>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <Pagination
      total={attendance.employees.length}
      bind:page={todayPage}
      bind:pageSize={todayPageSize}
    />
  {/if}
</Card>

<style>
  .section-date {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .section-placeholder,
  .section-error {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  .section-error {
    color: var(--bad);
  }

  .attendance-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .summary-chip {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-chip .label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .summary-chip .value {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .attendance-table th,
  .attendance-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .attendance-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .status-present,
  .status-clocked-in {
    background: var(--good-soft);
    color: var(--good);
  }

  .status-absent {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .status-holiday {
    background: var(--brand-soft);
    color: var(--brand);
  }

  .status-missing {
    background: var(--bad-soft);
    color: var(--bad);
  }

  .status-scheduled,
  .status-none {
    background: var(--bg-subtle);
    color: var(--text-muted);
  }

  .status-requested {
    background: var(--warn-soft);
    color: var(--warn);
  }

  /* Issue #587: the action cell of the attendance list; the flex layout lives on the inner
     .row-actions__group wrapper (Issue #442), never on the td itself, so the cell keeps
     display: table-cell and lines up with the rest of the row. */
  .attendance-actions {
    text-align: right;
    white-space: nowrap;
  }

  .row-actions__group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .attendance-summary {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
