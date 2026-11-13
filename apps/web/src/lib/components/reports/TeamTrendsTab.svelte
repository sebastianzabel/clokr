<script lang="ts">
  // Issue #895 (D-854-14) - the tab „Verläufe“ of Verwalten › Berichte: the three team trends of the
  // last six months (Arbeitsstunden, Überstunden-Trend, Krankheitstage) and the card „Salden“ (#588).
  // They used to sit on the start page of Team › Heute im Salon; #846 took them off it.
  //
  // Every chart is built by a builder of `$lib/dashboard/team-charts` (Issue #591, one way), the
  // figures come from the team endpoints unchanged and are summed nowhere here. A month column and
  // the „Bericht →“ link beside the title open the period report of that month(s) through
  // `periodSearch` (the builders write the URL), and only for a tab the caller may read - never a
  // dead link. The six months are a fixed window: this tab has no period of its own.
  //
  // The salon filter is the page's (`salonId`, from `salonPageFilter`). The saldo trend is a contract
  // figure that cannot be attributed to a salon, so under a filter it is not requested and a note
  // takes its place (D-05); a 403 of `/dashboard/overtime-trend` (no overtime:read) is a calm state.
  // The card „Salden“ receives the rows the page already loads for the exited section, in the same
  // salon filter, so there is no second request for them.
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import {
    Chart,
    BarController,
    LineController,
    BarElement,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
  } from "chart.js";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import TeamSaldoCard from "$lib/components/dashboard/TeamSaldoCard.svelte";
  import {
    TEAM_CHART_REPORT_TAB,
    TEAM_SALDO_TREND_CHART,
    TEAM_SICK_DAYS_CHART,
    reportMonthHref,
    reportPeriodHref,
    teamHoursChartConfig,
    teamHoursChartDescriptor,
    teamSaldoTrendChartConfig,
    teamSickDaysChartConfig,
  } from "$lib/dashboard/team-charts";
  import { teamPersonHref } from "$lib/dashboard/team-day-links";
  import {
    isTeamSalonRejected,
    overtimeTrendHours,
    teamTrendView,
    withSalonId,
    type OvertimeTrendResponse,
    type TeamTrendResponse,
    type TeamTrendView,
  } from "$lib/dashboard/team-view";
  import { mayOpenTeamPage } from "$lib/nav/team-nav";
  import { mayReadTeamSaldo, reportRights } from "$lib/page-rights";
  import type { PeriodTab } from "$lib/reports/period-state";
  import type { TeamSaldoRow } from "$lib/reports/team-saldo";
  import { chartAriaLabel, getChartTheme } from "$lib/utils/chart-theme";

  Chart.register(
    BarController,
    LineController,
    BarElement,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
  );

  interface Props {
    /** The page's salon filter (`salonPageFilter`), or null for every salon. */
    salonId: string | null;
    /** The salon context has loaded, so the first request is already filtered. */
    ready: boolean;
    /** The active rows of `GET /dashboard/overtime-overview`, in the page's salon filter. */
    saldoRows: TeamSaldoRow[];
    /** The loaded overview was narrowed to one salon (its own `salonId`), so the note matches the rows. */
    saldoFiltered: boolean;
    /** The overview is still on its way. */
    saldoLoading: boolean;
    /** The overview failed (the server's or a generic message); empty when it did not. */
    saldoError: string;
  }

  let { salonId, ready, saldoRows, saldoFiltered, saldoLoading, saldoError }: Props = $props();

  // ── What the caller may open ─────────────────────────────────────────────────
  const canSaldo = $derived(mayReadTeamSaldo($authStore.user));
  const reportTabs = $derived(reportRights($authStore.user).periodTabs);
  const canOpenTeamDay = $derived(mayOpenTeamPage("/team/time-entries", $authStore.user));

  /** The click handler of a month chart for this report tab, or null when the tab is not offered. */
  function monthOpener(tab: PeriodTab, shown: TeamTrendView): ((index: number) => void) | null {
    if (!reportTabs.includes(tab)) return null;
    return (index) => {
      const key = shown.months[index]?.month;
      const href = key ? reportMonthHref(key, tab) : null;
      if (href !== null) void goto(href);
    };
  }

  /** The keyboard path of a chart (P-591-06): the link to the report of its months, or null. */
  function reportLinkFor(tab: PeriodTab, shown: boolean): string | null {
    if (!shown || !reportTabs.includes(tab) || view === null) return null;
    return reportPeriodHref(
      view.months.map((m) => m.month),
      tab,
    );
  }

  // ── Loads ────────────────────────────────────────────────────────────────────
  // Raw state on purpose: chart.js writes into the data it draws (dataset metadata), and a deep
  // proxy would turn those writes into reruns of the chart effects that read them (an effect loop
  // that sent the page to the error boundary). Both are only ever replaced as a whole.
  let view = $state.raw<TeamTrendView | null>(null);
  let trend = $state.raw<OvertimeTrendResponse | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let rejected = $state(false);
  // Plain let: an older response never overwrites a newer one (not reactive on purpose).
  let generation = 0;

  async function load(filter: string | null): Promise<void> {
    const mine = ++generation;
    loading = true;
    failed = false;
    rejected = false;
    let nextView: TeamTrendView | null = null;
    let nextTrend: OvertimeTrendResponse | null = null;
    try {
      const resp = await api.get<TeamTrendResponse>(
        withSalonId("/dashboard/team-trend?months=6", filter),
      );
      if (mine !== generation) return;
      nextView = teamTrendView(resp);
      // D-05: the saldo is a contract figure of a person and cannot be attributed to a salon, so
      // under a filter the endpoint is not requested at all.
      if (filter === null && canSaldo) {
        try {
          nextTrend = await api.get<OvertimeTrendResponse>("/dashboard/overtime-trend");
        } catch (err) {
          // A 403 (no overtime:read) is expected and calm; any other failure is logged, the card
          // simply stays away.
          if (!(err instanceof ApiError && err.status === 403)) {
            console.error("Failed to load overtime trend:", err);
          }
        }
      }
      if (mine !== generation) return;
    } catch (err) {
      if (mine !== generation) return;
      if (filter !== null && isTeamSalonRejected(err)) {
        rejected = true;
      } else {
        failed = true;
        console.error("Failed to load team trend:", err);
      }
    }
    view = nextView;
    trend = nextTrend;
    loading = false;
  }

  $effect(() => {
    if (!ready) return;
    const filter = salonId;
    // `canSaldo` decides whether the saldo trend is requested; it is read inside the load.
    untrack(() => void load(filter));
  });

  // ── Charts ───────────────────────────────────────────────────────────────────
  let hoursEl = $state<HTMLCanvasElement | null>(null);
  let trendEl = $state<HTMLCanvasElement | null>(null);
  let sickEl = $state<HTMLCanvasElement | null>(null);

  const showTrendSection = $derived(
    loading || (view !== null && (view.trendNote !== null || trend !== null)),
  );
  const showTrendChart = $derived(
    !loading && view !== null && view.trendNote === null && trend !== null,
  );
  const hoursHref = $derived(reportLinkFor(TEAM_CHART_REPORT_TAB.hours, view !== null));
  const trendHref = $derived(reportLinkFor(TEAM_CHART_REPORT_TAB.saldoTrend, showTrendChart));
  const sickHref = $derived(reportLinkFor(TEAM_CHART_REPORT_TAB.sickDays, view !== null));

  $effect(() => {
    const el = hoursEl;
    const shown = view;
    if (el === null || shown === null) return;
    const chart = new Chart(
      el,
      teamHoursChartConfig(shown, getChartTheme(), monthOpener(TEAM_CHART_REPORT_TAB.hours, shown)),
    );
    return () => chart.destroy();
  });

  $effect(() => {
    const el = trendEl;
    const shown = view;
    const series = trend;
    if (el === null || shown === null || series === null) return;
    const chart = new Chart(
      el,
      teamSaldoTrendChartConfig(
        shown.months.map((m) => m.label),
        overtimeTrendHours(shown.months, series),
        getChartTheme(),
        monthOpener(TEAM_CHART_REPORT_TAB.saldoTrend, shown),
      ),
    );
    return () => chart.destroy();
  });

  $effect(() => {
    const el = sickEl;
    const shown = view;
    if (el === null || shown === null) return;
    const chart = new Chart(
      el,
      teamSickDaysChartConfig(
        shown,
        getChartTheme(),
        monthOpener(TEAM_CHART_REPORT_TAB.sickDays, shown),
      ),
    );
    return () => chart.destroy();
  });
