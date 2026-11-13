<!--
  SalonAssignmentsSection - the salon assignments of one employee (Issue #86, AC-86-5; rebuilt on
  the blocks of #843 in Issue #854).

  Lists the full history from GET /employees/:id/salon-assignments in a DataTable: Stammsalon and
  Einsatzsalons, current and ended. The assignment DTO carries only the salon id, so names come from
  GET /salons?includeInactive=true (permission salon:read); a caller without it still sees the rows,
  with "Unbekannter Salon" and a neutral hint. Every rule (overlap, weekday conflict, month lock,
  hire date, inactive salon) stays on the server - this component shows its answers verbatim and
  never deletes a row (the API has no delete route). Each change carries an effective date, so it
  is a form with its own button in a Dialog, never an instant save (docs/ADMIN_STRUCTURE.md 3.2.1):
  a new Einsatzsalon, a Stammsalon change, or the end of one row. A refusal keeps the dialog open
  with the server's text.

  Props:
    employeeId - the employee whose assignments are shown
    canEdit    - the caller holds employee:update (UX only; the API enforces it)
-->
<script lang="ts">
  import { api } from "$api/client";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import {
    assignmentRows,
    deploymentBody,
    endBody,
    homeBody,
    type AssignmentRow,
    type SalonAssignment,
    type SalonRef,
  } from "$lib/employees/salon-assignments";

  interface Props {
    employeeId: string;
    canEdit?: boolean;
  }

  let { employeeId, canEdit = false }: Props = $props();

  let assignments = $state<SalonAssignment[]>([]);
  let salons = $state<SalonRef[]>([]);
  let salonNamesUnavailable = $state(false);
  let loading = $state(true);
  let loadError = $state("");
  let generation = 0;

  const uid = $props.id();
  const titleId = `${uid}-title`;

  const columns: DataTableColumn[] = [
    { key: "salonName", label: "Salon", primary: true },
    { key: "kindLabel", label: "Art" },
    { key: "periodLabel", label: "Zeitraum" },
    { key: "weekdaysLabel", label: "Wochentage" },
    { key: "status", label: "Status" },
  ];

  type TableRow = AssignmentRow & Record<string, unknown>;
  let rows = $derived(
    assignmentRows(assignments, salons, localCalendarDay()).map((row): TableRow => ({ ...row })),
  );
  let activeSalons = $derived(salons.filter((s) => s.isActive));

  // One form at a time: a new Einsatzsalon, a Stammsalon change, or the end of one row.
  type FormMode = "deployment" | "home" | "end" | null;
  let mode = $state<FormMode>(null);
  let formOpen = $state(false);
  let formSalonId = $state("");
  let formValidFrom = $state<string | null>(null);
  let formValidUntil = $state<string | null>(null);
  let formWeekdays = $state<number[]>([]);
  let endTarget = $state<AssignmentRow | null>(null);
  let submitting = $state(false);
  let formError = $state("");

  let canSubmit = $derived(
    !submitting &&
      (mode === "end"
        ? Boolean(formValidUntil)
        : mode !== null && formSalonId !== "" && Boolean(formValidFrom)),
  );

  const dialogTitle = $derived(
    mode === "deployment"
      ? "Einsatzsalon hinzufügen"
      : mode === "home"
        ? "Stammsalon ändern"
        : `Zuordnung beenden: ${endTarget?.salonName ?? ""}`,
  );
  const submitLabel = $derived(
    mode === "deployment" ? "Zuordnen" : mode === "home" ? "Stammsalon speichern" : "Beenden",
  );

  function openForm(next: "deployment" | "home") {
    mode = next;
    formSalonId = "";
    formValidFrom = localCalendarDay();
    formValidUntil = null;
    formWeekdays = [];
    endTarget = null;
    formError = "";
    formOpen = true;
  }

  function openEnd(row: AssignmentRow) {
    mode = "end";
    endTarget = row;
    formValidUntil = null;
    formError = "";
    formOpen = true;
  }

  function closeForm() {
    formOpen = false;
    mode = null;
    endTarget = null;
    formError = "";
  }

  async function submit() {
    if (!canSubmit || mode === null) return;
    submitting = true;
    formError = "";
    const base = `/employees/${employeeId}/salon-assignments`;
    try {
      if (mode === "deployment") {
        await api.post(
          base,
          deploymentBody({
            salonId: formSalonId,
            validFrom: formValidFrom ?? "",
            validUntil: formValidUntil ?? "",
            weekdays: formWeekdays,
          }),
        );
      } else if (mode === "home") {
        await api.post(
          `${base}/home`,
          homeBody({ salonId: formSalonId, validFrom: formValidFrom ?? "" }),
        );
      } else if (endTarget) {
        await api.post(`${base}/${endTarget.id}/end`, endBody(formValidUntil ?? ""));
      }
      closeForm();
      await load(true);
    } catch (e: unknown) {
      // The server owns every rule; its German answer is shown as it came.
      formError = e instanceof Error ? e.message : "Die Änderung konnte nicht gespeichert werden.";
    } finally {
      submitting = false;
    }
  }

  async function load(keepRows = false) {
    const current = ++generation;
    if (!keepRows) loading = true;
    loadError = "";
    const [assignmentResult, salonResult] = await Promise.allSettled([
      api.get<{ assignments: SalonAssignment[] }>(`/employees/${employeeId}/salon-assignments`),
      api.get<{ salons: SalonRef[] }>("/salons?includeInactive=true"),
    ]);
    if (current !== generation) return;
    if (assignmentResult.status === "fulfilled") {
      assignments = assignmentResult.value.assignments;
    } else {
      assignments = [];
      const reason = assignmentResult.reason;
      loadError =
        reason instanceof Error ? reason.message : "Salonzuordnungen konnten nicht geladen werden.";
    }
    if (salonResult.status === "fulfilled") {
      salons = salonResult.value.salons;
      salonNamesUnavailable = false;
    } else {
      salons = [];
      salonNamesUnavailable = true;
    }
    loading = false;
  }

  $effect(() => {
    void employeeId;
    void load();
  });
</script>

<section class="settings-group" aria-labelledby={titleId}>
  <h2 class="settings-group-title" id={titleId}>Salonzuordnungen</h2>
  <p class="settings-group-desc">
    Stammsalon und Einsatzsalons; beendete Zuordnungen bleiben sichtbar.
  </p>

  {#if canEdit && activeSalons.length > 0}
    <div class="sa-actions">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="salon-assignment-add"
        disabled={submitting}
        onclick={() => openForm("deployment")}
      >
        Einsatzsalon hinzufügen
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="salon-assignment-home"
        disabled={submitting}
        onclick={() => openForm("home")}
      >
        Stammsalon ändern
      </button>
    </div>
  {/if}

  {#if loadError}
    <div role="alert"><Note tone="bad">{loadError}</Note></div>
  {:else if loading}
    <Skeleton shape="row" count={2} />
  {:else}
    {#if salonNamesUnavailable}
      <div data-testid="salon-names-hint">
        <Note tone="info">
          Die Salonnamen kannst du nicht einsehen; die Zuordnungen erscheinen ohne Namen.
        </Note>
      </div>
    {/if}
    {#if rows.length === 0}
      <EmptyState title="Keine Salonzuordnung vorhanden." />
    {:else}
      <div data-testid="salon-assignments-table">
        <DataTable
          {columns}
          {rows}
          rowKey={(row) => row.id}
          rowTestId={(row) => `salon-assignment-row-${row.id}`}
          caption="Salonzuordnungen der Person"
        >
          {#snippet cell(row, column)}
            {#if column.key === "status"}
              {#if row.ended}<Chip tone="neutral">beendet</Chip>{/if}
              {#if canEdit && row.canEnd}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  data-testid="salon-assignment-end-{row.id}"
                  disabled={submitting}
                  onclick={() => openEnd(row)}
                >
                  Beenden
                </button>
              {/if}
            {:else}
              {String(row[column.key] ?? "")}
            {/if}
          {/snippet}
        </DataTable>
      </div>
    {/if}
  {/if}
</section>

{#if canEdit}
  <Dialog
    bind:open={formOpen}
    title={dialogTitle}
    onOpenChange={(next) => {
      if (!next) closeForm();
    }}
  >
    <div class="sa-form" data-testid="salon-assignment-form">
      {#if formError}
        <div role="alert" data-testid="salon-assignment-error">
          <Note tone="bad">{formError}</Note>
        </div>
      {/if}

      {#if mode === "end"}
        <FormField label="Beendet zum" required>
          {#snippet field({ id, describedBy, invalid })}
            <DatePicker
              bind:value={formValidUntil}
              label="Beendet zum"
              {id}
              {describedBy}
              {invalid}
            />
          {/snippet}
        </FormField>
      {:else}
        <FormField label="Salon" required>
          {#snippet field({ id, describedBy })}
            <select {id} class="form-input" bind:value={formSalonId} aria-describedby={describedBy}>
              <option value="">Bitte wählen</option>
              {#each activeSalons as salon (salon.id)}
                <option value={salon.id}>{salon.name}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
        <FormField label="Gültig ab" required>
          {#snippet field({ id, describedBy, invalid })}
            <DatePicker bind:value={formValidFrom} label="Gültig ab" {id} {describedBy} {invalid} />
          {/snippet}
        </FormField>
        {#if mode === "deployment"}
          <FormField label="Gültig bis (optional)">
            {#snippet field({ id, describedBy, invalid })}
              <DatePicker
                bind:value={formValidUntil}
                label="Gültig bis"
                {id}
                {describedBy}
                {invalid}
              />
            {/snippet}
          </FormField>
          <WeekdayPicker
            bind:value={formWeekdays}
            legend="Wochentage (optional)"
            help="Ohne Auswahl gilt die Zuordnung an allen Tagen."
            testidPrefix="salon-assignment-weekday"
          />
        {/if}
      {/if}
    </div>

    {#snippet footer()}
      <button
        type="button"
        class="btn btn-secondary"
        disabled={submitting}
        onclick={closeForm}
        data-testid="salon-assignment-cancel"
      >
        Abbrechen
      </button>
      <button
        type="button"
        class="btn btn-primary"
        disabled={!canSubmit}
        onclick={submit}
        data-testid="salon-assignment-submit"
      >
        {#if submitting}<Spinner size={14} label="Wird gespeichert" />{/if}
        {submitLabel}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .sa-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .sa-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
