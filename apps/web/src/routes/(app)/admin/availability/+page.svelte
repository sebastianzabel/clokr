<script lang="ts">
  // Phase 46 — Admin per-employee availability page.
  // ADMIN + MANAGER only (server enforces 403; client redirects EMPLOYEE to /availability).
  //
  // Differences vs MA page:
  // - Employee selector above content (instead of view-tabs).
  // - Both Wochenraster AND Einmaltermine rendered side-by-side (no tabs).
  // - Info banner explaining derived absences are read-only.
  // - PUT target: /api/v1/employees/{id}/availability.

  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import AvailabilityWeekGrid, {
    type RecurringEntry,
  } from "$lib/components/availability/AvailabilityWeekGrid.svelte";
  import AvailabilityOneOffList, {
    type OneOffEntry,
  } from "$lib/components/availability/AvailabilityOneOffList.svelte";

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
  }

  interface ApiAvailabilityEntry {
    id: string;
    employeeId: string;
    dayOfWeek: number | null;
    date: string | null;
    status: Status;
    note: string | null;
    validFrom: string;
    validUntil: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string | null;
  }

  interface AvailabilityListResponse {
    entries: ApiAvailabilityEntry[];
  }

  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  let employees = $state<Employee[]>([]);
  let selectedEmployeeId = $state<string>("");
  let recurringEntries = $state<RecurringEntry[]>([]);
  let oneOffEntries = $state<OneOffEntry[]>([]);
  let loading = $state(true);
  let loadingEntries = $state(false);
  let saving = $state(false);
  let lastSnapshot = $state("");

  const currentSnapshot = $derived(JSON.stringify({ r: recurringEntries, o: oneOffEntries }));

  const dirty = $derived(
    !!selectedEmployeeId && !loadingEntries && currentSnapshot !== lastSnapshot,
  );

  function applyEntries(api_entries: ApiAvailabilityEntry[]): void {
    const recurring: RecurringEntry[] = [];
    const oneoff: OneOffEntry[] = [];
    for (const e of api_entries) {
      if (e.dayOfWeek != null) {
        recurring.push({
          id: e.id,
          dayOfWeek: e.dayOfWeek,
          status: e.status,
          note: e.note,
          validFrom: e.validFrom?.slice(0, 10) ?? todayISO(),
          validUntil: e.validUntil ? e.validUntil.slice(0, 10) : null,
        });
      } else if (e.date != null) {
        oneoff.push({
          id: e.id,
          date: e.date.slice(0, 10),
          status: e.status,
          note: e.note,
          validFrom: e.validFrom?.slice(0, 10) ?? todayISO(),
          validUntil: e.validUntil ? e.validUntil.slice(0, 10) : null,
        });
      }
    }
    recurringEntries = recurring;
    oneOffEntries = oneoff;
    lastSnapshot = JSON.stringify({ r: recurringEntries, o: oneOffEntries });
  }

  async function loadEmployees(): Promise<void> {
    try {
      const list = await api.get<Employee[]>("/employees?limit=500");
      employees = list ?? [];
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Mitarbeiter konnten nicht geladen werden.";
      toasts.error(msg);
    } finally {
      loading = false;
    }
  }

  async function loadEntriesFor(empId: string): Promise<void> {
    if (!empId) {
      recurringEntries = [];
      oneOffEntries = [];
      lastSnapshot = "";
      return;
    }
    loadingEntries = true;
    try {
      const res = await api.get<AvailabilityListResponse>(`/employees/${empId}/availability`);
      applyEntries(res.entries ?? []);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Verfügbarkeit konnte nicht geladen werden.";
      toasts.error(msg);
    } finally {
      loadingEntries = false;
    }
  }

  // Reload entries whenever the employee selection changes.
  $effect(() => {
    void loadEntriesFor(selectedEmployeeId);
  });

  function buildPayload() {
    const recurring = recurringEntries.map((e) => ({
      dayOfWeek: e.dayOfWeek,
      date: null,
      status: e.status,
      note: e.note ?? null,
      validFrom: e.validFrom ?? todayISO(),
      validUntil: e.validUntil ?? null,
    }));
    const oneoff = oneOffEntries.map((e) => ({
      dayOfWeek: null,
      date: e.date,
      status: e.status,
      note: e.note ?? null,
      validFrom: e.validFrom ?? todayISO(),
      validUntil: e.validUntil ?? null,
    }));
    return { entries: [...recurring, ...oneoff] };
  }

  async function save(): Promise<void> {
    if (saving || !selectedEmployeeId) return;
    saving = true;
    try {
      const res = await api.put<AvailabilityListResponse>(
        `/employees/${selectedEmployeeId}/availability`,
        buildPayload(),
      );
      applyEntries(res.entries ?? []);
      toasts.success("Verfügbarkeit gespeichert.");
    } catch (err) {
      const fallback = "Die Verfügbarkeit konnte nicht gespeichert werden. Bitte erneut versuchen.";
      const msg = err instanceof ApiError && err.status < 500 ? err.message : fallback;
      toasts.error(msg);
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    // Client-side UX redirect — server still enforces 403.
    const role = $authStore.user?.role;
    if (role === "EMPLOYEE") {
      void goto("/availability");
      return;
    }
    void loadEmployees();
  });
