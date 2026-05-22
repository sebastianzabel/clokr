<script lang="ts">
  // Phase 46 — MA-Self-Service availability page.
  // EMPLOYEE-only view: edit own recurring + one-off availability via
  // GET/PUT /api/v1/me/availability. Save sends the merged entries array
  // (REPLACE semantics on the API side — see availability.ts).

  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
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

  let view = $state<"recurring" | "oneoff">("recurring");
  let recurringEntries = $state<RecurringEntry[]>([]);
  let oneOffEntries = $state<OneOffEntry[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  // Tracks last-saved snapshot so we can compute the dirty flag without
  // wiring an explicit change-callback through every child component.
  let lastSnapshot = $state("");

  const currentSnapshot = $derived(JSON.stringify({ r: recurringEntries, o: oneOffEntries }));

  const dirty = $derived(!loading && currentSnapshot !== lastSnapshot);

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

  async function load(): Promise<void> {
    loading = true;
    try {
      const res = await api.get<AvailabilityListResponse>("/me/availability");
      applyEntries(res.entries ?? []);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Verfügbarkeit konnte nicht geladen werden.";
      toasts.error(msg);
    } finally {
      loading = false;
    }
  }

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
    if (saving) return;
    saving = true;
    try {
      const res = await api.put<AvailabilityListResponse>("/me/availability", buildPayload());
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

  onMount(load);
</script>

<PageHead
  eyebrow="Mein Bereich"
  title="Meine Verfügbarkeit"
  accent="Verfügbarkeit"
  sub="Trage ein, wann du arbeiten kannst, nicht kannst oder bevorzugst zu arbeiten."
>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm" disabled={!dirty || saving} onclick={save}>
      {saving ? "Speichert…" : "Speichern"}
    </button>
  {/snippet}
</PageHead>

<section class="page">
  <div class="view-tabs">
    <button
      type="button"
      class="view-tab"
      class:view-tab--active={view === "recurring"}
      onclick={() => (view = "recurring")}
    >
      Wochenraster
    </button>
    <button
      type="button"
      class="view-tab"
      class:view-tab--active={view === "oneoff"}
      onclick={() => (view = "oneoff")}
    >
      Einmaltermine
    </button>
  </div>

  {#if view === "recurring"}
    <Card animate class="card-animate">
      <AvailabilityWeekGrid bind:entries={recurringEntries} />
    </Card>
  {:else}
    <Card animate class="card-animate">
      <AvailabilityOneOffList bind:entries={oneOffEntries} />
    </Card>
  {/if}
</section>
