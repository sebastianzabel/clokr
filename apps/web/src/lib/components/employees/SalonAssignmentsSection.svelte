<!--
  SalonAssignmentsSection - the salon assignments of one employee (Issue #86, AC-86-5).

  Lists the full history from GET /employees/:id/salon-assignments: Stammsalon and Einsatzsalons,
  current and ended. The assignment DTO carries only the salon id, so names come from
  GET /salons?includeInactive=true (permission salon:read); a caller without it still sees the rows,
  with "Unbekannter Salon" and a neutral hint. Every rule (overlap, weekday conflict, month lock,
  hire date, inactive salon) stays on the server - this component shows its answers verbatim and
  never deletes a row (the API has no delete route). Each change carries an effective date, so it is
  a form group with its own button, never an instant save (docs/ADMIN_STRUCTURE.md 3.2.1).

  Props:
    employeeId - the employee whose assignments are shown
    canEdit    - the caller holds employee:update (UX only; the API enforces it)
-->
<script lang="ts">
  import { api } from "$api/client";
  import Section from "$lib/components/admin/Section.svelte";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import {
    WEEKDAY_OPTIONS,
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

  let rows = $derived(assignmentRows(assignments, salons, localCalendarDay()));
  let activeSalons = $derived(salons.filter((s) => s.isActive));

  // One form group open at a time: a new Einsatzsalon, a Stammsalon change, or the end of one row.
  type FormMode = "deployment" | "home" | "end" | null;
  let mode = $state<FormMode>(null);
  let formSalonId = $state("");
  let formValidFrom = $state("");
  let formValidUntil = $state("");
  let formWeekdays = $state<number[]>([]);
  let endTarget = $state<AssignmentRow | null>(null);
  let submitting = $state(false);
  let formError = $state("");

  let canSubmit = $derived(
    !submitting &&
      (mode === "end"
        ? formValidUntil !== ""
        : mode !== null && formSalonId !== "" && formValidFrom !== ""),
  );

  function openForm(next: "deployment" | "home") {
    mode = next;
    formSalonId = "";
    formValidFrom = localCalendarDay();
    formValidUntil = "";
    formWeekdays = [];
    endTarget = null;
    formError = "";
  }

  function openEnd(row: AssignmentRow) {
    mode = "end";
    endTarget = row;
    formValidUntil = "";
    formError = "";
  }

  function closeForm() {
    mode = null;
    endTarget = null;
    formError = "";
  }

  function toggleWeekday(value: number) {
    formWeekdays = formWeekdays.includes(value)
      ? formWeekdays.filter((d) => d !== value)
      : [...formWeekdays, value];
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
            validFrom: formValidFrom,
            validUntil: formValidUntil,
            weekdays: formWeekdays,
          }),
        );
      } else if (mode === "home") {
        await api.post(
          `${base}/home`,
          homeBody({ salonId: formSalonId, validFrom: formValidFrom }),
        );
      } else if (endTarget) {
        await api.post(`${base}/${endTarget.id}/end`, endBody(formValidUntil));
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

<Section
  title="Salonzuordnungen"
  sub="Stammsalon und Einsatzsalons; beendete Zuordnungen bleiben sichtbar."
>
  {#snippet actions()}
    {#if canEdit && activeSalons.length > 0}
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        data-testid="salon-assignment-add"
        disabled={submitting}
        onclick={() => openForm("deployment")}
      >
        Einsatzsalon hinzufügen
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        data-testid="salon-assignment-home"
        disabled={submitting}
        onclick={() => openForm("home")}
      >
        Stammsalon ändern
      </button>
    {/if}
  {/snippet}
  {#if loadError}
    <div class="callout error">{loadError}</div>
  {:else if loading}
    <p class="hint">Wird geladen…</p>
  {:else}
    {#if salonNamesUnavailable}
      <p class="hint" data-testid="salon-names-hint">
        Die Salonnamen sind für Sie nicht einsehbar; die Zuordnungen werden ohne Namen angezeigt.
      </p>
    {/if}
    {#if rows.length === 0}
      <p class="hint">Keine Salonzuordnung vorhanden.</p>
    {:else}
      <table class="data-table" data-testid="salon-assignments-table">
        <thead>
          <tr>
            <th scope="col">Art</th>
            <th scope="col">Salon</th>
            <th scope="col">Zeitraum</th>
            <th scope="col">Wochentage</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr data-testid="salon-assignment-row-{row.id}">
              <td>{row.kindLabel}</td>
              <td>{row.salonName}</td>
              <td>{row.periodLabel}</td>
              <td>{row.weekdaysLabel}</td>
              <td>
                {#if row.ended}<span class="badge badge-gray">beendet</span>{/if}
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
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if canEdit && mode !== null}
      <div class="assign-form" data-testid="salon-assignment-form">
        <h4 class="assign-form-title">
          {#if mode === "deployment"}Einsatzsalon hinzufügen
          {:else if mode === "home"}Stammsalon ändern
          {:else}Zuordnung beenden: {endTarget?.salonName}{/if}
        </h4>
        {#if formError}
          <div class="callout error" role="alert" data-testid="salon-assignment-error">
            {formError}
          </div>
        {/if}
        <div class="form-grid">
          {#if mode !== "end"}
            <div class="form-group">
              <label class="form-label" for="sa-salon">Salon</label>
              <select id="sa-salon" class="select" bind:value={formSalonId}>
                <option value="">Bitte wählen</option>
                {#each activeSalons as salon (salon.id)}
                  <option value={salon.id}>{salon.name}</option>
                {/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="sa-from">Gültig ab</label>
              <input id="sa-from" type="date" class="input" bind:value={formValidFrom} />
            </div>
          {/if}
          {#if mode === "deployment"}
            <div class="form-group">
              <label class="form-label" for="sa-until">Gültig bis (optional)</label>
              <input id="sa-until" type="date" class="input" bind:value={formValidUntil} />
            </div>
            <div class="form-group">
              <span class="form-label">Wochentage (optional)</span>
              <div class="weekday-chips" role="group" aria-label="Wochentage">
                {#each WEEKDAY_OPTIONS as day (day.value)}
                  <button
                    type="button"
                    class="wd-chip"
                    class:wd-chip--active={formWeekdays.includes(day.value)}
                    aria-pressed={formWeekdays.includes(day.value)}
                    data-testid="salon-assignment-weekday-{day.value}"
                    onclick={() => toggleWeekday(day.value)}>{day.label}</button
                  >
                {/each}
              </div>
              <p class="hint">Ohne Auswahl gilt die Zuordnung an allen Tagen.</p>
            </div>
          {/if}
          {#if mode === "end"}
            <div class="form-group">
              <label class="form-label" for="sa-end">Beendet zum</label>
              <input id="sa-end" type="date" class="input" bind:value={formValidUntil} />
            </div>
          {/if}
        </div>
        <div class="assign-form-actions">
          <button
            type="button"
            class="btn btn-ghost"
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
            {#if submitting}Wird gespeichert…
            {:else if mode === "deployment"}Zuordnen
            {:else if mode === "home"}Stammsalon speichern
            {:else}Beenden{/if}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</Section>

<style>
  .assign-form {
    margin-top: var(--s-4);
    padding-top: var(--s-4);
    border-top: 1px solid var(--border);
  }

  .assign-form-title {
    margin: 0 0 var(--s-3);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .assign-form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    margin-top: var(--s-3);
  }

  .weekday-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }

  .wd-chip {
    min-width: 40px;
    padding: var(--s-1) var(--s-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .wd-chip--active {
    border-color: var(--brand);
    background: var(--brand-soft);
    color: var(--brand);
  }

  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