</script>

<PageHead
  eyebrow="Administration"
  title="Verfügbarkeit verwalten"
  accent="Verfügbarkeit"
  sub="Wann können Mitarbeiter arbeiten? Urlaub und Abwesenheit werden automatisch berücksichtigt."
>
  {#snippet actions()}
    <button
      class="btn btn-primary btn-sm"
      disabled={!dirty || !selectedEmployeeId || saving}
      onclick={save}
    >
      {saving ? "Speichert…" : "Speichern"}
    </button>
  {/snippet}
</PageHead>

<section class="page">
  <div class="employee-selector card-animate">
    <label class="form-label" for="emp-select">Mitarbeiter</label>
    <select id="emp-select" class="form-input" bind:value={selectedEmployeeId} disabled={loading}>
      <option value="">Mitarbeiter auswählen…</option>
      {#each employees as e (e.id)}
        <option value={e.id}>{e.firstName} {e.lastName}</option>
      {/each}
    </select>
  </div>

  {#if selectedEmployeeId}
    <div class="alert alert-info" role="alert">
      <span aria-hidden="true">ℹ</span>
      <span
        >Urlaub und Abwesenheit werden automatisch als „nicht verfügbar" angezeigt — bitte direkt in
        der jeweiligen Quelle bearbeiten.</span
      >
    </div>

    <Card animate class="card-animate">
      <h2 class="av-section-title">Wochenraster</h2>
      <AvailabilityWeekGrid bind:entries={recurringEntries} disabled={loadingEntries} />
    </Card>

    <Card animate class="card-animate">
      <h2 class="av-section-title">Einmaltermine</h2>
      <AvailabilityOneOffList bind:entries={oneOffEntries} disabled={loadingEntries} />
    </Card>
  {:else}
    <Card animate class="card-animate">
      <div class="av-empty-state">
        <h3 class="av-empty-title">Mitarbeiter auswählen</h3>
        <p class="av-empty-body">
          Wähle oben einen Mitarbeiter, um dessen Verfügbarkeit anzuzeigen oder zu bearbeiten.
        </p>
      </div>
    </Card>
  {/if}
</section>

<style>
  .employee-selector {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-3) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    max-width: 480px;
  }

  .av-section-title {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 var(--s-3);
  }

  .av-empty-state {
    text-align: center;
    padding: var(--s-8) var(--s-4);
  }

  .av-empty-title {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text);
    margin: 0 0 var(--s-2);
  }

  .av-empty-body {
    color: var(--text-muted);
    max-width: 420px;
    margin: 0 auto;
    line-height: 1.5;
  }
</style>
