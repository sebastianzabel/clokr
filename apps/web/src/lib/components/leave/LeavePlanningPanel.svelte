<script lang="ts">
  /**
   * LeavePlanningPanel — Issue #840 (D-840-14/15/16/17/23, E-03). The #835 leave planner on the one
   * absence timeline, for both areas: `mode="team"` (Team → Planung) and `mode="own"` (Mein Bereich
   * → Planung, always read with `?view=own`, so every colleague row arrives masked as „abwesend“
   * and only the caller's own wishes are editable).
   *
   * Presentation only: the panel composes the planner building blocks and asks the API for every
   * read and write (`$lib/leave-plan/api`). The salon, the period and today come from the host. A
   * permission hint (`hasPermission`) only decides whether „Planung verwalten“ may be offered while
   * no plan exists yet; the API refuses every action without reach.
   *
   * The work surface carries no admin control: status, open, deadline and takeover live in
   * `ManagePlanDialog`, opened by the host through `manageOpen` only when `onViewer` reported
   * `canManage`. A non-manager sees the deadline as read-only text. All dialogs are mounted at the
   * root, outside every animated block (#570).
   */
  import { onMount, untrack } from "svelte";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import Card from "$components/ui/Card.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import LeaveLegend from "$lib/components/leave/LeaveLegend.svelte";
  import AbsenceTimeline from "$lib/components/leave/timeline/AbsenceTimeline.svelte";
  import LeavePlanWishList from "$lib/components/leave/LeavePlanWishList.svelte";
  import LeavePlanWishDialog from "$lib/components/leave/LeavePlanWishDialog.svelte";
  import LeavePlanTakeoverDialog from "$lib/components/leave/LeavePlanTakeoverDialog.svelte";
  import ManagePlanDialog from "$lib/components/leave/ManagePlanDialog.svelte";
  import { legendFrom } from "$lib/leave/leave-colors";
  import {
    plannerToTimeline,
    weekLoad,
    workdaySet,
    type Period,
    type TimelineBar,
  } from "$lib/leave/timeline-model";
  import { closedDaysFor } from "$lib/shifts/closed-days";
  import { isSalonFilterRejected } from "$lib/salons/page-scope";
  import { createWish, getPlan, listPlans, removeWish, updateWish } from "$lib/leave-plan/api";
  import { planErrorMessage } from "$lib/leave-plan/errors";
  import {
    ADD_WISH_LABEL,
    DAY_LOAD_HINT,
    DAY_LOAD_LABEL,
    planStatusLabel,
  } from "$lib/leave-plan/labels";
  import type {
    DayRange,
    LeavePlanListItem,
    PlannerPerson,
    PlannerReadDto,
    PlannerWish,
    WishInput,
  } from "$lib/leave-plan/types";

  interface Props {
    mode: "team" | "own";
    /** The one salon in view; `null` = none (no single salon is selected). */
    salonId: string | null;
    /** The host knows the chosen salon was rejected (the one 404); the panel also learns it itself. */
    salonRejected?: boolean;
    period: Period;
    /** Tenant-local today, `YYYY-MM-DD`; the panel reads no clock. */
    today: string;
    /** Opens „Planung verwalten“ (team mode only); the host sets it from its primary action. */
    manageOpen?: boolean;
    /** Reports whether „Planung verwalten“ may be offered (server value once a plan is loaded). */
    onViewer?: (viewer: { canManage: boolean }) => void;
    /** A click on a week cell of the Jahr zoom (the host may zoom into that week). */
    onWeekSelect?: (monday: string) => void;
  }

  let {
    mode,
    salonId,
    salonRejected = false,
    period,
    today,
    manageOpen = $bindable(false),
    onViewer,
    onWeekSelect,
  }: Props = $props();

  const year = $derived(period.year);

  // ── Plan state ─────────────────────────────────────────────────────────────
  let planData = $state<PlannerReadDto | null>(null);
  let loading = $state(false);
  let loadError = $state("");
  let forbidden = $state(false);
  let rejected = $state(false);

  // Plain let: an older answer never overwrites a newer one (not reactive on purpose).
  let loadSeq = 0;

  function pickPlan(plans: LeavePlanListItem[]): LeavePlanListItem | null {
    const open = plans.find((p) => p.status === "OPEN");
    if (open) return open;
    const taken = plans
      .filter((p) => p.status === "TAKEN_OVER")
      .sort((a, b) => (b.takenOverAt ?? b.openedAt).localeCompare(a.takenOverAt ?? a.openedAt));
    return taken[0] ?? null;
  }

  async function load(salon: string, forYear: number, silent = false) {
    const mine = ++loadSeq;
    if (!silent) loading = true;
    loadError = "";
    try {
      const plans = await listPlans(salon, forYear);
      const chosen = pickPlan(plans);
      // The personal planner always asks for the neutral reading (E-03, D-840-23).
      const data = chosen
        ? mode === "own"
          ? await getPlan(chosen.id, { view: "own" })
          : await getPlan(chosen.id)
        : null;
      if (mine !== loadSeq) return;
      planData = data;
      forbidden = false;
      rejected = false;
    } catch (err) {
      if (mine !== loadSeq) return;
      planData = null;
      if (isSalonFilterRejected(err)) {
        rejected = true;
      } else if ((err as { status?: unknown } | null)?.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Urlaubsplanung konnte nicht geladen werden.";
      }
    } finally {
      if (mine === loadSeq) loading = false;
    }
  }

  // A salon, year or mode change reloads (a period change across New Year changes the year).
  $effect(() => {
    const salon = salonId;
    const forYear = year;
    void mode;
    untrack(() => {
      if (salon === null) {
        loadSeq++;
        planData = null;
        loading = false;
        forbidden = false;
        rejected = false;
        loadError = "";
        return;
      }
      void load(salon, forYear);
    });
  });

  function reload() {
    if (salonId === null) return Promise.resolve();
    return load(salonId, year, true);
  }

  // ── Derived views ──────────────────────────────────────────────────────────
  const plan = $derived(planData?.plan ?? null);
  const viewer = $derived(planData?.viewer ?? null);
  const persons = $derived(planData?.persons ?? []);
  const isOpen = $derived(plan?.status === "OPEN");
  // Presentation hint only: while no plan exists the server cannot say, so a manager-to-be may open
  // the dialog and the API decides the open.
  const canOpenHint = $derived(hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN"));
  const manageScope = $derived(mode === "team" && (viewer?.canManage ?? false));
  const reportedManage = $derived(
    mode !== "team" || salonId === null || loading || forbidden || rejected || loadError !== ""
      ? false
      : viewer
        ? viewer.canManage
        : planData === null && canOpenHint,
  );
  const personsById = $derived(
    Object.fromEntries(persons.map((p) => [p.employeeId, p])) as Record<string, PlannerPerson>,
  );
  // D-835-38 (WR-01): the server counts the open wishes with the takeover's own close rule (a wish
  // whose approval was refused counts, a terminally refused one does not); the panel never recounts.
  const openWishCount = $derived(plan?.openWishCount ?? 0);

  $effect(() => {
    const canManage = reportedManage;
    untrack(() => onViewer?.({ canManage }));
  });

  function canAddFor(employeeId: string): boolean {
    if (!isOpen || !viewer) return false;
    if (manageScope) return true;
    return viewer.canWishOwn && !viewer.ownEditLocked && employeeId === viewer.employeeId;
  }
  const canAddAny = $derived(
    isOpen &&
      viewer !== null &&
      (manageScope || (viewer.canWishOwn && !viewer.ownEditLocked && viewer.employeeId !== null)),
  );

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // ── The one timeline ───────────────────────────────────────────────────────
  const timeline = $derived(planData ? plannerToTimeline(planData) : null);
  const closedWeekdays = $derived.by(() => {
    if (!planData) return null;
    const { salon } = planData;
    return closedDaysFor(
      [{ salonId: salon.id, name: salon.name, openingHours: salon.openingHours }],
      $salonContext,
    ).days;
  });
  const showForecast = $derived(persons.some((p) => p.forecast !== null));

  const loadRow = $derived.by(() => {
    if (!planData || !timeline) return undefined;
    if (period.zoom === "jahr") {
      return {
        kind: "week" as const,
        counts: weekLoad(timeline.rows, period.year, workdaySet(closedWeekdays), timeline.holidays),
        hint: DAY_LOAD_HINT,
      };
    }
    const counts = new Map<string, number>();
    const exceeded = new Map<string, string>();
    for (const entry of planData.dayLoad) {
      counts.set(entry.day, entry.count);
      // The server sends rule data (`limits`) only to the manage or approve reach.
      const over = (entry.limits ?? []).filter((limit) => limit.exceeded);
      if (over.length > 0) {
        exceeded.set(
          entry.day,
          over
            .map((limit) =>
              limit.ruleName
                ? `${limit.ruleName}: ${limit.count} von höchstens ${limit.max}`
                : `${limit.count} von höchstens ${limit.max}`,
            )
            .join("; "),
        );
      }
    }
    return { kind: "day" as const, counts, exceeded, hint: DAY_LOAD_HINT };
  });

  const legend = $derived.by(() => {
    const base = legendFrom(timeline?.rows ?? []);
    const wanted = new Set(base.styles);
    // An open plan can always receive a wish, so the legend names it before the first one exists.
    if (isOpen) wanted.add("wunsch");
    const styles = (["gesetzt", "beantragt", "wunsch", "abwesend"] as const).filter((s) =>
      wanted.has(s),
    );
    const daily = period.zoom !== "jahr";
    return {
      typeCodes: base.typeCodes,
      styles,
      markings: {
        weekend: daily,
        holiday: daily && (timeline?.holidays.length ?? 0) > 0,
        closed: daily && (closedWeekdays?.size ?? 0) > 0,
        today: daily,
      },
    };
  });

  // ── Timeline vs. list (D-835-21: mobile < 768 px) ──────────────────────────
  let isMobile = $state(false);

  onMount(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    isMobile = query.matches;
    const onChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  // ── Wishes ─────────────────────────────────────────────────────────────────
  let wishDialogOpen = $state(false);
  let dialogWish = $state<PlannerWish | null>(null);
  let dialogDefaults: { employeeId?: string; startDate?: string } | undefined = $state();

  // Only the team planner names another person; the personal one never offers the choice.
  const managerPersons = $derived(
    manageScope
      ? persons.map((p) => ({ employeeId: p.employeeId, label: `${p.firstName} ${p.lastName}` }))
      : null,
  );

  function wishOf(bar: TimelineBar): PlannerWish | null {
    for (const person of persons) {
      const found = person.wishes.find((w) => w.id === bar.key);
      if (found) return found;
    }
    return null;
  }

  function startWish(employeeId: string | null, day?: string) {
    dialogWish = null;
    dialogDefaults = {
      ...(employeeId ? { employeeId } : {}),
      ...(day ? { startDate: day } : {}),
    };
    wishDialogOpen = true;
  }

  function editWish(wish: PlannerWish) {
    dialogWish = wish;
    dialogDefaults = undefined;
    wishDialogOpen = true;
  }

  async function saveWish(payload: WishInput) {
    if (!plan) return;
    if (dialogWish) {
      await updateWish(plan.id, dialogWish.id, {
        startDate: payload.startDate,
        endDate: payload.endDate,
        halfDay: payload.halfDay,
      });
    } else {
      await createWish(plan.id, payload);
    }
    // The dialog shows a refusal of the write inline; the reload only follows an accepted one.
    await reload();
  }

  async function deleteWish(wish: PlannerWish) {
    if (!plan) return;
    await removeWish(plan.id, wish.id);
    await reload();
  }

  async function removeWishFromList(wish: PlannerWish) {
    try {
      await deleteWish(wish);
    } catch (err) {
      toasts.error(planErrorMessage(err));
    }
  }

  async function moveWish(bar: TimelineBar, range: DayRange) {
    const wish = wishOf(bar);
    if (!plan || !wish) return;
    try {
      await updateWish(plan.id, wish.id, range);
    } catch (err) {
      toasts.error(planErrorMessage(err));
    }
    // Reload either way: an accepted drag shows the server's figures, a refused one snaps back.
    await reload();
  }

  function editWishBar(bar: TimelineBar) {
    const wish = wishOf(bar);
    if (wish) editWish(wish);
  }

  // ── Takeover ───────────────────────────────────────────────────────────────
  let takeoverOpen = $state(false);
</script>

<div class="planning-panel" data-testid="leave-plan-page">
  {#if loading}
    <div class="plan-state" role="status"><Spinner /> Urlaubsplanung wird geladen …</div>
  {:else if loadError}
    <div class="alert alert-error" role="alert" data-testid="leave-plan-error">
      <span>⚠</span><span>{loadError}</span>
    </div>
  {:else if forbidden}
    <EmptyState
      title="Kein Zugriff"
      description="Du darfst die Urlaubsplanung dieses Salons nicht sehen."
    />
  {:else if salonId === null}
    <EmptyState
      icon="calendar"
      title="Salon wählen"
      description="Wähle oben einen Salon, um seine Planung zu sehen."
    />
  {:else if rejected || salonRejected}
    <div class="callout brand" role="status" data-testid="leave-plan-salon-unavailable">
      <p>Für diesen Salon liegen hier keine Daten vor. Wähle oben einen anderen Salon.</p>
    </div>
  {:else if plan === null || viewer === null || timeline === null}
    <EmptyState
      icon="calendar"
      title="Noch keine Planung"
      description={mode === "team" && canOpenHint
        ? "Für dieses Jahr ist noch keine Planung eröffnet. Öffne sie über „Planung verwalten“."
        : "Für dieses Jahr ist noch keine Planung eröffnet."}
    />
  {:else}
    <!-- ── Header block: status, deadline as text, hints, add ───────────────── -->
    <Card animate>
      <div class="plan-head" data-testid="leave-plan-head">
        <div class="plan-head-main">
          <span class="badge {plan.status === 'OPEN' ? 'badge-blue' : 'badge-green'}"
            >{planStatusLabel(plan)}</span
          >
          {#if plan.deadline}
            <span class="plan-deadline" data-testid="leave-plan-deadline-text">
              {#if plan.deadlinePassed}
                Frist abgelaufen ({fmtDate(plan.deadline)})
              {:else}
                Wünsche bis {fmtDate(plan.deadline)}
              {/if}
            </span>
          {/if}
        </div>

        {#if isOpen && viewer.ownEditLocked}
          <p class="callout brand" role="status" data-testid="leave-plan-locked">
            Die Frist ist abgelaufen. Du kannst deine eigenen Wünsche nicht mehr ändern.
          </p>
        {:else if isOpen && plan.deadlineLocksWishes && plan.deadline && !viewer.canManage}
          <p class="form-hint" data-testid="leave-plan-lock-hint">
            Nach der Frist kannst du deine eigenen Wünsche nicht mehr ändern.
          </p>
        {/if}

        {#if canAddAny}
          <div class="plan-head-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              data-testid="leave-plan-add-wish"
              onclick={() => startWish(viewer.employeeId)}
            >
              {ADD_WISH_LABEL}
            </button>
          </div>
        {/if}
      </div>
    </Card>

    <!-- ── Legend, then the timeline (desktop) or the wish list (mobile) ───────── -->
    <Card animate>
      <div data-testid="leave-plan-legend">
        <LeaveLegend
          typeCodes={legend.typeCodes}
          styles={legend.styles}
          markings={legend.markings}
        />
        <p class="form-hint plan-legend-hint">
          <strong>{DAY_LOAD_LABEL}</strong> in der Kopfzeile: {DAY_LOAD_HINT}. Wunsch: verschiebbar
          und in der Länge änderbar, solange die Planung offen ist.
        </p>
      </div>
      {#if isMobile}
        <LeavePlanWishList
          {persons}
          ownEmployeeId={viewer.employeeId}
          canAdd={canAddAny}
          onAdd={(employeeId) => startWish(employeeId)}
          onEdit={editWish}
          onRemove={removeWishFromList}
        />
      {:else}
        <div data-testid="leave-plan-timeline-host">
          <AbsenceTimeline
            rows={timeline.rows}
            {period}
            holidays={timeline.holidays}
            {closedWeekdays}
            {today}
            load={loadRow}
            {showForecast}
            canAddWishFor={canAddFor}
            {onWeekSelect}
            onMoveWish={moveWish}
            onEditWish={editWishBar}
            onAddWish={(employeeId, day) => startWish(employeeId, day)}
          />
        </div>
      {/if}
    </Card>
  {/if}

  <!-- Dialogs are siblings of the animated blocks, never inside them (#570). -->
  <LeavePlanWishDialog
    bind:open={wishDialogOpen}
    {year}
    persons={managerPersons}
    wish={dialogWish}
    defaults={dialogDefaults}
    onSave={saveWish}
    onRemove={deleteWish}
  />
  {#if mode === "team" && salonId !== null}
    <ManagePlanDialog
      bind:open={manageOpen}
      {salonId}
      {year}
      plan={plan
        ? {
            id: plan.id,
            status: plan.status,
            deadline: plan.deadline,
            partiallyTakenOver: plan.partiallyTakenOver,
          }
        : null}
      openWishCount={plan?.openWishCount ?? null}
      onChanged={reload}
      onTakeover={() => (takeoverOpen = true)}
    />
  {/if}
  {#if plan}
    <LeavePlanTakeoverDialog
      bind:open={takeoverOpen}
      planId={plan.id}
      {openWishCount}
      {personsById}
      onDone={() => void reload()}
    />
  {/if}
</div>

<style>
  .planning-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .plan-state {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-muted);
    padding: var(--s-4) 0;
  }
  .plan-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .plan-head-main {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
  }
  .plan-deadline {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .plan-head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .plan-head p {
    margin: 0;
  }
  .plan-legend-hint {
    margin: 0 0 var(--s-3);
    padding: 0 1.25rem;
  }
</style>
