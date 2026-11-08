<script lang="ts">
  /**
   * /leave/planung — the Urlaubsplanung (Issue #835, D-835-21/22/33), since Issue #840 (D-840-13/14/15)
   * a thin host of `LeavePlanningPanel` until 840-12 turns it into a redirect to the Planung tab.
   *
   * Presentation only: the host owns the header, the toolbar (period switcher and zoom) and the
   * salon pick; the panel asks the API for every read and write. The salon comes from the header
   * selection (`teamSalonViewSalon`, #82/#558; a `?salonId=` deep link only preselects a reachable
   * salon in it, WR-07), the API validates it against the caller's reach and answers one 404 for
   * every rejection. There is no second salon display on this page (D-840-14). A permission hint
   * (`hasPermission`) only chooses the panel mode and hides a button; the API refuses any action
   * without reach.
   */
  import { untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import LeaveToolbar from "$lib/components/leave/LeaveToolbar.svelte";
  import LeavePlanningPanel from "$lib/components/leave/LeavePlanningPanel.svelte";
  import { teamSalonViewSalon } from "$lib/dashboard/team-view";
  import { deepLinkSalon } from "$lib/leave-plan/deep-link";
  import { parseTeamLeaveState, teamLeaveSearch } from "$lib/leave/area-tabs";
  import { periodOf, shiftPeriod, type Zoom } from "$lib/leave/timeline-model";

  const ZOOMS: Zoom[] = ["jahr", "quartal", "monat"];

  function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const today = toLocalDateStr(new Date());

  // ── Salon, period and zoom (D-835-21/22, D-840-13) ─────────────────────────
  const contextLoaded = $derived($salonContext.loaded);
  const salonId = $derived(teamSalonViewSalon($salonContext));

  // The URL state is read in one place (`area-tabs`): `zoom` and `datum`, or a deep-linked `year`.
  const urlState = $derived(parseTeamLeaveState($page.url.searchParams, today));
  const period = $derived(periodOf(urlState.zoom, urlState.datum));

  function navigate(next: { zoom: Zoom; datum: string }) {
    const url = new URL($page.url);
    url.search = teamLeaveSearch({ ...urlState, tab: "planung", ...next });
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // ── Deep link (WR-07): the LEAVE_PLAN_OPENED notice links to `?salonId=…&year=…`. Once the salon
  // context is loaded, a salon the caller reaches is preselected in the header selection (the same
  // store every page reads), then the parameter is dropped from the URL; an unreachable id is
  // ignored. The API still validates the salon of every read. ────────────────────────────────────
  let deepLinkHandled = false;
  $effect(() => {
    if (!contextLoaded || deepLinkHandled) return;
    const param = $page.url.searchParams.get("salonId");
    untrack(() => {
      deepLinkHandled = true;
      if (param === null) return;
      const linked = deepLinkSalon(param, $salonContext);
      if (linked !== null) salonContext.setSelection(linked);
      const url = new URL($page.url);
      url.searchParams.delete("salonId");
      void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    });
  });

  // ── Mode and the manage dialog ─────────────────────────────────────────────
  // Presentation only: a holder of the manage permission works on the team planner, everybody else
  // on the personal one; the server decides what either may read and write.
  const mode = $derived(
    hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN") ? "team" : "own",
  );
  let canManage = $state(false);
  let manageOpen = $state(false);
</script>

<svelte:head>
  <title>Urlaubsplanung – Clokr</title>
</svelte:head>

<PageHead eyebrow="Abwesenheiten" title="Planung">
  {#snippet actions()}
    {#if canManage}
      <button
        type="button"
        class="btn btn-primary"
        data-testid="leave-plan-manage"
        onclick={() => (manageOpen = true)}
      >
        Planung verwalten
      </button>
    {/if}
  {/snippet}
</PageHead>

<LeaveToolbar
  ariaLabel="Planung"
  {period}
  zooms={ZOOMS}
  zoom={urlState.zoom}
  onZoomChange={(zoom) => navigate({ zoom, datum: urlState.datum })}
  onShift={(step) =>
    navigate({ zoom: urlState.zoom, datum: shiftPeriod(urlState.zoom, urlState.datum, step) })}
  onToday={() => navigate({ zoom: urlState.zoom, datum: today })}
  testIdPrefix="leave-plan-toolbar"
/>

{#if !contextLoaded}
  <div class="plan-state" role="status"><Spinner /> Urlaubsplanung wird geladen …</div>
{:else}
  <LeavePlanningPanel
    {mode}
    {salonId}
    {period}
    {today}
    bind:manageOpen
    onViewer={(viewer) => (canManage = viewer.canManage)}
    onWeekSelect={(monday) => navigate({ zoom: "quartal", datum: monday })}
  />
{/if}

<style>
  .plan-state {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-muted);
    padding: var(--s-4) 0;
  }
</style>
