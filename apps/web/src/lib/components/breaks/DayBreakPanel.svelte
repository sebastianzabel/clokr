<script lang="ts">
  /**
   * DayBreakPanel — Issue #80 (D-02, D-05, D-08, D-11).
   *
   * The action path for a multi-entry day. The validity of a break is a property of the DAY, not
   * of one entry: two entries in two salons can each be short and still add up to a § 4 ArbZG
   * violation, and the drive between the salons is working time, not a break. The panel shows the
   * server-computed day check (totals, finding), lets the employee record a break inside a gap
   * and delete a recorded one (both with a reason on delete, D-05/D-06), and offers the
   * acknowledgement of a cross-salon violation only where the server says the caller may (D-08).
   *
   * Everything shown comes from the server's `DayCheck`; the browser derives nothing. A REDACTED
   * check (D-11, the caller's reach covers only part of the day) renders totals and the finding
   * only plus a note — never a time, salon or id. Permission decisions come from the server
   * flags `mayAcknowledge` / `mayRecordDayBreak`; the routes enforce them independently.
   */
  import ReasonDialog from "$components/ui/ReasonDialog.svelte";
  import { dayCheckBadge, hoursDe, type DayCheck } from "$lib/breaks/day-break-violation";

  interface Props {
    check: DayCheck;
    /** Records a break inside a gap; times are "HH:MM" on the check's day. Throw to show an error. */
    onAddBreak?: (slot: { startLocal: string; endLocal: string }) => Promise<void>;
    onDeleteBreak?: (id: string, reason: string) => Promise<void>;
    onAcknowledge?: (reason: string) => Promise<void>;
    onRevoke?: (ackId: string, reason: string) => Promise<void>;
  }

  let { check, onAddBreak, onDeleteBreak, onAcknowledge, onRevoke }: Props = $props();

  type ReasonAction =
    { kind: "delete"; id: string } | { kind: "acknowledge" } | { kind: "revoke"; ackId: string };

  const badge = $derived(dayCheckBadge(check));
  const dayBreaks = $derived(check.dayBreaks ?? []);
  const isFull = $derived(check.detail === "full");
  // A day is shown for a cross-salon finding (open or acknowledged), a cross-salon § 3 breach or
  // as soon as a day break is recorded on it; anything else is the old single-entry behaviour.
  const visible = $derived(
    badge !== null || dayBreaks.length > 0 || (check.crossSalon && check.maxDailyExceeded),
  );
  const dayLabel = $derived(check.date.split("-").reverse().join("."));
  const totalsLine = $derived(
    `Insgesamt ${hoursDe(check.netWorkedMinutes)} h gearbeitet, ` +
      `${Math.round(check.totalBreakMinutes)} Min Pause erfasst ` +
      `(vorgeschrieben: ${check.requiredBreakMinutes} Min).`,
  );
  const canRecord = $derived(isFull && check.mayRecordDayBreak);
  const canAcknowledge = $derived(
    check.mayAcknowledge && !check.acknowledged && onAcknowledge !== undefined,
  );
  const canRevoke = $derived(
    check.mayAcknowledge &&
      check.acknowledged &&
      check.acknowledgement !== null &&
      onRevoke !== undefined,
  );

  function timeLabel(iso: string): string {
    return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  // ── Add-break form ────────────────────────────────────────────────────────
  let startLocal = $state("");
  let endLocal = $state("");
  let addError = $state("");
  let adding = $state(false);

  async function submitBreak(event: SubmitEvent) {
    event.preventDefault();
    addError = "";
    if (!startLocal || !endLocal) {
      addError = "Bitte Beginn und Ende der Pause angeben.";
      return;
    }
    if (endLocal <= startLocal) {
      addError = "Das Pausenende muss nach dem Pausenbeginn liegen.";
      return;
    }
    adding = true;
    try {
      await onAddBreak?.({ startLocal, endLocal });
      startLocal = "";
      endLocal = "";
    } catch (err) {
      addError = err instanceof Error ? err.message : "Die Pause konnte nicht gespeichert werden.";
    } finally {
      adding = false;
    }
  }

  // ── Reason dialog (one instance; the action decides title and handler) ───
  let dialogOpen = $state(false);
  let action = $state<ReasonAction | null>(null);

  function askReason(next: ReasonAction) {
    action = next;
    dialogOpen = true;
  }

  const dialogTitle = $derived(
    action?.kind === "delete"
      ? "Tagespause löschen?"
      : action?.kind === "revoke"
        ? "Quittung widerrufen?"
        : "Ohne ausreichende Pause durchgearbeitet bestätigen?",
  );
  const dialogDescription = $derived(
    action?.kind === "delete"
      ? "Die Pause wird nicht mehr gezählt. Der Eintrag bleibt zur Nachvollziehbarkeit gespeichert."
      : action?.kind === "revoke"
        ? "Der Pausenverstoß dieses Tages gilt danach wieder als offen."
        : "Die Quittung ersetzt keine Pause. Sie hält fest, dass der Tag ohne ausreichende Pause geleistet wurde.",
  );
  const dialogConfirmLabel = $derived(
    action?.kind === "delete" ? "Löschen" : action?.kind === "revoke" ? "Widerrufen" : "Quittieren",
  );

  async function confirmReason(reason: string) {
    const current = action;
    if (!current) return;
    if (current.kind === "delete") await onDeleteBreak?.(current.id, reason);
    else if (current.kind === "revoke") await onRevoke?.(current.ackId, reason);
    else await onAcknowledge?.(reason);
  }
</script>

{#if visible}
  <div class="callout dbp-panel" role="status" data-testid="day-break-panel">
    <span class="ico" aria-hidden="true">⚠</span>
    <div class="dbp-body">
      <p class="dbp-head">
        <b>{dayLabel}</b>
        {#if badge}<span class="badge {badge.cls}">{badge.label}</span>{/if}
      </p>

      <p>
        An diesem Tag sind Zeiten in mehreren Salons erfasst. Die Pause nach § 4 ArbZG gilt für den
        ganzen Arbeitstag. Fahrzeit zwischen zwei Salons ist Arbeitszeit und zählt nicht als Pause.
      </p>
      <p class="dbp-totals">{totalsLine}</p>
      {#if check.maxDailyExceeded}
        <p>Die Tagessumme liegt über der Höchstarbeitszeit von 10 Stunden (§ 3 ArbZG).</p>
      {/if}

      {#if isFull}
        <ul class="dbp-list" aria-label="Einträge und Lücken des Tages">
          {#each check.entries ?? [] as entry (entry.id)}
            <li data-testid="day-break-entry">
              Eintrag {timeLabel(entry.startTime)}–{timeLabel(entry.endTime)}
            </li>
          {/each}
          {#each check.gaps ?? [] as gap (gap.startTime)}
            <li data-testid="day-break-gap">
              Lücke {timeLabel(gap.startTime)}–{timeLabel(gap.endTime)}{gap.crossSalon
                ? " (Wechsel zwischen Salons)"
                : ""}, {gap.countsAsBreak ? "zählt als Pause" : "zählt nicht als Pause"}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="dbp-note">
          Einträge außerhalb des eigenen Zuständigkeitsbereichs werden nicht angezeigt.
        </p>
      {/if}

      {#if dayBreaks.length > 0}
        <ul class="dbp-list" aria-label="Erfasste Tagespausen">
          {#each dayBreaks as dayBreak (dayBreak.id)}
            <li class="dbp-break">
              <span>Tagespause {timeLabel(dayBreak.startTime)}–{timeLabel(dayBreak.endTime)}</span>
              {#if canRecord && onDeleteBreak}
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  data-testid={`day-break-delete-${dayBreak.id}`}
                  onclick={() => askReason({ kind: "delete", id: dayBreak.id })}
                >
                  Pause löschen
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if canRecord && onAddBreak}
        <form class="dbp-form" onsubmit={submitBreak}>
          <label class="dbp-field">
            <span class="form-label">Pause von</span>
            <input class="form-input" type="time" bind:value={startLocal} />
          </label>
          <label class="dbp-field">
            <span class="form-label">Pause bis</span>
            <input class="form-input" type="time" bind:value={endLocal} />
          </label>
          <button
            type="submit"
            class="btn btn-sm btn-primary"
            data-testid="day-break-add"
            disabled={adding}
          >
            Pause eintragen
          </button>
        </form>
        {#if addError}
          <p class="dbp-error" role="alert">{addError}</p>
        {/if}
      {/if}

      {#if canAcknowledge}
        <div class="dbp-actions">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            data-testid="day-break-ack"
            onclick={() => askReason({ kind: "acknowledge" })}
          >
            Als „durchgearbeitet“ quittieren
          </button>
        </div>
      {/if}
      {#if canRevoke && check.acknowledgement}
        {@const ackId = check.acknowledgement.id}
        <div class="dbp-actions">
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            data-testid="day-break-revoke"
            onclick={() => askReason({ kind: "revoke", ackId })}
          >
            Quittung widerrufen
          </button>
        </div>
      {/if}
    </div>
  </div>

  <ReasonDialog
    bind:open={dialogOpen}
    title={dialogTitle}
    description={dialogDescription}
    confirmLabel={dialogConfirmLabel}
    danger={action?.kind === "delete"}
    onConfirm={confirmReason}
  />
{/if}

<style>
  /* Colour comes from the global .callout / .badge recipes (app.css) — only layout here. */
  .dbp-panel {
    margin-bottom: 1rem;
  }
  .dbp-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .dbp-body p {
    margin: 0;
  }
  .dbp-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .dbp-list {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .dbp-break {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .dbp-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem;
  }
  .dbp-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .dbp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .dbp-error {
    color: var(--bad);
    font-size: 13px;
  }

  /* 384 px: every control gets a full 44 px touch target and the form stacks. */
  @media (max-width: 640px) {
    .dbp-body button,
    .dbp-body :global(.form-input) {
      min-height: 44px;
    }
    .dbp-field {
      flex: 1 1 100%;
    }
  }
</style>
