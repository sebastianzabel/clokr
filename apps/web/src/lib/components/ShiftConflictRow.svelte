<script lang="ts">
  // Phase 67.2 Plan 05 — Reusable row for the /shifts/conflicts overview.
  //
  // Renders one soft-deleted (AUTO_BS_DAY_CLEANUP) or actively-flagged
  // (conflictsWithLeave=true) shift with employee name, date, time, status
  // badge, and a "Wiederherstellen" button. The parent page owns the restore
  // mutation — this component is purely presentational + emits the restore
  // request via `onRestore(id)`.

  interface ConflictShift {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    label: string | null;
    employee: { firstName: string; lastName: string };
    deletedAt: string | null;
    deletedReason: string | null;
    conflictsWithLeave: boolean;
  }

  interface Props {
    shift: ConflictShift;
    onRestore: (id: string) => void | Promise<void>;
    restoring?: boolean;
  }

  let { shift, onRestore, restoring = false }: Props = $props();

  // Status derivation: soft-deleted rows always have deletedAt; flagged rows
  // are alive but carry the conflictsWithLeave flag.
  let status = $derived(shift.deletedAt ? "Entfernt" : "Markiert");
  let statusModifier = $derived(
    shift.deletedAt ? "conflict-status--removed" : "conflict-status--flagged",
  );
</script>

<div class="conflict-row">
  <div class="conflict-date">{shift.date}</div>
  <div class="conflict-emp">{shift.employee.firstName} {shift.employee.lastName}</div>
  <div class="conflict-time">{shift.startTime}–{shift.endTime}</div>
  <div class="conflict-label">{shift.label ?? ""}</div>
  <div class="conflict-status {statusModifier}">{status}</div>
  <button
    type="button"
    class="btn btn-primary btn-sm conflict-restore"
    onclick={() => onRestore(shift.id)}
    disabled={restoring}
  >
    {restoring ? "Wird wiederhergestellt…" : "Wiederherstellen"}
  </button>
</div>

<style>
  .conflict-row {
    display: grid;
    grid-template-columns: 7rem 1fr 7rem 1fr 7rem auto;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    color: var(--text);
    font-size: 0.9375rem;
  }

  .conflict-date,
  .conflict-time {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .conflict-emp {
    font-weight: 600;
    color: var(--text);
  }

  .conflict-label {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .conflict-status {
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    font-size: 0.8125rem;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
  }

  .conflict-status--removed {
    background: color-mix(in oklab, var(--bad) 18%, transparent);
    color: var(--bad);
    border: 1px solid color-mix(in oklab, var(--bad) 40%, transparent);
  }

  .conflict-status--flagged {
    background: color-mix(in oklab, var(--warn) 18%, transparent);
    color: var(--warn);
    border: 1px solid color-mix(in oklab, var(--warn) 40%, transparent);
  }

  .conflict-restore {
    white-space: nowrap;
  }

  /* Mobile: collapse the 6-column grid into a stacked layout */
  @media (max-width: 720px) {
    .conflict-row {
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "date status"
        "emp emp"
        "time label"
        "restore restore";
      gap: var(--s-2);
    }
    .conflict-date {
      grid-area: date;
    }
    .conflict-status {
      grid-area: status;
    }
    .conflict-emp {
      grid-area: emp;
    }
    .conflict-time {
      grid-area: time;
    }
    .conflict-label {
      grid-area: label;
      text-align: right;
    }
    .conflict-restore {
      grid-area: restore;
      width: 100%;
    }
  }
</style>
