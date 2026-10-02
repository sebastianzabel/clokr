<script lang="ts">
  /**
   * LeaveRequestForm — Phase 415 (GitHub issue #415).
   *
   * The ONE shared create/edit dialog for an absence request. Before this phase, `/leave`'s own
   * dialog and `/team/leave`'s own dialog each carried a separate copy — the team copy was
   * missing the Resturlaub and Antragskosten figures, the § 9/Überstunden balance boxes, the
   * insufficient-Resturlaub warning, and the Anlass picker for Sonderurlaub. Owner decision
   * (Issue #415, 2026-09-29): ONE shared dialog, like `LeaveReviewDialog.svelte` (Phase 255)
   * already is for the review flow. Every figure this component shows (Resturlaub,
   * Antragskosten, warnings, the hours/day preview, colleagues in the same period,
   * half-day/type rules) refers to `employeeId` — the CALLER's own profile on `/leave`, the
   * SELECTED person on `/team/leave`.
   *
   * The person picker itself is NOT part of this component (Phase 415 CONTEXT, D-03): the page
   * renders it via the optional `personPicker` snippet, prepended above this component's own
   * fields, so the two contexts differ by exactly that one addition and nothing else (D-13 —
   * identical field order otherwise).
   *
   * No `$stores/auth` import, same reasoning as `LeaveReviewDialog.svelte`'s own doc comment: the
   * auth store module transitively pulls in SvelteKit's environment module, which
   * `apps/web/vitest.config.ts` has no alias for, so a component importing it cannot be mounted
   * in vitest. `employeeId` therefore comes in as a required prop, never read from the store.
   */
  import { preventDefault } from "svelte/legacy";
  import type { Snippet } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import CollisionWarnBody from "$lib/phorest/CollisionWarnBody.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte";
  import {
    checkAppointmentCollisions,
    COLLISION_UNAVAILABLE_TOAST,
    type CollisionSummary,
  } from "$lib/phorest/appointmentCollisions";
  import {
    mapVacationBalance,
    type VacationBalance,
    type VacationEntitlementRow,
  } from "$lib/leave/vacation-balance";
  import { deriveVacationSummary } from "$lib/leave/vacation-summary";
  import { SICK_TYPE_CODES } from "$lib/leave/leave-kind";
  import { halfDayRangeError, endDateForHalfDay } from "$lib/leave/half-day";
  import {
    LEAVE_TYPE_OPTIONS,
    NEUTRAL_CHIP_LABEL,
    type CalendarTypeCode,
  } from "$lib/leave/team-calendar-visibility";
  import type { EditableLeaveRequest } from "$lib/leave/leave-request-form";

  // ── Types ────────────────────────────────────────────────────────────────
  interface OverlapEntry {
    id: string;
    employeeName: string;
    typeCode: string | null;
    typeName: string | null;
    startDate: string;
    endDate: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";
  }

  interface SpecialLeaveRule {
    id: string;
    name: string;
    defaultDays: number;
    isActive: boolean;
  }

  interface OvertimeBalanceResponse {
    balanceHours: number;
    confirmedMinutes: number;
    openMonthMinutes: number | null;
    hasClosedMonth?: boolean;
    rosterIncomplete?: boolean;
    maxNegativeBalanceMinutes: number | null;
    isNegativeLimitExceeded: boolean;
  }

  interface Props {
    /** Bindable open state, exactly like Modal/ConfirmDialog. */
    open: boolean;
    /** The profile every figure in this dialog refers to — the caller's own on `/leave`, the
     *  selected person on `/team/leave`. Empty string means "no person selected yet" (team
     *  context before a pick) — the dialog then shows a hint instead of fetching anything. */
    employeeId: string;
    /** Non-null = edit an existing PENDING request; null = create. */
    editingRequest?: EditableLeaveRequest | null;
    /** Seeds the date fields on a fresh CREATE open (calendar drag-select / day click). Ignored
     *  in edit mode (the request's own dates win) and left blank when omitted. */
    initialStartDate?: string;
    initialEndDate?: string;
    /** The year `/leave/entitlements/:employeeId` is queried with — the calendar year the PAGE
     *  is currently showing (`calYear` on both `/leave` and `/team/leave`), not necessarily the
     *  real-world current year. Defaults to the real-world current year when omitted. This
     *  component's own entitlement fetch is independent of any page-level KPI strip's fetch of
     *  the same data (Phase 415: two independent reads of the same endpoint, not a shared
     *  writer — see the component doc comment) — kept in the same YEAR to still show identical
     *  figures. */
    entitlementYear?: number;
    /** Page-specific reload after a successful create/edit. */
    onSaved: () => void | Promise<void>;
    /** Team-context-only addition (Phase 415, D-03): the person picker. Rendered above this
     *  component's own first field. Omitted on `/leave` — nothing extra renders there. */
    personPicker?: Snippet;
  }

  let {
    open = $bindable(),
    employeeId,
    editingRequest = null,
    initialStartDate = "",
    initialEndDate = "",
    entitlementYear = new Date().getFullYear(),
    onSaved,
    personPicker,
  }: Props = $props();

  // ── Form state ───────────────────────────────────────────────────────────
  let formType: CalendarTypeCode = $state("VACATION");
  let formStart = $state("");
  let formEnd = $state("");
  let formHalfDay = $state(false);
  let formNote = $state("");
  let formSaving = $state(false);
  let formError = $state("");

  let specialLeaveRules: SpecialLeaveRule[] = $state([]);
  let formSpecialRuleId = $state("");

  // Überstunden- / Urlaubskontostand — for `employeeId`, not necessarily the viewer.
  let overtimeBalance: number | null = $state(null);
  let confirmedMinutes: number | undefined = $state(undefined);
  let openMonthMinutes: number | null | undefined = $state(undefined);
  let hasClosedMonth = $state(false);
  let maxNegativeBalanceMinutes: number | null | undefined = $state(undefined);
  let isNegativeLimitExceeded: boolean | undefined = $state(undefined);
  let vacationBalance = $state<VacationBalance | null>(null);
  // Phase 415 (D-10/D-11): distinguishes "still loading" from "loaded, no entitlement row for
  // this year" — the latter renders the explicit hint instead of an empty/zero balance box.
  let vacationBalanceLoading = $state(false);

  let hoursPreview: number | null = $state(null);
  let minutesNeeded: number | null = $state(null);
  let serverDays: number | null = $state(null);
  let hoursPreviewLoading = $state(false);
  let hoursPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  // Phase 430 Plan 04 (D-15/D-16): `null` = not (yet) loaded / not applicable (never renders the
  // hint below); `false` is the ONLY value that renders it — a SHIFT_BASED employee's requested
  // week has no imported roster yet. Every other schedule type reports `true` from the server
  // (D-15), so the hint never fires for them.
  let rosterImported: boolean | null = $state(null);

  let overlapEntries: OverlapEntry[] = $state([]);
  let overlapLoading = $state(false);
  let overlapTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Phase 87: appointment-collision warn-and-confirm on CREATE only ────────
  let collisionConfirmOpen = $state(false);
  let collisionSummary = $state<CollisionSummary | null>(null);
  type PendingCreate = {
    type: CalendarTypeCode;
    startDate: string;
    endDate: string;
    halfDay: boolean;
    note: string;
    specialLeaveRuleId?: string;
  };
  let pendingCreate = $state<PendingCreate | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function typeName(code: CalendarTypeCode): string {
    return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function daysLabel(days: number, halfDay: boolean): string {
    if (halfDay) return "½ Tag";
    return days === 1 ? "1 Tag" : `${days} Tage`;
  }

  function calcDays(start: string, end: string, halfDay: boolean): number {
    if (!start || !end || start > end) return 0;
    if (halfDay) return 0.5;
    let days = 0;
    const cur = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (cur <= endD) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) days++;
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function fmtH(h: number): string {
    const abs = Math.abs(h);
    const hh = Math.floor(abs);
    const mm = Math.round((abs - hh) * 60);
    return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  let formDays = $derived(calcDays(formStart, formEnd, formHalfDay));
  let effectiveDays = $derived(serverDays ?? formDays);
  let hoursNeeded = $derived(hoursPreview ?? formDays * 8);
  let confirmedHours = $derived(
    confirmedMinutes !== undefined ? confirmedMinutes / 60 : (overtimeBalance ?? 0),
  );
  let toleranceHours = $derived((maxNegativeBalanceMinutes ?? 0) / 60);
  let wouldBeRejected = $derived(
    minutesNeeded !== null && confirmedMinutes !== undefined
      ? confirmedMinutes + (maxNegativeBalanceMinutes ?? 0) < minutesNeeded
      : confirmedHours + toleranceHours - hoursNeeded < 0,
  );
  // `pendingVacDays` (the second arg) is intentionally 0 here: `VacationSummary.remaining` does
  // not depend on it (verbatim formula: total + carryOver - used — see vacation-summary.ts), and
  // this dialog has no page-scoped PENDING-request list to derive it from. Reusing the shared
  // function rather than re-inlining the formula honors that file's own "do not re-inline" rule.
  let vacSummary = $derived(deriveVacationSummary(vacationBalance, 0));
  let vacRemaining = $derived(vacSummary.remaining);
  let vacAfter = $derived(vacRemaining !== null ? vacRemaining - effectiveDays : null);
  // Issue #449 (D-4): non-null whenever halfDay is ticked and the dates differ — true both for a
  // user-driven edit mid-flight and for a loaded legacy multi-day half-day request (which this
  // component never silently rewrites on open, see the editingRequest $effect below).
  let halfDayRangeErrorText = $derived(halfDayRangeError(formHalfDay, formStart, formEnd));

  // ── Loaders ──────────────────────────────────────────────────────────────
  async function loadSpecialLeaveRules() {
    if (specialLeaveRules.length > 0) return;
    try {
      const all = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
      specialLeaveRules = all.filter((r) => r.isActive);
    } catch {
      /* ignore */
    }
  }

  // Mirrors `/leave`'s former loadBalanceForType(): a transient failure must not blank an
  // already-displayed value (Issue #258 hardening) — both catch arms are deliberately empty.
  async function loadBalanceForType(type: CalendarTypeCode, forEmployeeId: string, year: number) {
    if (!forEmployeeId) return;
    if (type === "OVERTIME_COMP") {
      try {
        const r = await api.get<OvertimeBalanceResponse>(
          `/leave/overtime-balance?employeeId=${forEmployeeId}`,
        );
        overtimeBalance = r.balanceHours;
        confirmedMinutes = r.confirmedMinutes;
        openMonthMinutes = r.openMonthMinutes;
        hasClosedMonth = r.hasClosedMonth ?? false;
        maxNegativeBalanceMinutes = r.maxNegativeBalanceMinutes;
        isNegativeLimitExceeded = r.isNegativeLimitExceeded;
      } catch {
        // Deliberately empty — keep whatever is already on screen.
      }
    } else if (type === "VACATION") {
      vacationBalanceLoading = true;
      try {
        const entitlements = await api.get<VacationEntitlementRow[]>(
          `/leave/entitlements/${forEmployeeId}?year=${year}`,
        );
        const vac = entitlements.find((e) => e.typeCode === "VACATION");
        vacationBalance = mapVacationBalance(vac);
      } catch {
        // Issue #258/#122 hardening, carried over from `/leave`'s former loadBalanceForType():
        // clear ONLY when `entitlementYear` moved while this request was in flight — otherwise a
        // stale error for a superseded year would wipe the current year's already-successful
        // value. `year` is the value this call was made with (closure-captured); comparing it
        // against the LIVE `entitlementYear` prop is the same check the original made against
        // `calYear`.
        if (year !== entitlementYear) vacationBalance = null;
      } finally {
        vacationBalanceLoading = false;
      }
    }
  }

  function scheduleOverlapLoad() {
    if (overlapTimer) clearTimeout(overlapTimer);
    if (!formStart || !formEnd || formStart > formEnd) {
      overlapEntries = [];
      return;
    }
    overlapTimer = setTimeout(doLoadOverlap, 300);
  }

  async function doLoadOverlap() {
    const start = formStart;
    const end = formEnd;
    if (!start || !end || start > end) return;
    overlapLoading = true;
    try {
      overlapEntries = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${start}&endDate=${end}`,
      );
    } catch {
      overlapEntries = [];
    } finally {
      overlapLoading = false;
    }
  }

  function scheduleHoursPreview() {
    if (hoursPreviewTimer) clearTimeout(hoursPreviewTimer);
    if (!formStart || !formEnd || formStart > formEnd || !employeeId) {
      hoursPreview = null;
      minutesNeeded = null;
      serverDays = null;
      rosterImported = null;
      return;
    }
    hoursPreviewTimer = setTimeout(loadHoursPreview, 300);
  }

  async function loadHoursPreview() {
    if (!formStart || !formEnd || !employeeId) return;
    hoursPreviewLoading = true;
    try {
      // Issue #436 (D-04): the dialog shows the price the server will store — `type` lets the
      // server apply the SAME week-union pricing a real request would get; in edit mode
      // `excludeRequestId` excludes the request being edited from its own siblings (D-09).
      const r = await api.get<{
        hours: number;
        days: number;
        minutesNeeded: number;
        rosterImported?: boolean;
      }>(
        `/leave/hours-preview?startDate=${formStart}&endDate=${formEnd}&halfDay=${formHalfDay}&employeeId=${employeeId}&type=${encodeURIComponent(formType)}${
          editingRequest ? `&excludeRequestId=${encodeURIComponent(editingRequest.id)}` : ""
        }`,
      );
      hoursPreview = r.hours;
      minutesNeeded = r.minutesNeeded;
      serverDays = r.days;
      // Phase 430 Plan 04 (D-15): absent (non-SHIFT_BASED omission path) reads as `true` — the
      // hint never fires for a schedule type the server didn't compute this signal for.
      rosterImported = r.rosterImported ?? true;
    } catch {
      hoursPreview = null;
      minutesNeeded = null;
      serverDays = null;
      rosterImported = null;
    } finally {
      hoursPreviewLoading = false;
    }
  }

  // ── Form lifecycle ───────────────────────────────────────────────────────
  function resetFormFields() {
    formType = "VACATION";
    formStart = initialStartDate;
    formEnd = initialEndDate;
    formHalfDay = false;
    formNote = "";
    formSpecialRuleId = "";
    overlapEntries = [];
    hoursPreview = null;
    minutesNeeded = null;
    serverDays = null;
    rosterImported = null;
  }

  $effect(() => {
    if (open) {
      if (editingRequest) {
        formType = editingRequest.typeCode;
        formStart = editingRequest.startDate;
        formEnd = editingRequest.endDate;
        formHalfDay = editingRequest.halfDay;
        formNote = editingRequest.note ?? "";
        formSpecialRuleId = "";
      } else {
        resetFormFields();
      }
      formError = "";
    }
  });

  $effect(() => {
    if (open) {
      formStart;
      formEnd;
      scheduleOverlapLoad();
    }
  });
  $effect(() => {
    if (open) {
      formStart;
      formEnd;
      formHalfDay;
      employeeId;
      // Issue #436 (D-04): the preview price depends on the leave type (only VACATION is
      // week-union priced) — a type change must refresh serverDays too.
      formType;
      scheduleHoursPreview();
    }
  });
  $effect(() => {
    if (open) loadBalanceForType(formType, employeeId, entitlementYear);
  });
  // § 8 BUrlG / EFZG §3-4: partial incapacity to work does not exist — half-day sick leave is
  // rejected by the server at all write paths, so the checkbox is disabled and any already-set
  // selection is discarded when the type changes to a sick type.
  $effect(() => {
    if (SICK_TYPE_CODES.has(formType)) formHalfDay = false;
  });

  // ── Half day = one date (Issue #449, D-4) ───────────────────────────────────
  // Sync runs ONLY on these two user actions (function bindings below), never reactively on
  // load — an $effect watching formStart/formHalfDay would also fire when `editingRequest`
  // populates them, silently collapsing a loaded legacy multi-day half-day request's end date.
  function setFormStart(value: string) {
    formStart = value;
    formEnd = endDateForHalfDay(formHalfDay, formStart, formEnd);
  }

  function setFormHalfDay(value: boolean) {
    formHalfDay = value;
    formEnd = endDateForHalfDay(formHalfDay, formStart, formEnd);
  }

  // ── Submit / mutation ────────────────────────────────────────────────────
  async function submitRequest() {
    if (!employeeId) {
      formError = "Bitte einen Mitarbeiter auswählen";
      return;
    }
    if (halfDayRangeErrorText) {
      formError = halfDayRangeErrorText;
      return;
    }
    if (editingRequest) {
      await performLeaveMutation();
      return;
    }
    const summary = await checkAppointmentCollisions({
      employeeId,
      from: formStart,
      to: formEnd,
    });
    if (summary && summary.total > 0) {
      pendingCreate = {
        type: formType,
        startDate: formStart,
        endDate: formEnd,
        halfDay: SICK_TYPE_CODES.has(formType) ? false : formHalfDay,
        note: formNote,
        ...(formType === "SPECIAL" && formSpecialRuleId
          ? { specialLeaveRuleId: formSpecialRuleId }
          : {}),
      };
      collisionSummary = summary;
      // Close the form Modal so exactly ONE scrim is live, mirrors LeaveReviewDialog's own
      // collision-dialog interaction.
      open = false;
      collisionConfirmOpen = true;
      return;
    }
    if (summary === null) {
      toasts.error(COLLISION_UNAVAILABLE_TOAST);
    }
    await performLeaveMutation();
  }

  async function confirmCreateWithCollisions() {
    const ok = await performLeaveMutation();
    if (!ok) throw new Error("Antrag konnte nicht eingereicht werden");
  }

  function cancelCreateCollision() {
    pendingCreate = null;
    collisionSummary = null;
  }

  async function performLeaveMutation(): Promise<boolean> {
    formSaving = true;
    formError = "";
    try {
      if (editingRequest) {
        await api.patch(`/leave/requests/${editingRequest.id}`, {
          startDate: formStart,
          endDate: formEnd,
          halfDay: SICK_TYPE_CODES.has(formType) ? false : formHalfDay,
          note: formNote || null,
        });
      } else {
        const src: PendingCreate = pendingCreate ?? {
          type: formType,
          startDate: formStart,
          endDate: formEnd,
          halfDay: SICK_TYPE_CODES.has(formType) ? false : formHalfDay,
          note: formNote,
          ...(formType === "SPECIAL" && formSpecialRuleId
            ? { specialLeaveRuleId: formSpecialRuleId }
            : {}),
        };
        // `employeeId` is ALWAYS sent (never conditionally omitted): the server treats
        // `employeeId === req.user.employeeId` as the plain self-create path and anything else
        // as manager-on-behalf-of (`apps/api/src/contexts/absence/api/leave.ts` POST /requests) —
        // sending it unconditionally is therefore behavior-preserving for `/leave` too.
        await api.post("/leave/requests", {
          employeeId,
          type: src.type,
          startDate: src.startDate,
          endDate: src.endDate,
          halfDay: src.halfDay,
          note: src.note || null,
          ...(src.type === "SPECIAL" && src.specialLeaveRuleId
            ? { specialLeaveRuleId: src.specialLeaveRuleId }
            : {}),
        });
      }
      open = false;
      pendingCreate = null;
      collisionSummary = null;
      await onSaved();
      return true;
    } catch (e: unknown) {
      // Issue #449 (D-1): prefer the thrown ApiError's own message — it already carries
      // "category: detail" (error-message.ts) — over the bare category in `.data.error`.
      const apiErr = e as { data?: { error?: string }; message?: string };
      formError = (e instanceof Error && e.message) || apiErr?.data?.error || "Fehler";
      // On the collision-confirm path the form Modal is already closed, so the inline error is
      // not visible — surface it via a toast instead.
      if (!open) toasts.error(formError);
      return false;
    } finally {
      formSaving = false;
    }
  }
</script>

<Modal
  bind:open
  eyebrow={typeName(formType)}
  title={editingRequest
    ? "Antrag bearbeiten"
    : personPicker
      ? "Neue Abwesenheit anlegen"
      : "Neuer Abwesenheitsantrag"}
>
  <div data-testid="leave-form-modal" style="display: contents">
    {#if formError}
      <div
        class="alert alert-error"
        role="alert"
        style="margin-bottom:1rem"
        data-testid="leave-form-error"
      >
        <span>⚠</span><span>{formError}</span>
      </div>
    {/if}

    <form
      id="leave-form"
      data-testid="leave-form"
      onsubmit={preventDefault(submitRequest)}
      class="form-grid"
    >
      {#if personPicker}
        {@render personPicker()}
      {/if}

      <div class="form-group">
        <label class="form-label" for="f-type">Art der Abwesenheit</label>
        <select
          id="f-type"
          data-testid="leave-form-type"
          bind:value={formType}
          class="form-input"
          disabled={!!editingRequest}
          onchange={() => {
            if (formType === "SPECIAL") loadSpecialLeaveRules();
          }}
        >
          {#each LEAVE_TYPE_OPTIONS as t (t.code)}
            <option value={t.code}>{t.label}</option>
          {/each}
        </select>
      </div>

      {#if formType === "SPECIAL"}
        <div class="form-group">
          <label class="form-label" for="f-special-rule">Anlass</label>
          <select id="f-special-rule" bind:value={formSpecialRuleId} class="form-input" required>
            <option value="">— Anlass wählen —</option>
            {#each specialLeaveRules as rule (rule.id)}
              <option value={rule.id}>{rule.name} ({Number(rule.defaultDays)} Tage)</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="f-start">Von</label>
        <input
          id="f-start"
          data-testid="leave-form-from"
          type="date"
          bind:value={() => formStart, setFormStart}
          required
          class="form-input"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="f-end">Bis</label>
        <input
          id="f-end"
          data-testid="leave-form-to"
          type="date"
          bind:value={formEnd}
          required
          min={formStart}
          disabled={formHalfDay}
          class="form-input"
        />
        {#if halfDayRangeErrorText}
          <p class="form-hint" data-testid="leave-form-half-day-range-hint">
            {halfDayRangeErrorText}
          </p>
        {/if}
      </div>

      {#if !employeeId}
        <div class="form-group form-group--full">
          <p class="form-hint">Bitte zuerst einen Mitarbeiter auswählen.</p>
        </div>
      {/if}

      <!-- Phase 430 Plan 04 (D-15/D-16): Schichtplan für die beantragte Woche noch nicht
           importiert — impersonal, matching this dialog's own register (no Du/Sie anywhere). -->
      {#if rosterImported === false}
        <div class="form-group form-group--full">
          <p class="form-hint" data-testid="leave-form-roster-hint">
            Für diese Woche steht der Schichtplan noch nicht fest. Bitte alle Tage beantragen, die
            frei sein sollen – auch den Samstag.
          </p>
        </div>
      {/if}

      <!-- Überstundensaldo-Info -->
      {#if employeeId && formType === "OVERTIME_COMP" && overtimeBalance !== null}
        <div class="form-group form-group--full">
          <div class="balance-box">
            <div class="balance-row">
              <span class="balance-label">Guthaben</span>
              {#if !hasClosedMonth}
                <span class="balance-value">
                  <SaldoAnzeige
                    variant="compact"
                    confirmedMinutes={confirmedMinutes ?? 0}
                    hasClosedMonth={false}
                  />
                </span>
              {:else}
                <span class="balance-value">{fmtH(confirmedHours)}</span>
              {/if}
            </div>
            {#if toleranceHours > 0}
              <div class="balance-row">
                <span class="balance-label">Toleranz</span>
                <span class="balance-value">+ {fmtH(toleranceHours)}</span>
              </div>
            {/if}
            {#if isNegativeLimitExceeded === true}
              <p class="balance-hint-notice">
                ⚠ Guthaben übersteigt bereits die Toleranzgrenze ({fmtH(toleranceHours)})
              </p>
            {/if}
            {#if typeof openMonthMinutes === "number"}
              <div class="balance-row">
                <span class="balance-label">Laufender Monat (Prognose)</span>
                <span class="balance-value balance-value--muted">{fmtH(openMonthMinutes / 60)}</span
                >
              </div>
              <p class="balance-hint-muted">
                Noch nicht abrufbar – wird mit dem Monatsabschluss zu „Bestätigt".
              </p>
            {/if}
            {#if effectiveDays > 0 || formHalfDay}
              <div class="balance-row">
                <span class="balance-label"
                  >Wird genutzt ({daysLabel(effectiveDays, formHalfDay)})</span
                >
                <span class="balance-value balance-deduct">
                  {#if hoursPreviewLoading}<span class="text-muted">…</span>{:else}− {fmtH(
                      hoursNeeded,
                    )}{/if}
                </span>
              </div>
              <div class="balance-divider"></div>
              <div class="balance-row">
                <span class="balance-label">Verbleibend</span>
                <span class="balance-value {wouldBeRejected ? 'balance-warn' : ''}">
                  {#if hoursPreviewLoading}<span class="text-muted">…</span>{:else}{fmtH(
                      confirmedHours - hoursNeeded,
                    )}{/if}
                </span>
              </div>
              {#if !hoursPreviewLoading && wouldBeRejected}
                <p class="balance-hint-warn">
                  ⚠ Nicht genug Überstunden vorhanden{toleranceHours > 0
                    ? " (auch mit Toleranz)"
                    : ""}
                </p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      <!-- Tage-Info -->
      {#if formStart && formEnd && formStart <= formEnd && (formDays > 0 || formHalfDay)}
        <div class="form-group form-group--full" data-testid="leave-form-days-calc">
          <div class="days-info-bar">
            <span class="days-info-icon">📅</span>
            <span class="days-info-text">
              <strong>{daysLabel(effectiveDays, formHalfDay)}</strong>
              {#if hoursPreviewLoading}
                <span class="days-info-note">(Feiertage werden geprüft…)</span>
              {:else if serverDays !== null && serverDays !== formDays}
                <span class="days-info-note">(Feiertage berücksichtigt)</span>
              {/if}
            </span>
          </div>
        </div>
      {/if}

      <!-- Urlaubssaldo-Info -->
      {#if employeeId && formType === "VACATION"}
        <div class="form-group form-group--full">
          {#if vacationBalanceLoading}
            <div class="balance-box"><span class="text-muted">Lädt…</span></div>
          {:else if vacationBalance === null}
            <!-- Phase 415 (D-10): explicit instead of empty/zero — root-cause fix is #416. -->
            <p class="balance-hint-warn" data-testid="leave-form-no-entitlement">
              Für dieses Jahr ist kein Urlaubsanspruch hinterlegt.
            </p>
          {:else}
            <div class="balance-box">
              <div class="balance-row">
                <span class="balance-label">Jahresanspruch</span>
                <span class="balance-value">{vacationBalance.total} Tage</span>
              </div>
              {#if vacationBalance.carryOver > 0}
                <div class="balance-row">
                  <span class="balance-label">
                    Übertrag Vorjahr
                    {#if vacationBalance.carryOverDeadline}
                      <span class="balance-meta"
                        >(verfällt {fmtDate(vacationBalance.carryOverDeadline)})</span
                      >
                    {/if}
                  </span>
                  <span class="balance-value">+ {vacationBalance.carryOver} Tage</span>
                </div>
              {/if}
              <div class="balance-row">
                <span class="balance-label"
                  >{vacationBalance.provisionalUsed > 0
                    ? "Verbraucht (bestätigt)"
                    : "Genommen"}</span
                >
                <span class="balance-value"
                  >− {vacationBalance.used - vacationBalance.provisionalUsed} Tage</span
                >
              </div>
              {#if vacationBalance.provisionalUsed > 0}
                <div class="balance-row">
                  <span class="balance-label">Verbraucht (vorläufig)</span>
                  <span class="balance-value balance-value--muted"
                    >− {vacationBalance.provisionalUsed} Tage</span
                  >
                </div>
              {/if}
              <div class="balance-row">
                <span class="balance-label">Resturlaub</span>
                <span class="balance-value">{vacRemaining} Tage</span>
              </div>
              {#if vacationBalance.section9Movements?.length}
                <ul class="section9-movements">
                  {#each vacationBalance.section9Movements ?? [] as m (m.creditId)}
                    <li class="section9-movement" data-testid="section9-movement">{m.label}</li>
                  {/each}
                </ul>
              {/if}
              {#if effectiveDays > 0 || formHalfDay}
                <div class="balance-row">
                  <span class="balance-label">
                    Wird genutzt
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      ({daysLabel(
                        effectiveDays,
                        formHalfDay,
                      )}{#if serverDays !== null && serverDays !== formDays}, Feiertage abgezogen{/if})
                    {/if}
                  </span>
                  <span class="balance-value balance-deduct">
                    {#if hoursPreviewLoading}<span class="text-muted">…</span>{:else}− {effectiveDays}
                      {effectiveDays === 1 ? "Tag" : "Tage"}{/if}
                  </span>
                </div>
                <div class="balance-divider"></div>
                <div class="balance-row">
                  <span class="balance-label">Verbleibend</span>
                  <span class="balance-value {(vacAfter ?? 0) < 0 ? 'balance-warn' : ''}">
                    {#if hoursPreviewLoading}<span class="text-muted">…</span>{:else}{vacAfter}
                      {(vacAfter ?? 0) === 1 ? "Tag" : "Tage"}{/if}
                  </span>
                </div>
                {#if !hoursPreviewLoading && (vacAfter ?? 0) < 0}
                  <p class="balance-hint-warn">⚠ Nicht genug Resturlaub vorhanden</p>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <div class="form-group form-group--full">
        <label class="form-label" for="f-note">Anmerkung (optional)</label>
        <input
          id="f-note"
          data-testid="leave-form-note"
          type="text"
          bind:value={formNote}
          class="form-input"
          placeholder="z.B. Hochzeit, Arzttermin …"
        />
      </div>

      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input
            type="checkbox"
            data-testid="leave-form-half-day"
            bind:checked={() => formHalfDay, setFormHalfDay}
            disabled={SICK_TYPE_CODES.has(formType)}
            class="toggle-cb"
          />
          <span>Halber Tag</span>
        </label>
        {#if SICK_TYPE_CODES.has(formType)}
          <p class="form-hint">Halbe Kranktage sind nicht zulässig</p>
        {/if}
      </div>

      <!-- Parallele Abwesenheiten -->
      {#if formStart && formEnd && formStart <= formEnd}
        <div class="form-group form-group--full">
          <div class="overlap-box">
            <p class="overlap-title">
              Kolleg:innen im gleichen Zeitraum
              {#if overlapLoading}<span class="text-muted"> laden…</span>{/if}
            </p>
            {#if !overlapLoading && overlapEntries.filter((o) => o.status === "APPROVED").length === 0}
              <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
            {:else}
              <div class="overlap-list">
                {#each overlapEntries.filter((o) => o.status === "APPROVED") as o (o.id)}
                  <div class="overlap-row">
                    <span class="overlap-name">{o.employeeName}</span>
                    <span class="overlap-type">{o.typeName ?? NEUTRAL_CHIP_LABEL}</span>
                    <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="form-actions form-group--full">
        <button
          type="submit"
          data-testid="leave-form-submit"
          class="btn btn-primary"
          disabled={formSaving}
        >
          {formSaving
            ? "Speichern…"
            : editingRequest
              ? "Änderungen speichern"
              : "Antrag einreichen"}
        </button>
        <button
          type="button"
          data-testid="leave-form-cancel"
          class="btn btn-ghost"
          onclick={() => (open = false)}
        >
          Abbrechen
        </button>
      </div>
    </form>
  </div>
</Modal>

<!-- Phase 87: Terminkollision-Warnung (Abwesenheit anlegen) -->
{#if collisionSummary}
  <ConfirmDialog
    bind:open={collisionConfirmOpen}
    title="Kundentermine im Zeitraum gebucht"
    confirmLabel="Trotzdem fortfahren"
    cancelLabel="Abbrechen"
    onConfirm={confirmCreateWithCollisions}
    onCancel={cancelCreateCollision}
  >
    {#snippet body()}
      <CollisionWarnBody summary={collisionSummary} variant="range" />
    {/snippet}
  </ConfirmDialog>
{/if}

<style>
  .form-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .form-group--full {
    grid-column: 1 / -1;
  }
  .form-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding-top: 0.25rem;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
  }
  .toggle-cb {
    width: 1rem;
    height: 1rem;
    accent-color: var(--brand);
  }

  /* ── Overlap ──────────────────────────────────────────────────────── */
  .overlap-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.875rem 1rem;
  }
  .overlap-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 0 0 0.5rem;
  }
  .overlap-empty {
    font-size: 0.9375rem;
    margin: 0;
  }
  .overlap-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .overlap-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.9375rem;
  }
  .overlap-name {
    font-weight: 600;
  }
  .overlap-type {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .overlap-dates {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    margin-left: auto;
  }

  /* ── Balance Box ──────────────────────────────────────────────────── */
  .balance-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    font-size: 0.9375rem;
  }
  .balance-label {
    color: var(--text-muted);
  }
  .balance-value {
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .balance-meta {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }
  .balance-deduct {
    color: var(--text-muted);
  }
  .balance-warn {
    color: var(--bad);
  }
  .balance-divider {
    height: 1px;
    background: var(--border);
    margin: 0.125rem 0;
  }
  .balance-hint-warn {
    font-size: 0.8125rem;
    color: var(--bad);
    margin: 0.25rem 0 0;
  }
  .balance-hint-notice {
    font-size: 0.8125rem;
    color: var(--warn);
    margin: 0.25rem 0 0;
  }
  .balance-value--muted {
    color: var(--text-muted);
  }
  .balance-hint-muted {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
  }

  /* ── Days-Info Bar ────────────────────────────────────────────────── */
  .days-info-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--brand-soft);
    border: 1px solid var(--brand-soft);
    border-radius: 8px;
    padding: 0.5rem 0.875rem;
    font-size: 0.9375rem;
    color: var(--brand);
  }
  .days-info-icon {
    font-size: 1rem;
  }
  .days-info-note {
    font-size: 0.8125rem;
    opacity: 0.75;
    margin-left: 0.25rem;
  }

  /* Phase 104-10 (D-31): one line per CONFIRMED § 9 credit, rendered verbatim from the server. */
  .section9-movements {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .section9-movement {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  @media (max-width: 700px) {
    .form-grid {
      grid-template-columns: 1fr 1fr;
    }
    .overlap-dates {
      margin-left: 0;
    }
  }
  @media (max-width: 480px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
