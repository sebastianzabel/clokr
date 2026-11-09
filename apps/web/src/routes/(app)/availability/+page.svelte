<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  // Phase 46 — MA-Self-Service availability page.
  // EMPLOYEE-only view: edit own recurring + one-off availability via
  // GET/PUT /api/v1/me/availability. Save sends the merged entries array
  // (REPLACE semantics on the API side — see availability.ts).

  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import PageHeader from "$components/ui/PageHeader.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import MyShiftAgenda from "$lib/components/me/MyShiftAgenda.svelte";
  import CalendarFeedDialog from "$lib/components/me/CalendarFeedDialog.svelte";
  import { loadCalendarFeed, type CalendarFeedState } from "$lib/me/calendar-feed";
  import { tenantFeatures } from "$stores/tenant-features";
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

  let view = $state<string>("plan");
  let recurringEntries = $state<RecurringEntry[]>([]);
  let oneOffEntries = $state<OneOffEntry[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  // Tracks last-saved snapshot so we can compute the dirty flag without
  // wiring an explicit change-callback through every child component.
  let lastSnapshot = $state("");

  const currentSnapshot = $derived(JSON.stringify({ r: recurringEntries, o: oneOffEntries }));

  const dirty = $derived(!loading && currentSnapshot !== lastSnapshot);

  // Issue #851 (D-851-03): the number of unsaved changes for the save bar. An entry is compared as a
  // whole; a changed entry counts once (added and removed pair up), an added or removed entry once.
  function countChanges(current: string, saved: string): number {
    if (current === saved || saved === "") return 0;
    const parse = (raw: string) => {
      const v = JSON.parse(raw) as { r: unknown[]; o: unknown[] };
      return [...v.r, ...v.o].map((e) => JSON.stringify(e));
    };
    const now = parse(current);
    const before = parse(saved);
    const added = now.filter((e) => !before.includes(e)).length;
    const removed = before.filter((e) => !now.includes(e)).length;
    return Math.max(added, removed, 1);
  }

  const changes = $derived(dirty ? countChanges(currentSnapshot, lastSnapshot) : 0);

  // Issue #597 (Phase 851, prototype): „Nächste 14 Tage“ first; the own availability is the second
  // tab, offered only while the tenant uses the availability system.
  const TABS = $derived([
    { value: "plan", label: "Nächste 14 Tage" },
    ...($tenantFeatures.availabilityEnabled
      ? [{ value: "verfuegbarkeit", label: "Meine Verfügbarkeit" }]
      : []),
  ]);
  let availabilityView = $state<"recurring" | "oneoff">("recurring");

  /** Verwerfen: back to the last saved state. */
  function discard(): void {
    const saved = JSON.parse(lastSnapshot) as { r: RecurringEntry[]; o: OneOffEntry[] };
    recurringEntries = saved.r;
    oneOffEntries = saved.o;
  }

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
      toasts.success("Verfügbarkeit gespeichert");
    } catch (err) {
      const fallback =
        "Die Verfügbarkeit ließ sich nicht speichern. Bitte versuche es noch einmal.";
      const msg = err instanceof ApiError && err.status < 500 ? err.message : fallback;
      toasts.error(msg);
    } finally {
      saving = false;
    }
  }

  onMount(load);

  // Issue #597 (prototype): „Kalender abonnieren“ in the head. Offered only while the API serves
  // the own feed (null = route absent, no person or no own read right); a failed read hides it.
  let feed = $state<CalendarFeedState | null>(null);
  let feedOpen = $state(false);
  onMount(() => {
    loadCalendarFeed()
      .then((s) => (feed = s))
      .catch(() => (feed = null));
  });
</script>

<PageHeader
  title={pageLabel("/availability")}
  subtitle="Wann und wo du arbeitest"
  tabs={TABS}
  bind:tab={view}
>
  {#snippet actions()}
    {#if feed}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={() => (feedOpen = true)}
        data-testid="calendar-feed-open">Kalender abonnieren</button
      >
    {/if}
  {/snippet}
  {#snippet panel(value)}
    {#if value === "plan"}
      <MyShiftAgenda />
    {:else if loading}
      <Skeleton shape="card" />
    {:else}
      <p class="availability-hint">
        Sag deiner Salonleitung, wann du arbeiten kannst, wann nicht und wann du lieber arbeitest.
        Deine Angaben siehst du hier, die Salonleitung bei der Planung.
      </p>
      <div class="availability-switch">
        <SegmentedControl
          options={[
            { value: "recurring", label: "Jede Woche" },
            { value: "oneoff", label: "Einzelne Tage" },
          ]}
          value={availabilityView}
          name="availability-view"
          ariaLabel="Art der Angabe"
          size="sm"
          onchange={(v) => (availabilityView = v === "oneoff" ? "oneoff" : "recurring")}
        />
      </div>
      {#if availabilityView === "recurring"}
        <Card animate class="card-animate availability-card">
          <AvailabilityWeekGrid bind:entries={recurringEntries} />
        </Card>
      {:else}
        <Card animate class="card-animate availability-card">
          <AvailabilityOneOffList bind:entries={oneOffEntries} />
        </Card>
      {/if}
    {/if}
  {/snippet}
</PageHeader>

{#if feed}
  <CalendarFeedDialog bind:open={feedOpen} {feed} onChange={(s) => (feed = s)} />
{/if}

<SaveBar
  {changes}
  errors={0}
  {saving}
  saveLabel="Verfügbarkeit speichern"
  onSave={save}
  onDiscard={discard}
/>

<style>
  .availability-hint {
    margin: 0 0 var(--s-3);
    color: var(--text-2);
  }
  .availability-switch {
    margin-bottom: var(--s-3);
  }
</style>
