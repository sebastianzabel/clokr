<script lang="ts" module>
  export interface DaySheetEntry {
    id: string;
    from: string;
    to: string;
    pause: string;
    net: string;
    salon?: string | null;
    /** Issue #853 (additive, Team › Zeiten): how the entry was recorded („Mobil“, „Manuell“ …). */
    source?: string | null;
    /** Issue #853 (additive): the entry's note or the reason it is invalid. */
    note?: string | null;
    /** Issue #853 (additive): `data-testid` of the entry's row. */
    testId?: string;
  }
</script>

<script lang="ts">
  // Issue #599 (Phase 851, prototype „Tagesdialog“): a day is read first, then edited. The sheet shows
  // Soll, Ist, Differenz and the day's entries without focusing any field; its one primary action is
  // handed in by the page (edit, add a time, or - in a closed month - ask for a correction). A closed
  // month is explained before anything is filled in, and a request already filed shows its status.
  import type { Snippet } from "svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import Note from "$components/ui/Note.svelte";
  import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";

  interface Props {
    open: boolean;
    title: string;
    subtitle?: string;
    sollMin: number | null;
    istMin: number;
    entries: DaySheetEntry[];
    /** A holiday, an absence or another reason the day carries. */
    reason?: string;
    locked: boolean;
    future: boolean;
    primaryLabel: string | null;
    /** False while the action has no target yet (the correction request before its API). */
    primaryEnabled?: boolean;
    onPrimary: () => void;
    /** Issue #599: the status of the person's correction request for this day, if any. */
    requestStatus?: { label: string; tone: "info" | "ok" | "bad"; note?: string | null } | null;
    /** Issue #853 (additive): renders an entry's salon cell (e.g. a trip „Nord → Süd“, #92). */
    entrySalon?: Snippet<[DaySheetEntry]>;
    /** Issue #853 (additive): the actions of one entry (edit, delete) for a manager's sheet. */
    entryActions?: Snippet<[DaySheetEntry]>;
    /** Issue #853 (additive): the findings of the server's day check for this day, worded by it. */
    findings?: string[];
    /** Issue #853 (additive): the closed-month text when the reader is not the person (a manager). */
    lockedText?: string;
    /** Issue #853 (additive): the 880 px size, for a sheet with source, note and actions. */
    wide?: boolean;
  }

  let {
    open = $bindable(),
    title,
    subtitle,
    sollMin,
    istMin,
    entries,
    reason,
    locked,
    future,
    primaryLabel,
    primaryEnabled = true,
    onPrimary,
    requestStatus = null,
    entrySalon,
    entryActions,
    findings = [],
    lockedText,
    wide = false,
  }: Props = $props();

  const showSalon = $derived(!!entrySalon || entries.some((e) => e.salon));
  const showSource = $derived(entries.some((e) => e.source));
  const showNote = $derived(entries.some((e) => e.note));

  const diff = $derived(sollMin === null ? null : istMin - sollMin);
</script>

<Dialog bind:open {title} ariaLabel={title} size={wide ? "wide" : "md"}>
  <div class="day-sheet" data-testid="day-sheet">
    {#if subtitle}<p class="day-sub">{subtitle}</p>{/if}
    {#if reason}
      <Note tone="info">{reason}</Note>
    {/if}
    {#each findings as finding (finding)}
      <Note tone="warn">{finding}</Note>
    {/each}
    {#if !future}
      <dl class="day-kv">
        <div>
          <dt>Soll</dt>
          <dd>{sollMin === null ? "–" : `${fmtMin(sollMin)} h`}</dd>
        </div>
        <div>
          <dt>Ist</dt>
          <dd>{fmtMin(istMin)} h</dd>
        </div>
        <div>
          <dt>Differenz</dt>
          <dd>{diff === null ? "–" : diff === 0 ? "±0:00" : fmtBalance(diff)}</dd>
        </div>
      </dl>
    {/if}
    {#if entries.length > 0}
      <table class="day-table">
        <caption class="sr-only">Einträge des Tages</caption>
        <thead>
          <tr
            ><th>Von</th><th>Bis</th><th>Pause</th><th>Netto</th>{#if showSalon}<th>Salon</th
              >{/if}{#if showSource}<th>Quelle</th>{/if}{#if showNote}<th>Notiz</th
              >{/if}{#if entryActions}<th><span class="sr-only">Aktionen</span></th>{/if}</tr
          >
        </thead>
        <tbody>
          {#each entries as e (e.id)}
            <tr data-testid={e.testId}>
              <td>{e.from}</td><td>{e.to}</td><td>{e.pause}</td><td>{e.net}</td>
              {#if showSalon}<td
                  >{#if entrySalon}{@render entrySalon(e)}{:else}{e.salon ?? "—"}{/if}</td
                >{/if}
              {#if showSource}<td>{e.source ?? "—"}</td>{/if}
              {#if showNote}<td class="day-note">{e.note ?? ""}</td>{/if}
              {#if entryActions}<td class="day-actions">{@render entryActions(e)}</td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if !future}
      <p class="day-sub">Für diesen Tag ist nichts erfasst.</p>
    {:else}
      <p class="day-sub">Dieser Tag liegt in der Zukunft. Gestempelt wird am Tag selbst.</p>
    {/if}
    {#if requestStatus}
      <div data-testid="day-sheet-request-status">
        <Note tone={requestStatus.tone}
          >{requestStatus.label}{#if requestStatus.note}: {requestStatus.note}{/if}</Note
        >
      </div>
    {/if}
    {#if locked && !requestStatus && lockedText}
      <Note tone="info">{lockedText}</Note>
    {:else if locked && !requestStatus}
      <Note tone="info"
        >Dieser Monat ist abgeschlossen. Eine Änderung geht als Korrekturanfrage an deine Leitung
        und wird als neuer Eintrag im laufenden Monat gebucht; der abgeschlossene Monat bleibt, wie
        er ist.</Note
      >
    {/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (open = false)}>Schließen</button
    >
    {#if primaryLabel}
      <button
        type="button"
        class="btn btn-primary"
        data-testid="day-sheet-primary"
        disabled={!primaryEnabled}
        onclick={() => {
          open = false;
          onPrimary();
        }}>{primaryLabel}</button
      >
    {/if}
  {/snippet}
</Dialog>

<style>
  .day-sheet {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .day-sub {
    margin: 0;
    color: var(--text-2);
  }
  .day-kv {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .day-kv dt {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .day-kv dd {
    margin: var(--s-1) 0 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .day-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .day-table th,
  .day-table td {
    text-align: left;
    padding: var(--s-2) var(--s-1);
    border-bottom: 1px solid var(--line);
  }
  .day-note {
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .day-actions {
    text-align: end;
    white-space: nowrap;
  }
  .day-table th {
    font-size: var(--fs-th);
    color: var(--text-2);
    font-weight: 500;
  }
</style>