</script>

{#snippet reportLink(href: string | null, label: string)}
  {#if href !== null}
    <a class="trend-link" {href} aria-label={label}>Bericht →</a>
  {/if}
{/snippet}

<div class="trends" data-testid="team-trends-tab">
  {#if rejected}
    <SalonScopeLabel label={null} rejected={true} />
  {:else if failed}
    <div data-testid="team-trends-error">
      <ErrorState
        message="Die Verläufe konnten nicht geladen werden. Prüf die Verbindung und versuch es noch einmal."
        hint=""
        retrying={loading}
        onRetry={() => void load(salonId)}
      />
    </div>
  {:else}
    <Note tone="info">
      Die Verläufe zeigen immer die letzten sechs Monate, unabhängig vom Zeitraum der anderen Tabs.
      Ein Klick auf einen Monat öffnet den Bericht dieses Monats.
    </Note>

    {#if canSaldo && saldoError !== ""}
      <Note tone="bad">{saldoError}</Note>
    {:else if canSaldo}
      <div class="trends-saldo" data-testid="team-trends-saldo">
        <TeamSaldoCard
          rows={saldoRows}
          loading={saldoLoading}
          salonFiltered={saldoFiltered}
          personHref={(id) => (canOpenTeamDay ? teamPersonHref(id) : null)}
          onOpenPerson={(href) => void goto(href)}
          cardIdx={1}
        />
      </div>
    {/if}

    <div class="trend-sections">
      <section class="settings-group" aria-labelledby="trend-hours-title">
        <div class="trend-head">
          <div class="trend-title">
            <h2 class="settings-group-title" id="trend-hours-title">Arbeitsstunden</h2>
            <p class="settings-group-desc">{view?.chartSub ?? "Letzte 6 Monate"}</p>
          </div>
          {@render reportLink(hoursHref, "Arbeitsstunden im Bericht öffnen")}
        </div>
        <div class="chart-wrap">
          {#if loading || view === null}
            <Skeleton shape="block" height="240px" />
          {:else}
            <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -- a chart canvas is a described image; chart-style-591 (G5) requires role="img" -->
            <canvas
              bind:this={hoursEl}
              role="img"
              aria-label={chartAriaLabel(teamHoursChartDescriptor(view))}
            ></canvas>
          {/if}
        </div>
        {#if view?.sollNote}
          <p class="settings-group-desc" data-testid="team-trends-soll-note">{view.sollNote}</p>
        {/if}
      </section>

      {#if showTrendSection}
        <section class="settings-group" aria-labelledby="trend-saldo-title">
          <div class="trend-head">
            <div class="trend-title">
              <h2 class="settings-group-title" id="trend-saldo-title">Überstunden-Trend</h2>
              <p class="settings-group-desc">Saldo-Verlauf</p>
            </div>
            {@render reportLink(trendHref, "Überstunden-Trend im Bericht öffnen")}
          </div>
          <div class="chart-wrap">
            {#if loading}
              <Skeleton shape="block" height="240px" />
            {:else if view?.trendNote}
              <Note tone="info">{view.trendNote}</Note>
            {:else if showTrendChart}
              <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -- a chart canvas is a described image; chart-style-591 (G5) requires role="img" -->
              <canvas
                bind:this={trendEl}
                role="img"
                aria-label={chartAriaLabel(TEAM_SALDO_TREND_CHART)}
              ></canvas>
            {/if}
          </div>
        </section>
      {/if}

      <section class="settings-group" aria-labelledby="trend-sick-title">
        <div class="trend-head">
          <div class="trend-title">
            <h2 class="settings-group-title" id="trend-sick-title">Krankheitstage</h2>
            <p class="settings-group-desc">Letzte 6 Monate</p>
          </div>
          {@render reportLink(sickHref, "Krankheitstage im Bericht öffnen")}
        </div>
        <div class="chart-wrap">
          {#if loading || view === null}
            <Skeleton shape="block" height="240px" />
          {:else}
            <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -- a chart canvas is a described image; chart-style-591 (G5) requires role="img" -->
            <canvas bind:this={sickEl} role="img" aria-label={chartAriaLabel(TEAM_SICK_DAYS_CHART)}
            ></canvas>
          {/if}
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .trends {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }

  /* The three sections are one block so the divider of `.settings-group + .settings-group` spaces
     them; the note and the saldo card are spaced by the flex gap of `.trends`. */
  .trend-sections {
    min-width: 0;
  }

  .trend-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-4);
  }

  /* Title and sub line stack with the group's own gap: the shared .settings-group-desc pulls itself up by
     that gap, so without it the sub line overlapped the title (#854 owner review). */
  .trend-title {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }

  .trend-link {
    font-size: var(--fs-sm);
    color: var(--brand);
    text-decoration: none;
    white-space: nowrap;
  }

  .trend-link:hover {
    text-decoration: underline;
  }

  /* chart.js sizes the canvas to this box; relative so its resize observer has a parent to read. */
  .chart-wrap {
    position: relative;
    height: 240px;
    min-width: 0;
  }
</style>
