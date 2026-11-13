<script lang="ts">
  // Issue #597 (Phase 851, prototype „Nächste 14 Tage“): the own shifts of the next 14 days with their
  // salon, effective leave and the holidays of the Stammsalon in one stream. Reads GET /shifts/range
  // (own shifts, shift:read:EIGENE), GET /leave/requests (own) and GET /holidays (Stammsalon); the
  // grouping is lib/me/agenda.ts. The salon name comes from the own salon context; a salon outside it
  // is named „anderer Salon“.
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import Chip from "$components/ui/Chip.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import { fmtMin } from "$lib/utils/format-minutes";
  import { buildAgenda, type AgendaShift, type AgendaWeek } from "$lib/me/agenda";

  interface OwnRequest {
    typeCode: string | null;
    startDate: string;
    endDate: string;
    status: string;
    halfDay: boolean;
  }

  const LEAVE_LABEL: Record<string, string> = {
    VACATION: "Urlaub",
    OVERTIME_COMP: "Überstundenausgleich",
    SICK: "Krank",
    SICK_CHILD: "Kind krank",
  };

  const DAYS = 14;
  let loading = $state(true);
  let failed = $state(false);
  let weeks = $state<AgendaWeek[]>([]);

  function iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  async function load() {
    loading = true;
    failed = false;
    const start = new Date();
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + DAYS - 1);
    const homeSalonId = $salonContext.homeSalonId;
    const years = [...new Set([start.getFullYear(), end.getFullYear()])];
    try {
      const [shifts, requests, holidays] = await Promise.all([
        api.get<AgendaShift[]>(`/shifts/range?from=${iso(start)}&to=${iso(end)}`).catch(() => []),
        Promise.all(
          years.map((y) =>
            api.get<OwnRequest[]>(
              `/leave/requests?year=${y}&employeeId=${$authStore.user?.employeeId ?? ""}`,
            ),
          ),
        ).then((r) => r.flat()),
        homeSalonId
          ? Promise.all(
              years.map((y) =>
                api.get<{ date: string; name: string }[]>(
                  `/holidays?year=${y}&salonId=${homeSalonId}`,
                ),
              ),
            ).then((r) => r.flat())
          : Promise.resolve([] as { date: string; name: string }[]),
      ]);
      const names = new Map($salonContext.salons.map((s) => [s.id, s.name]));
      weeks = buildAgenda(start, DAYS, {
        shifts,
        leave: requests.map((r) => ({
          startDate: r.startDate,
          endDate: r.endDate,
          status: r.status,
          halfDay: r.halfDay,
          label: (r.typeCode && LEAVE_LABEL[r.typeCode]) ?? "Abwesend",
        })),
        holidays,
        homeSalonId,
        salonName: (id) => (id ? (names.get(id) ?? "anderer Salon") : ""),
      });
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  const empty = $derived(weeks.every((w) => w.days.every((d) => d.kind === "free")));

  onMount(load);
</script>

{#if loading}
  <Skeleton shape="row" count={6} />
{:else if failed}
  <ErrorState message="Dein Dienstplan ist gerade nicht erreichbar." onRetry={load} />
{:else}
  {#if empty}
    <EmptyState
      icon="calendar"
      title="Noch keine Schichten geplant"
      description="Sobald deine Salonleitung dich einplant, siehst du hier, wann und wo du arbeitest."
    />
  {/if}
  <div class="agenda" data-testid="my-shift-agenda">
    {#each weeks as week (week.label)}
      <h2 class="agenda-week">{week.label}</h2>
      <ul class="agenda-list">
        {#each week.days as day (day.date)}
          <li
            class="agenda-day"
            class:agenda-day--today={day.isToday}
            data-testid="agenda-{day.date}"
          >
            <div class="agenda-date">
              <span>{day.weekday}</span>
              <b>{day.dayLabel}</b>
            </div>
            <div class="agenda-text">
              <div class="agenda-title">{day.title}</div>
              {#if day.subtitle}<div class="agenda-sub">{day.subtitle}</div>{/if}
            </div>
            <div class="agenda-end">
              {#if day.otherSalon}
                <Chip tone="warn">anderer Salon</Chip>
              {:else if day.kind === "shift" && day.netMinutes > 0}
                <Chip tone="neutral">{fmtMin(day.netMinutes)} h</Chip>
              {:else if day.kind === "holiday"}
                <Chip tone="info">Feiertag</Chip>
              {:else if day.kind === "leave"}
                <Chip tone="brand">Abwesend</Chip>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/each}
  </div>
{/if}

<style>
  .agenda {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .agenda-week {
    margin: var(--s-4) 0 var(--s-1);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .agenda-week:first-child {
    margin-top: 0;
  }
  .agenda-list {
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }
  .agenda-day {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-3);
    min-height: var(--h-row);
    padding: var(--s-2) var(--s-4);
    border-bottom: 1px solid var(--line);
  }
  .agenda-day:last-child {
    border-bottom: 0;
  }
  .agenda-day--today {
    background: var(--brand-tint);
  }
  .agenda-date {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .agenda-date b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .agenda-title {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .agenda-sub {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
</style>
