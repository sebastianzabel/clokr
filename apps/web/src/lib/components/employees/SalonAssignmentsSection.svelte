<!--
  SalonAssignmentsSection - the salon assignments of one employee (Issue #86, AC-86-5).

  Lists the full history from GET /employees/:id/salon-assignments: Stammsalon and Einsatzsalons,
  current and ended. The assignment DTO carries only the salon id, so names come from
  GET /salons?includeInactive=true (permission salon:read); a caller without it still sees the rows,
  with "Unbekannter Salon" and a neutral hint. Every rule stays on the server - this component shows
  its answers verbatim and never deletes a row (the API has no delete route).

  Props:
    employeeId - the employee whose assignments are shown
    canEdit    - the caller holds employee:update (UX only; the API enforces it)
-->
<script lang="ts">
  import { api } from "$api/client";
  import Section from "$lib/components/admin/Section.svelte";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import {
    assignmentRows,
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

  async function load() {
    const current = ++generation;
    loading = true;
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
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</Section>

<style>
  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
