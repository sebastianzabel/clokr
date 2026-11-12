<script lang="ts">
  import { homeHref } from "$lib/nav/routes";
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, tick } from "svelte";
  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { hasAnyPermission, hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import List from "$components/ui/List.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Dialog from "$components/ui/Dialog.svelte"; // Issue #853 (D-853-18)
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // § 9 reject reason (moved from /team/leave, #840)
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import { LEAVE_TYPE_OPTIONS, type CalendarTypeCode } from "$lib/leave/team-calendar-visibility"; // Phase 262, Phase 255
  import { leaveDaysLabel } from "$lib/leave/leave-days-label"; // Issue #595 (D-04)
  import TaskRow from "$lib/components/team/aufgaben/TaskRow.svelte"; // Issue #853 (D-853-06)
  import RetroReviewBody from "$lib/components/team/aufgaben/RetroReviewBody.svelte"; // Issue #853 (D-853-18)
  import {
    taskRowsFrom,
    taskCounts,
    taskKindLabel,
    rowsForView,
    filterByKind,
    availableTaskKinds,
    TASK_KIND_VALUES,
    type NoticeTaskSource,
    type OpenTasksAnswer,
    type TaskKind,
    type TaskRowModel,
  } from "$lib/team/task-model"; // Issue #853 (D-853-06)
  import { urlState, oneOf } from "$lib/table/url-state"; // Issue #853 (D-853-06)
  import LeaveReviewDialog from "$lib/components/leave/LeaveReviewDialog.svelte"; // Phase 255
  import { parseInboxDeepLink, type InboxDeepLink } from "$lib/leave/inbox-deep-link"; // Issue #840 (D-840-05)

  // ── Types ────────────────────────────────────────────────────────────────
  type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";

  // Phase 255: the union now lives with the colour/label table it belongs to.
  type TypeCode = CalendarTypeCode;

  interface LeaveRequest {
    id: string;
    employeeId: string;
    typeCode: TypeCode;
    leaveType: { name: string };
    employee: { firstName: string; lastName: string; employeeNumber?: string };
    startDate: string;
    endDate: string;
    days: number;
    halfDay: boolean;
    status: Status;
    note: string | null;
    reviewNote: string | null;
    createdAt: string;
    attestPresent: boolean;
    attestValidFrom: string | null;
    attestValidTo: string | null;
  }

  // ── RetroEntryRequest types ──────────────────────────────────────────────
  type RetroStatus = "PENDING" | "APPROVED" | "REJECTED" | "USED";

  interface RetroEntryRequest {
    id: string;
    employeeId: string;
    employee: { firstName: string; lastName: string };
    targetDate: string; // YYYY-MM-DD
    reason: string;
    status: RetroStatus;
    reviewNote: string | null;
    startTime: string | null; // "HH:MM" — proposed work start
    endTime: string | null; // "HH:MM" — proposed work end
    breakMinutes: number | null; // proposed break minutes
    windowDays?: number;
    entryAgeInDays?: number;
    createdAt: string;
  }

  // LEAVE_TYPE_OPTIONS has no HOLIDAY entry (it is the nine-element set of types a
  // LeaveRequest can actually carry — team-calendar-visibility.ts:106-108). typeName("HOLIDAY")
  // would fall back to the raw code, but LeaveRequest.typeCode can never be HOLIDAY — that value
  // exists only in CalendarTypeCode, for calendar holiday colouring (CONTEXT <deferred>,
  // RESEARCH § Vocabulary Duplication). Measured gap, not a bug.
  function typeName(code: string): string {
    return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  // ── State ────────────────────────────────────────────────────────────────
  // Year-bound list (approved / rejected / all tabs).
  let requests: LeaveRequest[] = $state([]);
  // Every open request in the caller's approve reach, regardless of the year it starts in (#840 E-02:
  // the inbox is the only approval place, so a request for next January must not be missing).
  let pendingRequests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Issue #853 (D-853-06, D-853-19): the type filter and the „Offen · Entschieden“ view live in the
  // URL. `urlState` keeps every other key (`request`, `year`, `section9`, `salonId`) as it is; the
  // deep-link keys are still read only by `parseInboxDeepLink`.
  const taskUrl = urlState({
    typ: oneOf(["alle", ...TASK_KIND_VALUES] as const, "alle"),
    ansicht: oneOf(["offen", "entschieden"] as const, "offen"),
  });
  const taskView = $derived(taskUrl.read());

  // Detail modal — Phase 255: markup and mutation now live in the shared LeaveReviewDialog
  // component; the page only keeps the two pieces of state that select which request is
  // under review.
  let detailRequest: LeaveRequest | null = $state(null);
  let detailOpen = $state(false);

  // ── RetroEntryRequest state ──────────────────────────────────────────────
  let retroRequests: RetroEntryRequest[] = $state([]);
  let retroLoading = $state(true);

  // Retro detail/review modal
  let retroDetail: RetroEntryRequest | null = $state(null);
  let retroDetailOpen = $state(false);
  let retroReviewNote = $state("");
  let retroReviewSaving = $state(false);
  let retroReviewError = $state("");

  // Phase 96 (RETRO-16/D-10) — manager edit-on-approve: editable copies of the
  // request's proposed times, prefilled on open. Only fields that actually
  // DIFFER from the original proposal are sent in the approve PATCH body (see
  // retroCorrectedFields()), so an untouched approval stays byte-identical to
  // the plain release (96-02) — the backend only stamps a MANAGER_CORRECTION
  // audit when at least one of these keys is present in the request body.
  let retroEditStartTime = $state("");
  let retroEditEndTime = $state("");
  let retroEditBreakMinutes = $state(0);

  // ── § 9 BUrlG — "AU liegt vor" (Phase 104-10, R6/D-27/D-11/D-26; moved here from /team/leave, #840) ──
  interface Section9Case {
    id: string;
    employeeId: string;
    employeeName: string;
    // #468: GET /leave/section9 can also return SUPERSEDED — a CONFIRMED credit a correction
    // (PATCH /correct) made obsolete, never an open case (the filter below still only lists
    // AU_PENDING and REJECTED).
    status: "AU_PENDING" | "CONFIRMED" | "REJECTED" | "SUPERSEDED";
    overlapStart: string;
    overlapEnd: string;
    creditedStart: string | null;
    creditedEnd: string | null;
    creditedDays: number | null;
    attestSource: string | null;
    attestValidFrom: string | null;
    attestValidTo: string | null;
    reason: string | null;
    sickRequest: { id: string; startDate: string; endDate: string; status: string };
    vacationRequest: {
      id: string;
      startDate: string;
      endDate: string;
      halfDay: boolean;
      days: number;
      typeName: string;
    };
  }

  let section9Cases: Section9Case[] = $state([]);
  let section9Loading = $state(true);
  let highlightSection9Id: string | null = $state(null);

  // Issue #853 (D-853-07, D-853-22): the Pausenbefunde are the caller's own #85 break notices, the
  // missing clock-outs come from the reach-scoped open-tasks read. Both are calm sources: a refusal
  // or a failure is an empty source, never an error alert.
  let notices: NoticeTaskSource[] = $state([]);
  let noticesLoading = $state(true);
  let openTasks = $state<OpenTasksAnswer | null>(null);
  let openTasksLoading = $state(true);

  // Hint only (T-840-28): shows the § 9 rows to holders of either § 9 key.
  const canSection9 = $derived(
    hasAnyPermission($authStore.user, ["section9:read:ZUGEWIESEN", "section9:decide:ZUGEWIESEN"]),
  );

  // The leave list is read only by an approver: `GET /leave/requests` answers 403 without any
  // `leave-request:read`, and with the EIGENE reach only the caller's OWN requests, which would
  // show up under „Offen“ as items to decide. A role that only decides § 9 cases never loads it,
  // neither on mount nor after a § 9 decision (review WR-06). A UX hint; the API decides.
  const canListLeave = $derived(
    hasAnyPermission($authStore.user, ["leave-request:approve:ZUGEWIESEN"]),
  );

  // Same hint for the Zeitnachträge: the list is read only by an approver, because `GET
  // /retro-entry-requests` also answers a caller with the EIGENE reach, and her own requests would
  // otherwise show up as items to decide. A UX hint; the API decides.
  const canRetro = $derived(
    hasAnyPermission($authStore.user, ["retro-request:approve:ZUGEWIESEN"]),
  );

  // The missing clock-outs are offered to a caller who holds the time-entry reach the read needs
  // (a UX hint; the API scopes every row by the per-entry reach).
  const canOpenTasks = $derived(hasPermission($authStore.user, "time-entry:read:ZUGEWIESEN"));

  /** Reloads what a § 9 decision can change: the § 9 cases, and the leave list for an approver only. */
  async function reloadAfterSection9() {
    await Promise.all([canListLeave ? loadRequests() : Promise.resolve(), loadSection9Cases()]);
  }

  // ── Permission gate (Phase 378, #378; § 9 since #840 D-840-29) ──────────────
  // Any one of the three decide keys is enough — this Postfach decides leave requests, Zeitnachträge
  // and § 9 cases. A Salonmanager (Salon-Scope role assignment) holds all three; an Ausbilder holds
  // none (read-only template, #76) and correctly never reaches this page. A role holding only
  // `section9:decide:ZUGEWIESEN` gets in too, so moving the § 9 cases here locks no decider out.
  onMount(() => {
    const canDecide = hasAnyPermission($authStore.user, [
      "leave-request:approve:ZUGEWIESEN",
      "retro-request:approve:ZUGEWIESEN",
      "section9:decide:ZUGEWIESEN",
    ]);
    if (!canDecide) {
      void goto(homeHref($authStore.user));
      return;
    }
    // The deep link is read ONCE, here, and applied after the first completed loads (the rows do not
    // exist before). Untrusted values are reduced by the pure parser (T-840-30).
    const link = parseInboxDeepLink($page.url.searchParams, currentYear);
    const hadLinkParams = DEEP_LINK_PARAMS.some((name) => $page.url.searchParams.has(name));
    void (async () => {
      const loads: Promise<unknown>[] = [];
      if (canRetro) loads.push(loadRetroRequests());
      else retroLoading = false;
      // The leave list is skipped for a role that only decides § 9 cases: it would answer 403 and
      // show an error alert for a list that role never sees.
      if (canListLeave) {
        loads.push(loadRequests());
      } else {
        loading = false;
      }
      // The § 9 rows are only a UX hint: the API answers 403 without `section9:read` and decides
      // every action by `section9:decide`.
      if (canSection9) loads.push(loadSection9Cases());
      else section9Loading = false;
      loads.push(loadNotices());
      if (canOpenTasks) loads.push(loadOpenTasks());
      else openTasksLoading = false;
      await Promise.all(loads);
      await applyDeepLink(link);
      if (hadLinkParams) stripDeepLinkParams();
    })();
  });

  // ── Data loading ─────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();

  async function loadRequests() {
    loading = true;
    error = "";
    try {
      // The open list is loaded without `year` on purpose: for an approver `status=PENDING` also
      // covers CANCELLATION_REQUESTED, in every year.
      const [yearList, openList] = await Promise.all([
        api.get<LeaveRequest[]>(`/leave/requests?year=${currentYear}`),
        api.get<LeaveRequest[]>("/leave/requests?status=PENDING"),
      ]);
      requests = yearList;
      pendingRequests = openList;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
      requests = [];
      pendingRequests = [];
    } finally {
      loading = false;
    }
  }

  // ── Deep links (Issue #840, D-840-05) ─────────────────────────────────────
  // `?request=<id>[&year=<YYYY>]` opens the shared review dialog for that request; `?section9=<id>`
  // scrolls to and highlights that § 9 case. A request that cannot be found in the caller's list
  // (decided meanwhile, or outside the reach) gives one calm toast - the dialog never opens for a row
  // the API did not list for the caller (T-840-27), and no new endpoint is involved.
  const DEEP_LINK_PARAMS = ["request", "year", "section9"] as const;

  /** The list of another year, read once for the lookup only - the page keeps showing `currentYear`. */
  async function findRequestInYear(id: string, year: number): Promise<LeaveRequest | null> {
    try {
      const list = await api.get<LeaveRequest[]>(`/leave/requests?year=${year}`);
      return list.find((r) => r.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async function applyDeepLink(link: InboxDeepLink) {
    if (link.requestId) {
      let found: LeaveRequest | null =
        pendingRequests.find((r) => r.id === link.requestId) ??
        requests.find((r) => r.id === link.requestId) ??
        null;
      if (!found && link.year !== null && link.year !== currentYear) {
        found = await findRequestInYear(link.requestId, link.year);
      }
      if (found) openDetail(found);
      else toasts.info("Dieser Antrag ist nicht mehr offen oder nicht in deiner Reichweite.");
    }
    if (link.section9Id) {
      const id = link.section9Id;
      if (!openSection9Cases.some((c) => c.id === id)) {
        toasts.info("Dieser Vorgang ist nicht mehr offen oder nicht in deiner Reichweite.");
        return;
      }
      highlightSection9Id = id;
      await tick();
      requestAnimationFrame(() => {
        document
          .getElementById(`section9-${id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      setTimeout(() => {
        highlightSection9Id = null;
      }, 3000);
    }
  }

  /** Takes the deep-link parameters out of the address bar; other parameters stay. */
  function stripDeepLinkParams() {
    try {
      const url = new URL($page.url);
      for (const name of DEEP_LINK_PARAMS) url.searchParams.delete(name);
      replaceState(url, {});
    } catch {
      // The router is not ready or the URL is unusable: the parameters just stay, harmless.
    }
  }

  async function loadRetroRequests() {
    retroLoading = true;
    try {
      retroRequests = await api.get<RetroEntryRequest[]>("/retro-entry-requests");
    } catch {
      retroRequests = [];
    } finally {
      retroLoading = false;
    }
  }

  /** The caller's newest notifications; only the break notices become rows (D-853-07). */
  async function loadNotices() {
    noticesLoading = true;
    try {
      const answer = await api.get<{ notifications: NoticeTaskSource[] }>("/notifications");
      notices = answer.notifications ?? [];
    } catch {
      notices = [];
    } finally {
      noticesLoading = false;
    }
  }

  /** The open-task read (missing clock-outs, D-853-21/22); `types` decides which kinds exist (D-853-23). */
  async function loadOpenTasks() {
    openTasksLoading = true;
    try {
      openTasks = await api.get<OpenTasksAnswer>("/tasks/open");
    } catch {
      openTasks = null;
    } finally {
      openTasksLoading = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // ── Derived: the leave requests and Zeitnachträge as task rows + the KPI band ──
  // Open = every open request in the approve reach (all years, #840 E-02); decided = the current
  // year's list, as the removed „Genehmigt“ / „Abgelehnt“ tabs showed it.
  let openRequests = $derived(
    pendingRequests.filter((r) => r.status === "PENDING" || r.status === "CANCELLATION_REQUESTED"),
  );
  let approvedRequests = $derived(requests.filter((r) => r.status === "APPROVED"));
  let rejectedRequests = $derived(requests.filter((r) => r.status === "REJECTED"));

  // The one task list (D-853-06). The day figure is always the shared helper.
  const allTaskRows = $derived(
    taskRowsFrom(
      {
        leave: [...openRequests, ...approvedRequests, ...rejectedRequests],
        retro: retroRequests,
        section9: section9Cases,
        notices,
        openTasks,
      },
      { leaveDays: (r) => leaveDaysLabel(Number(r.days), r.halfDay, r.typeCode as TypeCode) },
    ),
  );
  const openTaskRows = $derived(rowsForView(allTaskRows, "offen"));
  const decidedTaskRows = $derived(rowsForView(allTaskRows, "entschieden"));
  const taskOpenCounts = $derived(taskCounts(openTaskRows));

  // A kind is offered only to a caller who can decide it (same hints as the loaders; the API decides).
  // Pausenbefund appears only when the caller has such rows; Zeitkorrektur only when the open-task
  // answer lists the type (D-853-23).
  const availableKinds = $derived<TaskKind[]>(
    availableTaskKinds({
      leave: canListLeave,
      retro: canRetro,
      section9: canSection9,
      breakNoticeCount: taskOpenCounts.pausenbefund,
      openTaskTypes: openTasks?.types ?? [],
    }),
  );
  const kpiItems = $derived<KpiItem[]>(
    availableKinds.map((kind) => ({
      label: `Offen · ${taskKindLabel(kind)}`,
      value: taskOpenCounts[kind],
      testId: `inbox-kpi-${kind}`,
      ...(kind === "pausenbefund" ? { explanation: "Aus deinen neuesten Benachrichtigungen" } : {}),
    })),
  );

  // The URL decides view and type; a type the caller cannot decide reads as „Alle“.
  const activeTyp = $derived<TaskKind | "alle">(
    taskView.typ !== "alle" && availableKinds.includes(taskView.typ) ? taskView.typ : "alle",
  );
  const viewRows = $derived(taskView.ansicht === "offen" ? openTaskRows : decidedTaskRows);
  const viewCounts = $derived(taskCounts(viewRows));
  const visibleTaskRows = $derived(filterByKind(viewRows, activeTyp));

  const typOptions = $derived([
    { value: "alle", label: `Alle (${viewRows.length})` },
    ...availableKinds.map((kind) => ({
      value: kind,
      label: `${taskKindLabel(kind)} (${viewCounts[kind]})`,
    })),
  ]);
  const ansichtOptions = $derived([
    { value: "offen", label: `Offen (${openTaskRows.length})` },
    { value: "entschieden", label: "Entschieden" },
  ]);

  const tasksLoading = $derived(
    (canListLeave && loading) ||
      (canRetro && retroLoading) ||
      (canSection9 && section9Loading) ||
      noticesLoading ||
      (canOpenTasks && openTasksLoading),
  );

  function onTypSelected(value: string) {
    taskUrl.write({ typ: value as TaskKind | "alle" });
  }
  function onAnsichtSelected(value: string) {
    taskUrl.write({ ansicht: value === "entschieden" ? "entschieden" : "offen" });
  }

  /** The request a task row stands for (the open list first, as the deep link does). */
  function leaveOf(row: TaskRowModel): LeaveRequest | null {
    if (row.kind !== "urlaub") return null;
    return (
      pendingRequests.find((r) => r.id === row.sourceId) ??
      requests.find((r) => r.id === row.sourceId) ??
      null
    );
  }

  /** The Zeitnachtrag a task row stands for. */
  function retroOf(row: TaskRowModel): RetroEntryRequest | null {
    if (row.kind !== "nachtrag") return null;
    return retroRequests.find((r) => r.id === row.sourceId) ?? null;
  }

  /** The § 9 case a task row stands for. */
  function section9Of(row: TaskRowModel): Section9Case | null {
    if (row.kind !== "paragraf9") return null;
    return section9Cases.find((c) => c.id === row.sourceId) ?? null;
  }

  // ── Detail modal ─────────────────────────────────────────────────────────
  function openDetail(req: LeaveRequest) {
    detailRequest = req;
    detailOpen = true;
  }

  function isRetroSelfApproval(req: RetroEntryRequest): boolean {
    return req.employeeId === $authStore.user?.employeeId;
  }

  // ── Retro detail modal ────────────────────────────────────────────────────
  function openRetroDetail(req: RetroEntryRequest) {
    retroDetail = req;
    retroDetailOpen = true;
    retroReviewNote = "";
    retroReviewError = "";
    // Phase 96 (RETRO-16/D-10) — prefill the editable time fields from the
    // request's own proposed times (works for both the entry-first and the
    // legacy grant-first shape — both carry startTime/endTime/breakMinutes on
    // the RetroEntryRequest row itself; a legacy/uncoupled approval silently
    // ignores these fields server-side, see retroCorrectedFields()).
    retroEditStartTime = req.startTime ?? "";
    retroEditEndTime = req.endTime ?? "";
    retroEditBreakMinutes = req.breakMinutes ?? 0;
  }

  function closeRetroDetail() {
    if (retroReviewSaving) return;
    retroDetailOpen = false;
    retroDetail = null;
    retroReviewError = "";
  }

  // Phase 96 (RETRO-16/D-10) — only report fields the manager actually
  // changed from the original proposal. Sending an untouched field would
  // still make the backend treat the approval as a manager correction (its
  // discriminator is "key present in the body", not "value differs") — so an
  // approval where nothing was edited must omit all three keys to stay
  // byte-identical to the plain release (96-02's regression contract).
  function retroCorrectedFields(): {
    startTime?: string;
    endTime?: string;
    breakMinutes?: number;
  } {
    if (!retroDetail) return {};
    const fields: { startTime?: string; endTime?: string; breakMinutes?: number } = {};
    if (retroEditStartTime && retroEditStartTime !== (retroDetail.startTime ?? "")) {
      fields.startTime = retroEditStartTime;
    }
    if (retroEditEndTime && retroEditEndTime !== (retroDetail.endTime ?? "")) {
      fields.endTime = retroEditEndTime;
    }
    if (retroEditBreakMinutes !== (retroDetail.breakMinutes ?? 0)) {
      fields.breakMinutes = retroEditBreakMinutes;
    }
    return fields;
  }

  async function submitRetroReview(status: "APPROVED" | "REJECTED") {
    if (!retroDetail) return;
    // Note is mandatory only when rejecting (Revisionssicherheit); optional on approve.
    if (status === "REJECTED" && !retroReviewNote.trim()) {
      retroReviewError = "Bitte gib eine Begründung an (revisionssicherheitspflichtig).";
      return;
    }
    // Manager edit-on-approve: mirror the backend's HH:MM ordering check
    // client-side so a bad edit surfaces immediately, not after a round trip.
    if (
      status === "APPROVED" &&
      retroEditStartTime &&
      retroEditEndTime &&
      retroEditEndTime <= retroEditStartTime
    ) {
      retroReviewError = "Ende muss nach dem Beginn liegen.";
      return;
    }
    retroReviewSaving = true;
    retroReviewError = "";
    try {
      await api.patch(`/retro-entry-requests/${retroDetail.id}/review`, {
        status,
        reviewNote: retroReviewNote.trim() ? retroReviewNote : null,
        ...(status === "APPROVED" ? retroCorrectedFields() : {}),
      });
      retroDetailOpen = false;
      retroDetail = null;
      toasts.success("Antrag wurde entschieden.");
      await loadRetroRequests();
    } catch (e: unknown) {
      const apiErr = e as { data?: { error?: string }; message?: string };
      retroReviewError = apiErr?.data?.error ?? apiErr?.message ?? "Fehler";
    } finally {
      retroReviewSaving = false;
    }
  }

  // The inbox is a work queue and stays unfiltered (#558): a due § 9 decision must never be hidden
  // by the header selection, so this read sends no salon parameter and the API scopes it by reach.
  // A newer response always wins over an older one (plain counter, not reactive on purpose).
  let section9Generation = 0;

  async function loadSection9Cases() {
    const generation = ++section9Generation;
    section9Loading = true;
    try {
      const cases = await api.get<Section9Case[]>("/leave/section9");
      if (generation !== section9Generation) return;
      section9Cases = cases;
    } catch {
      // 403/404 or a transient failure: a calm empty section, never an error alert.
      if (generation !== section9Generation) return;
      section9Cases = [];
    } finally {
      if (generation === section9Generation) section9Loading = false;
    }
  }

  // ── Confirm-Dialog ("AU liegt vor") ──────────────────────────────────────
  let section9ConfirmCase: Section9Case | null = $state(null);
  let section9ConfirmOpen = $state(false);
  let section9AttestFrom = $state("");
  let section9AttestTo = $state("");
  let section9AttestSource: "EAU" | "PAPIER" = $state("EAU");
  let section9File: File | null = $state(null);
  let section9Reason = $state("");
  let section9Saving = $state(false);
  let section9Error = $state("");

  function openSection9Confirm(c: Section9Case) {
    section9ConfirmCase = c;
    section9AttestFrom = c.overlapStart;
    section9AttestTo = c.overlapEnd;
    section9AttestSource = "EAU";
    section9File = null;
    section9Reason = "";
    section9Error = "";
    section9ConfirmOpen = true;
  }

  function closeSection9Confirm() {
    section9ConfirmOpen = false;
    section9ConfirmCase = null;
  }

  // D-26: `api.post` always JSON.stringifies its body and cannot carry multipart/form-data,
  // so this goes through `api.upload` — which, unlike the previous raw fetch (Phase 104
  // review IN-06), shares the client's 401-refresh-and-retry. That matters here more than
  // elsewhere: the upload runs BEFORE the confirm call, so an expired access token used to
  // abort the whole "AU liegt vor" flow with "Upload fehlgeschlagen (401)".
  async function uploadSection9Document(creditId: string, file: File): Promise<void> {
    const formData = new FormData();
    formData.append("file", file);
    await api.upload(`/section9-documents/${creditId}`, formData);
  }

  async function submitSection9Confirm() {
    if (!section9ConfirmCase) return;
    const reason = section9Reason.trim();
    if (!reason) {
      section9Error = "Begründung ist erforderlich (revisionssicherheitspflichtig).";
      return;
    }
    section9Saving = true;
    section9Error = "";
    try {
      // T-104-10-PARTIAL: upload FIRST — a CONFIRMED case must never claim a paper
      // certificate that was never actually stored. Only relevant when a file was
      // actually chosen; "Papier" without a file just means the paper original is
      // kept outside the system (documentPath stays null).
      if (section9AttestSource === "PAPIER" && section9File) {
        await uploadSection9Document(section9ConfirmCase.id, section9File);
      }
      await api.post(`/leave/section9/${section9ConfirmCase.id}/confirm`, {
        attestSource: section9AttestSource,
        attestValidFrom: section9AttestFrom,
        attestValidTo: section9AttestTo,
        reason,
      });
      closeSection9Confirm();
      await reloadAfterSection9();
      toasts.success("AU bestätigt — Urlaubstage gutgeschrieben");
    } catch (e: unknown) {
      section9Error = e instanceof Error ? e.message : "Fehler";
    } finally {
      section9Saving = false;
    }
  }

  // ── Ablehnen / Wieder eröffnen (D-11) ────────────────────────────────────
  let section9RejectCase: Section9Case | null = $state(null);
  let section9RejectOpen = $state(false);

  function openSection9Reject(c: Section9Case) {
    section9RejectCase = c;
    section9RejectOpen = true;
  }

  async function confirmSection9Reject(reason: string) {
    if (!section9RejectCase) return;
    await api.post(`/leave/section9/${section9RejectCase.id}/reject`, { reason });
    section9RejectCase = null;
    await reloadAfterSection9();
    toasts.success("AU-Vorgang abgelehnt");
  }

  async function reopenSection9Case(c: Section9Case) {
    try {
      await api.post(`/leave/section9/${c.id}/reopen`, {});
      await loadSection9Cases();
      toasts.success("Vorgang wieder eröffnet");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    }
  }

  // Phase 104-10: AU_PENDING (needs "AU liegt vor" / Ablehnen) and REJECTED (needs Wieder
  // eröffnen) — a CONFIRMED case is resolved and shown via the badge on the requests table
  // instead.
  let openSection9Cases = $derived(
    section9Cases.filter((c) => c.status === "AU_PENDING" || c.status === "REJECTED"),
  );
</script>

<svelte:head>
  <title>{pageLabel("/inbox")} – Clokr</title>
</svelte:head>

<PageHead title={pageLabel("/inbox")} sub="Entscheidungen, die auf dich warten" />

{#if error}
  <ErrorState message={error} hint="" onRetry={() => void loadRequests()} retrying={loading} />
{/if}

<!-- ── One band: how many decisions wait, per kind the caller can take ─────────── -->
{#if kpiItems.length > 0}
  <div class="aufgaben-band">
    <KpiStrip band ariaLabel="Offene Aufgaben" items={kpiItems} />
  </div>
{/if}

<!-- ── The task list: every decision in one place, oldest first ─────────────────── -->
{#if availableKinds.length > 0}
  <div class="aufgaben-controls">
    {#if availableKinds.length > 1}
      <div class="aufgaben-typ">
        <SegmentedControl
          options={typOptions}
          value={activeTyp}
          name="aufgaben-typ"
          ariaLabel="Art der Aufgabe"
          size="sm"
          onchange={onTypSelected}
        />
      </div>
    {/if}
    <SegmentedControl
      options={ansichtOptions}
      value={taskView.ansicht}
      name="aufgaben-ansicht"
      ariaLabel="Ansicht"
      size="sm"
      onchange={onAnsichtSelected}
    />
  </div>

  <div class="aufgaben-list">
    {#if tasksLoading}
      <Skeleton shape="row" count={3} />
    {:else if visibleTaskRows.length === 0}
      {#if activeTyp !== "alle"}
        <EmptyState
          variant="noMatches"
          description="In dieser Art gibt es hier nichts."
          actionLabel="Alle anzeigen"
          onaction={() => taskUrl.write({ typ: "alle" })}
        />
      {:else if taskView.ansicht === "entschieden"}
        <EmptyState
          icon="inbox"
          title="Noch nichts entschieden"
          description={`Im Jahr ${currentYear} liegt keine entschiedene Aufgabe vor.`}
        />
      {:else}
        <EmptyState
          icon="inbox"
          title="Keine offenen Aufgaben"
          description="Es wartet keine Entscheidung auf dich."
        />
      {/if}
    {:else}
      <List ariaLabel="Aufgaben" testId="inbox-task-list">
        {#each visibleTaskRows as row (row.key)}
          {@const request = leaveOf(row)}
          {@const retro = retroOf(row)}
          {@const c = section9Of(row)}
          <TaskRow
            {row}
            typeLabel={row.typeCode ? typeName(row.typeCode) : undefined}
            rowId={c ? `section9-${c.id}` : undefined}
            highlight={c !== null && highlightSection9Id === c.id}
            onOpen={request
              ? () => openDetail(request)
              : retro
                ? () => openRetroDetail(retro)
                : undefined}
          >
            {#snippet actions()}
              <!--
                One neutral „Prüfen“ button on an open row: the approve/reject controls live inside
                the dialog, behind an explicit confirmation step (REVIEW WR-02), so the row never
                offers an immediate decision. A decided row has no button; its title opens the
                details.
              -->
              {#if c}
                <!-- § 9 (Phase 104-10, R6/D-11): the three existing actions, unchanged handlers -->
                {#if c.status === "AU_PENDING"}
                  <button
                    class="btn btn-sm btn-primary"
                    data-testid={`section9-case-${c.id}-confirm`}
                    onclick={() => openSection9Confirm(c)}
                  >
                    AU liegt vor
                  </button>
                  <button
                    class="btn btn-sm btn-ghost text-red"
                    data-testid={`section9-case-${c.id}-reject`}
                    onclick={() => openSection9Reject(c)}
                  >
                    Ablehnen
                  </button>
                {:else if c.status === "REJECTED"}
                  <button
                    class="btn btn-sm btn-ghost"
                    data-testid={`section9-case-${c.id}-reopen`}
                    onclick={() => reopenSection9Case(c)}
                  >
                    Wieder eröffnen
                  </button>
                {/if}
              {:else if row.kind === "pausenbefund" || row.kind === "ausstempeln" || row.kind === "zeitkorrektur"}
                <!--
                  No decision path of its own: the acknowledgement / correction happens on Zeiten with
                  the existing dialogs. A row whose stored link is not a same-origin app path has no link.
                -->
                {#if row.href}
                  <a class="btn btn-primary btn-sm" href={row.href}>
                    {row.kind === "pausenbefund"
                      ? "Klären"
                      : row.kind === "ausstempeln"
                        ? "Korrigieren"
                        : "Prüfen"}
                  </a>
                {/if}
              {:else if !row.decided}
                <button
                  class="btn btn-primary btn-sm"
                  onclick={() => (request ? openDetail(request) : retro && openRetroDetail(retro))}
                >
                  Prüfen
                </button>
              {/if}
            {/snippet}
          </TaskRow>
        {/each}
      </List>
    {/if}
  </div>
{/if}

<!-- ── Zeitnachtrag decision: a Dialog with a fact list (Issue #853, D-853-18) ───────── -->
{#if retroDetail}
  <RetroReviewBody
    bind:open={retroDetailOpen}
    personName={`${retroDetail.employee.firstName} ${retroDetail.employee.lastName}`}
    dayLabel={fmtDate(retroDetail.targetDate)}
    proposedLabel={retroDetail.startTime && retroDetail.endTime
      ? `${retroDetail.startTime}–${retroDetail.endTime}${
          retroDetail.breakMinutes ? ` · Pause ${retroDetail.breakMinutes} Min.` : ""
        }`
      : null}
    entryAgeInDays={retroDetail.entryAgeInDays ?? null}
    employeeReason={retroDetail.reason}
    ageWarning={retroDetail.entryAgeInDays != null &&
    retroDetail.windowDays != null &&
    retroDetail.entryAgeInDays > retroDetail.windowDays
      ? `Eintrag vom ${fmtDate(retroDetail.targetDate)} liegt ${retroDetail.entryAgeInDays} Tage in der Vergangenheit (Fenster: ${retroDetail.windowDays} Tage).`
      : null}
    editableTimes={Boolean(retroDetail.startTime && retroDetail.endTime)}
    bind:startTime={retroEditStartTime}
    bind:endTime={retroEditEndTime}
    bind:breakMinutes={retroEditBreakMinutes}
    bind:reviewNote={retroReviewNote}
    saving={retroReviewSaving}
    error={retroReviewError}
    pending={retroDetail.status === "PENDING"}
    selfApproval={isRetroSelfApproval(retroDetail)}
    onApprove={() => submitRetroReview("APPROVED")}
    onReject={() => submitRetroReview("REJECTED")}
    onCancel={closeRetroDetail}
  />
{/if}

<!-- ── Phase 104-10 (R6/D-27/D-26): "AU liegt vor" — Confirm-Dialog (Issue #853: facts + fields) ── -->
{#if section9ConfirmCase}
  <Dialog bind:open={section9ConfirmOpen} eyebrow="§ 9 BUrlG" title="AU liegt vor">
    <div data-testid="section9-confirm-modal" style="display: contents">
      <dl class="facts">
        <div class="fact">
          <dt>Person</dt>
          <dd>{section9ConfirmCase.employeeName}</dd>
        </div>
        <div class="fact">
          <dt>Überschneidung</dt>
          <dd>
            {fmtDate(section9ConfirmCase.overlapStart)} – {fmtDate(section9ConfirmCase.overlapEnd)}
          </dd>
        </div>
      </dl>

      <div class="review-section">
        <fieldset class="attest-fieldset">
          <legend class="attest-legend">Gültigkeit der AU</legend>
          <div class="attest-dates">
            <FormField label="Gültig von">
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  type="date"
                  bind:value={section9AttestFrom}
                  class="form-input attest-date-input"
                  aria-describedby={describedBy}
                  aria-invalid={invalid ? "true" : undefined}
                />
              {/snippet}
            </FormField>
            <FormField label="Gültig bis">
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  type="date"
                  bind:value={section9AttestTo}
                  class="form-input attest-date-input"
                  aria-describedby={describedBy}
                  aria-invalid={invalid ? "true" : undefined}
                />
              {/snippet}
            </FormField>
          </div>
        </fieldset>
      </div>

      <div class="review-section">
        <fieldset class="attest-fieldset">
          <legend class="attest-legend">Herkunft</legend>
          <label class="toggle-label">
            <input type="radio" name="s9-source" value="EAU" bind:group={section9AttestSource} />
            <span>eAU abgerufen</span>
          </label>
          <label class="toggle-label">
            <input type="radio" name="s9-source" value="PAPIER" bind:group={section9AttestSource} />
            <span>Papier</span>
          </label>
        </fieldset>
      </div>

      {#if section9AttestSource === "PAPIER"}
        <div class="review-section">
          <FormField label="Papier-AU (optional)" help="PDF, JPG oder PNG, max. 10 MB.">
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                class="form-input"
                aria-describedby={describedBy}
                aria-invalid={invalid ? "true" : undefined}
                onchange={(e) => (section9File = (e.target as HTMLInputElement).files?.[0] ?? null)}
              />
            {/snippet}
          </FormField>
        </div>
      {/if}

      <div class="review-section">
        <FormField
          label="Begründung"
          required
          help="Verwaltungsvermerk zur Nachvollziehbarkeit — bitte keine Diagnose oder Arztangaben eintragen."
        >
          {#snippet field({ id, describedBy, invalid })}
            <textarea
              {id}
              class="form-input"
              rows="2"
              bind:value={section9Reason}
              placeholder="Verwaltungsvermerk zur Nachvollziehbarkeit"
              aria-describedby={describedBy}
              aria-invalid={invalid ? "true" : undefined}
            ></textarea>
          {/snippet}
        </FormField>
      </div>

      {#if section9Error}
        <div class="review-section" role="alert">
          <Note tone="bad">{section9Error}</Note>
        </div>
      {/if}
    </div>

    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeSection9Confirm} disabled={section9Saving}>
        Abbrechen
      </button>
      <button
        class="btn btn-primary"
        data-testid="section9-confirm-submit"
        onclick={submitSection9Confirm}
        disabled={section9Saving || !section9Reason.trim()}
      >
        {section9Saving ? "…" : "Bestätigen"}
      </button>
    {/snippet}
  </Dialog>
{/if}

<!-- ── Phase 104-10 (D-11): "AU liegt vor" — Ablehnen-Begründung ─────────────── -->
{#if section9RejectCase}
  <ReasonDialog
    bind:open={section9RejectOpen}
    title="AU ablehnen"
    description="Trifft die AU später ein, kann der Vorgang wieder eröffnet werden."
    confirmLabel="Ablehnen"
    danger
    onConfirm={confirmSection9Reject}
    onCancel={() => (section9RejectCase = null)}
  />
{/if}

<!-- ── Leave detail modal (Phase 255: the shared LeaveReviewDialog component) ──────── -->
<LeaveReviewDialog
  bind:open={detailOpen}
  request={detailRequest}
  currentEmployeeId={$authStore.user?.employeeId ?? null}
  canReadEntitlement={hasPermission($authStore.user, "leave-entitlement:read:ZUGEWIESEN")}
  canReadShifts={hasPermission($authStore.user, "shift:read:ZUGEWIESEN")}
  canReadEmployee={hasPermission($authStore.user, "employee:read:ZUGEWIESEN")}
  onReviewed={loadRequests}
/>

<style>
  /* ── Page top (Issue #853): the band and the one list stack with the page rhythm ── */
  .aufgaben-band,
  .aufgaben-list {
    margin-bottom: var(--s-4);
  }

  /* The type segment can hold up to six kinds: on a narrow screen it scrolls inside its own box
     instead of widening the page. */
  .aufgaben-typ {
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
  }

  /* The type and view segments share one row; they wrap on a phone. */
  .aufgaben-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
    margin-bottom: var(--s-3);
  }

  /* ── § 9 confirm dialog (Issue #853): facts as a definition list, fields as FormField ── */
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3) var(--s-6);
    margin: 0;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .fact dt {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .fact dd {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .review-section {
    margin-top: var(--s-5);
  }
  .attest-fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .attest-legend {
    padding: 0;
    margin-bottom: var(--s-2);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .attest-dates {
    display: flex;
    gap: var(--s-4);
    flex-wrap: wrap;
  }
  .attest-date-input {
    max-width: 160px;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
    font-weight: 500;
  }

  @media (max-width: 560px) {
    .facts {
      grid-template-columns: 1fr;
    }
  }
</style>
