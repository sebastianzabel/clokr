<!--
  WeekPatternsPanel - the „Wochenmuster“ tab of Verwalten › Regeln › Dienstplan (Issue #854, rebuilt
  on the blocks of #843; the data and the endpoint are those of the pre-#854 page, Phase 48).

  A recurring week per person with the working model „Nach Schichtplan“: one shift template (or none)
  for each weekday. The matrix is a form group with ONE SaveBar: nothing is written before „Muster
  speichern“, which sends one `PUT /employees/:id/shift-patterns` per changed person (seven days, valid
  from today). The baseline of a person moves only after THAT person's request succeeded, so a failed
  or partly failed save never clears the unsaved marker (T-109-24).

  The component reads nothing itself: the page loads the persons (`GET /shifts/week`) and the stored
  patterns (`GET /shift-patterns/tenant`) once and hands them in; the matrix state is taken from them
  at mount. `changes` (the number of changed persons) is bound by the page, which owns the one
  unsaved-changes registration of the route.

  Props:
    employees - the persons with the working model „Nach Schichtplan“ (sorted)
    patterns  - the stored pattern cells
    templates - the shift templates to choose from
    changes   - bindable, write-only: the number of persons with unsaved edits
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Note from "$components/ui/Note.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import {
    DAY_NAMES,
    DAY_NAMES_LONG,
    buildPatternMatrix,
    sollHintForDay,
    type PatternEmployee,
    type PatternMatrix,
    type PatternRow,
    type ShiftTemplate,
  } from "$lib/shifts/dienstplan-config";

  interface Props {
    employees: PatternEmployee[];
    patterns: PatternRow[];
    templates: ShiftTemplate[];
    changes?: number;
  }

  // `changes` is write-only here: the page reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { employees, patterns, templates, changes = $bindable(0) }: Props = $props();

  const DAYS = [0, 1, 2, 3, 4, 5, 6];

  // matrix[employeeId][0..6] = templateId | null; `baseline` mirrors the stored state.
  let matrix = $state<PatternMatrix>(untrack(() => buildPatternMatrix(employees, patterns)));
  let baseline = $state<PatternMatrix>(untrack(() => buildPatternMatrix(employees, patterns)));
  let saving = $state(false);

  function isCellDirty(employeeId: string, dow: number): boolean {
    return (matrix[employeeId]?.[dow] ?? null) !== (baseline[employeeId]?.[dow] ?? null);
  }
  function isRowDirty(employeeId: string): boolean {
    return DAYS.some((dow) => isCellDirty(employeeId, dow));
  }
  const dirtyCount = $derived(employees.filter((employee) => isRowDirty(employee.id)).length);

  $effect(() => {
    changes = dirtyCount;
  });

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Person", primary: true },
    ...DAYS.map((dow) => {
      const hint = sollHintForDay(employees, dow);
      return { key: `d${dow}`, label: hint ? `${DAY_NAMES[dow]} (${hint})` : DAY_NAMES[dow] };
    }),
  ]);

  type PersonRow = { id: string; name: string };
  const rows = $derived<PersonRow[]>(
    employees.map((employee) => ({
      id: employee.id,
      name: `${employee.lastName}, ${employee.firstName}`,
    })),
  );

  function choose(employeeId: string, dow: number, value: string) {
    const row = [...(matrix[employeeId] ?? Array(7).fill(null))];
    row[dow] = value === "" ? null : value;
    matrix = { ...matrix, [employeeId]: row };
  }

  async function saveBulkPatterns() {
    const todayIso = new Date().toISOString().slice(0, 10);
    const dirty = employees.filter((employee) => isRowDirty(employee.id));
    if (dirty.length === 0) return;
    saving = true;
    try {
      const results = await Promise.allSettled(
        dirty.map((employee) =>
          api.put(`/employees/${employee.id}/shift-patterns`, {
            patterns: DAYS.map((dow) => ({
              dayOfWeek: dow,
              templateId: matrix[employee.id]?.[dow] ?? null,
              validFrom: todayIso,
            })),
          }),
        ),
      );
      // The baseline moves only for a person whose request succeeded.
      const nextBaseline = { ...baseline };
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextBaseline[dirty[index].id] = [...(matrix[dirty[index].id] ?? Array(7).fill(null))];
        }
      });
      baseline = nextBaseline;
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      if (fail === 0) {
        toasts.success(`Wochenmuster gespeichert (${ok} ${ok === 1 ? "Person" : "Personen"}).`);
      } else if (ok === 0) {
        toasts.error(`Speichern fehlgeschlagen für alle ${fail} Personen.`);
      } else {
        toasts.error(`Teilweise gespeichert: ${ok} OK, ${fail} Fehler. Bitte erneut versuchen.`);
      }
    } finally {
      saving = false;
    }
  }

  function discard() {
    matrix = $state.snapshot(baseline);
  }
</script>

<section class="settings-group" aria-labelledby="dienstplan-muster-title">
  <h2 class="settings-group-title" id="dienstplan-muster-title">Wochenmuster</h2>
  <p class="settings-group-desc">
    Wiederkehrendes Wochenmuster je Person. Nur Mitarbeitende mit dem Arbeitszeitmodell „Nach
    Schichtplan“ erscheinen hier. Änderungen gelten erst, wenn du sie speicherst.
  </p>

  {#if employees.length === 0}
    <Note tone="info">
      Noch niemand arbeitet nach Schichtplan. Stell das Arbeitszeitmodell einer Person unter
      <a href="/verwalten/personen">Personen</a> auf „Nach Schichtplan“ um, damit sie hier erscheint.
    </Note>
  {:else}
    <DataTable
      {columns}
      {rows}
      rowKey={(row) => row.id}
      caption="Wochenmuster der Personen nach Schichtplan, eine Schichtvorlage je Wochentag"
    >
      {#snippet cell(row, column)}
        {#if column.key === "name"}
          {row.name}
        {:else}
          {@const dow = Number(column.key.slice(1))}
          <select
            class="form-input dp-select"
            class:dp-select--dirty={isCellDirty(row.id, dow)}
            value={matrix[row.id]?.[dow] ?? ""}
            onchange={(event) => choose(row.id, dow, event.currentTarget.value)}
            disabled={saving}
            aria-label="{row.name} {DAY_NAMES_LONG[dow]}"
          >
            <option value="">—</option>
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name}</option>
            {/each}
          </select>
        {/if}
      {/snippet}
    </DataTable>
    <SaveBar
      changes={dirtyCount}
      errors={0}
      {saving}
      saveLabel="Muster speichern"
      onSave={saveBulkPatterns}
      onDiscard={discard}
    />
  {/if}
</section>

<style>
  .dp-select {
    width: 100%;
    min-width: 7rem;
  }

  .dp-select--dirty {
    border-color: var(--brand);
    box-shadow: 0 0 0 1px var(--brand);
  }
</style>
