<script lang="ts">
  /**
   * /leave/planung — the Urlaubsplanung (Issue #835, D-835-21/22/33).
   *
   * Presentation only: the page composes the planner building blocks and asks the API for every
   * read and write. The salon comes from the header selection (`teamSalonViewSalon`, #82/#558; a
   * `?salonId=` deep link only preselects a reachable salon in it, WR-07), the
   * API validates it against the caller's reach and answers one 404 for every rejection. A
   * permission hint (`hasPermission`) only hides a button; the API refuses any action without reach.
   */
  import { onMount, untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import LeavePlanTimeline from "$lib/components/leave/LeavePlanTimeline.svelte";
  import LeavePlanWishList from "$lib/components/leave/LeavePlanWishList.svelte";
  import LeavePlanWishDialog from "$lib/components/leave/LeavePlanWishDialog.svelte";
  import LeavePlanTakeoverDialog from "$lib/components/leave/LeavePlanTakeoverDialog.svelte";
  import { teamSalonViewSalon } from "$lib/dashboard/team-view";
  import { isSalonFilterRejected, salonScopeLabel } from "$lib/salons/page-scope";
  import {
    createWish,
    getPlan,
    listPlans,
    openPlan,
    removeWish,
    setDeadline,
    updateWish,
  } from "$lib/leave-plan/api";
  import { deepLinkSalon } from "$lib/leave-plan/deep-link";
  import { isPlanAlreadyOpen, planErrorMessage } from "$lib/leave-plan/errors";
  import {
    DAY_LOAD_HINT,
    DAY_LOAD_LABEL,
    ADD_WISH_LABEL,
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

  const MONTH_NAMES = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];

  // ── Salon and year (D-835-21/22) ───────────────────────────────────────────
  const contextLoaded = $derived($salonContext.loaded);
  const salonId = $derived(teamSalonViewSalon($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));

  function parseYear(raw: string | null): number | null {
    if (raw === null || !/^\d{4}$/.test(raw)) return null;
    const value = Number(raw);
    return value >= 2000 && value <= 2100 ? value : null;
  }

  const defaultYear = new Date().getFullYear() + 1;
  const year = $derived(parseYear($page.url.searchParams.get("year")) ?? defaultYear);

  function changeYear(next: number) {
    if (next < 2000 || next > 2100) return;
    const url = new URL($page.url);
    url.searchParams.set("year", String(next));
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // ── Plan state ─────────────────────────────────────────────────────────────
  let planData = $state<PlannerReadDto | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);
  let salonRejected = $state(false);

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
      const data = chosen ? await getPlan(chosen.id) : null;
      if (mine !== loadSeq) return;
      planData = data;
      forbidden = false;
      salonRejected = false;
    } catch (err) {
      if (mine !== loadSeq) return;
      planData = null;
      if (isSalonFilterRejected(err)) {
        salonRejected = true;
      } else if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Urlaubsplanung konnte nicht geladen werden.";
      }
    } finally {
      if (mine === loadSeq) loading = false;
    }
  }

  $effect(() => {
    const salon = salonId;
    const forYear = year;
    if (!contextLoaded) return;
    untrack(() => {
      if (salon === null) {
        loadSeq++;
        planData = null;
        loading = false;
        forbidden = false;
        salonRejected = false;
        loadError = "";
        return;
      }
      void load(salon, forYear);
    });
  });

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

  function reload() {
    if (salonId === null) return Promise.resolve();
    return load(salonId, year, true);
  }

  // ── Derived views ──────────────────────────────────────────────────────────
  const plan = $derived(planData?.plan ?? null);
  const viewer = $derived(planData?.viewer ?? null);
  const persons = $derived(planData?.persons ?? []);
  const isOpen = $derived(plan?.status === "OPEN");
  const canManage = $derived(viewer?.canManage ?? false);
  const canOpenHint = $derived(hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN"));
  const showForecast = $derived(persons.some((p) => p.forecast !== null));
  const personsById = $derived(
    Object.fromEntries(persons.map((p) => [p.employeeId, p])) as Record<string, PlannerPerson>,
  );
  // D-835-38 (WR-01): the server counts the open wishes with the takeover's own close rule (a wish
  // whose approval was refused counts, a terminally refused one does not); the page never recounts.
  const openWishCount = $derived(plan?.openWishCount ?? 0);

  function canAddFor(employeeId: string): boolean {
    if (!isOpen || !viewer) return false;
    if (viewer.canManage) return true;
    return viewer.canWishOwn && !viewer.ownEditLocked && employeeId === viewer.employeeId;
  }
  const canAddAny = $derived(
    isOpen && viewer !== null && (viewer.canManage || (viewer.canWishOwn && !viewer.ownEditLocked)),
  );

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // ── Timeline vs. list (D-835-21: mobile < 768 px) ──────────────────────────
  let isMobile = $state(false);
  let viewKind = $state<"year" | "month">("year");
  let viewMonth = $state(new Date().getMonth());
  const timelineView = $derived(viewKind === "year" ? ("year" as const) : viewMonth);

  onMount(() => {
    const query = window.matchMedia("(max-width: 767px)");
    isMobile = query.matches;
    const onChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  // ── Open the plan, deadline ────────────────────────────────────────────────
  let openDeadline = $state("");
  let opening = $state(false);
  let openError = $state("");

  async function doOpenPlan() {
    if (salonId === null || opening) return;
    opening = true;
    openError = "";
    try {
      await openPlan({ salonId, year, deadline: openDeadline === "" ? null : openDeadline });
      openDeadline = "";
      toasts.success("Die Urlaubsplanung ist eröffnet.");
      await reload();
    } catch (err) {
      if (isPlanAlreadyOpen(err)) {
        await reload();
      } else {
        openError = planErrorMessage(err);
      }
    } finally {
      opening = false;
    }
  }

  // Follows the stored deadline whenever a (re)loaded plan carries another one; typing overrides it.
  let deadlineInput = $derived(plan?.deadline ?? "");
  let deadlineSaving = $state(false);
  let deadlineError = $state("");

  async function saveDeadline(value: string | null) {
    if (!plan || deadlineSaving) return;
    deadlineSaving = true;
    deadlineError = "";
    try {
      await setDeadline(plan.id, value);
      toasts.success(value ? "Die Frist ist gespeichert." : "Die Frist ist entfernt.");
      await reload();
    } catch (err) {
      deadlineError = planErrorMessage(err);
    } finally {
      deadlineSaving = false;
    }
  }

  // ── Wishes ─────────────────────────────────────────────────────────────────
  let wishDialogOpen = $state(false);
  let dialogWish = $state<PlannerWish | null>(null);
  let dialogDefaults: { employeeId?: string; startDate?: string } | undefined = $state();

  const managerPersons = $derived(
    canManage
      ? persons.map((p) => ({ employeeId: p.employeeId, label: `${p.firstName} ${p.lastName}` }))
      : null,
  );

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

  async function moveWish(wish: PlannerWish, range: DayRange) {
    if (!plan) return;
    try {
      await updateWish(plan.id, wish.id, range);
    } catch (err) {
      toasts.error(planErrorMessage(err));
    }
    // Reload either way: an accepted drag shows the server's figures, a refused one snaps back.
    await reload();
  }

  // ── Takeover ───────────────────────────────────────────────────────────────
  let takeoverOpen = $state(false);
</script>

<svelte:head>
  <title>Urlaubsplanung – Clokr</title>
</svelte:head>

<div data-testid="leave-plan-page" style="display: contents">
  <PageHead
    eyebrow="Mein Bereich"
    title="Urlaubsplanung"
    sub="Plane den Urlaub des Teams für das ganze Jahr."
  >
    {#snippet actions()}
      <div class="year-nav" role="group" aria-label="Planungsjahr">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Vorheriges Jahr"
          onclick={() => changeYear(year - 1)}>←</button
        >
        <span class="year-nav-value font-mono" data-testid="leave-plan-year">{year}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Nächstes Jahr"
          onclick={() => changeYear(year + 1)}>→</button
        >
      </div>
    {/snippet}
  </PageHead>
  <SalonScopeLabel label={scopeLabel} rejected={salonRejected} />

  {#if !contextLoaded || loading}
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
      description="Wähle oben einen Salon, um seine Urlaubsplanung zu sehen."
    />
  {:else if salonRejected}
    <!-- The calm hint sits in SalonScopeLabel above. -->
  {:else if plan === null || viewer === null}
    {#if canOpenHint}
      <Card animate>
        <div class="open-plan">
          <h2 class="plan-title">Urlaubsplanung {year} eröffnen</h2>
          <p class="form-hint">
            Alle Personen des Salons können danach ihre Urlaubswünsche eintragen. Eine Frist ist
            optional.
          </p>
          <div class="open-plan-row">
            <label class="form-label" for="plan-open-deadline">Wünsche bis (optional)</label>
            <input
              id="plan-open-deadline"
              type="date"
              class="form-input"
              bind:value={openDeadline}
            />
          </div>
          {#if openError}<p class="form-error" role="alert">{openError}</p>{/if}
          <div>
            <button
              type="button"
              class="btn btn-primary"
              data-testid="leave-plan-open"
              disabled={opening}
              onclick={doOpenPlan}
            >
              Urlaubsplanung eröffnen
            </button>
          </div>
        </div>
      </Card>
    {:else}
      <EmptyState
        icon="calendar"
        title="Noch keine Planung"
        description="Für dieses Jahr gibt es noch keine Urlaubsplanung."
      />
    {/if}
  {:else}
    <!-- ── Header block ─────────────────────────────────────────────────────── -->
    <Card animate>
      <div class="plan-head" data-testid="leave-plan-head">
        <div class="plan-head-main">
          <span class="badge {plan.status === 'OPEN' ? 'badge-blue' : 'badge-green'}"
            >{planStatusLabel(plan)}</span
          >
          {#if plan.deadline}
            <span class="plan-deadline" data-testid="leave-plan-deadline">
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

        <div class="plan-head-actions">
          {#if canAddAny}
            <button
              type="button"
              class="btn btn-primary btn-sm"
              data-testid="leave-plan-add-wish"
              onclick={() => startWish(viewer.employeeId)}
            >
              {ADD_WISH_LABEL}
            </button>
          {/if}
          {#if isOpen && canManage}
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="leave-plan-takeover"
              disabled={openWishCount === 0}
              onclick={() => (takeoverOpen = true)}
            >
              Planung übernehmen
            </button>
          {/if}
        </div>

        {#if isOpen && canManage}
          <div class="deadline-edit">
            <label class="form-label" for="plan-deadline">Frist für Wünsche</label>
            <input id="plan-deadline" type="date" class="form-input" bind:value={deadlineInput} />
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={deadlineSaving || deadlineInput === "" || deadlineInput === plan.deadline}
              onclick={() => saveDeadline(deadlineInput)}
            >
              Frist speichern
            </button>
            {#if plan.deadline}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={deadlineSaving}
                onclick={() => saveDeadline(null)}
              >
                Frist entfernen
              </button>
            {/if}
            {#if deadlineError}<p class="form-error" role="alert">{deadlineError}</p>{/if}
          </div>
        {/if}
      </div>
    </Card>

    <!-- ── Timeline (desktop) or wish list (mobile) ──────────────────────────── -->
    <Card animate>
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
        <div class="view-controls">
          <SegmentedControl
            name="leave-plan-view"
            ariaLabel="Ansicht"
            size="sm"
            options={[
              { value: "year", label: "Jahr" },
              { value: "month", label: "Monat" },
            ]}
            bind:value={viewKind}
          />
          {#if viewKind === "month"}
            <select class="form-input view-month" aria-label="Monat" bind:value={viewMonth}>
              {#each MONTH_NAMES as name, index (name)}
                <option value={index}>{name}</option>
              {/each}
            </select>
          {/if}
        </div>
        <div data-testid="leave-plan-timeline-host">
          <LeavePlanTimeline
            {year}
            view={timelineView}
            {persons}
            holidays={planData?.holidays ?? []}
            dayLoad={planData?.dayLoad ?? []}
            {showForecast}
            canAddWishFor={canAddFor}
            onMoveWish={moveWish}
            onEditWish={editWish}
            onAddWish={(employeeId, day) => startWish(employeeId, day)}
          />
        </div>
      {/if}
    </Card>

    <!-- ── Legend ───────────────────────────────────────────────────────────── -->
    <Card animate>
      <div class="plan-legend" data-testid="leave-plan-legend">
        <p><strong>{DAY_LOAD_LABEL}</strong> in der Kopfzeile: {DAY_LOAD_HINT}.</p>
        <p class="form-hint">
          Durchgezogen: gesetzt · Gestrichelt: beantragt · Wunsch: verschiebbar und in der Länge
          änderbar, solange die Planung offen ist.
        </p>
      </div>
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
  .year-nav {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .year-nav-value {
    min-width: 3rem;
    text-align: center;
    font-weight: 600;
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
  .deadline-edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .deadline-edit .form-input {
    width: auto;
  }
  .open-plan {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .open-plan h2,
  .open-plan p {
    margin: 0;
  }
  .open-plan-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    max-width: 16rem;
  }
  .view-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin-bottom: var(--s-3);
  }
  .view-month {
    width: auto;
  }
  .plan-legend {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    font-size: 0.875rem;
  }
  .plan-legend p {
    margin: 0;
  }
</style>
