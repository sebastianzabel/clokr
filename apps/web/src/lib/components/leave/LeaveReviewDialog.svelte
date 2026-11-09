<script lang="ts">
  /**
   * LeaveReviewDialog — Phase 255 (GitHub issue #255).
   *
   * The ONE shared absence review dialog. Before this phase, /team/leave and /inbox each carried
   * their own copy of this modal's markup AND its own `submitReview()`. The missing Attest field
   * on /inbox (Issue #201 landed on only one of the two copies) was the first visible symptom of
   * the two copies silently drifting apart, not the root cause. Owner decision (Issue #255,
   * 2026-09-18): the way forward is ONE shared dialog, not two maintained copies. This
   * component is that one dialog — there is deliberately NO page-selecting prop and NO branch
   * inside it that distinguishes callers by page. CLAUDE.md § "No generalization on spec" would
   * forbid inventing a switch nobody asked for in any case; here the switch itself IS the defect
   * this phase removes, so adding one back would silently reopen the original bug.
   *
   * This component does NOT import the shared auth store (D-03). The self-approval guard comes in
   * as the `currentEmployeeId` prop instead. That is not a style choice: the auth store module
   * transitively pulls in SvelteKit's environment module, and `apps/web/vitest.config.ts`
   * registers no alias for that module — a component importing the auth store cannot be mounted
   * in vitest at all. This phase's second, ticket-unnamed gain — logic that used to be provable
   * only via source-read pins becomes MOUNTED-testable — depends entirely on this file staying
   * free of that import. Reintroducing it later silently deletes that gain for every future test
   * of this file.
   */
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte";
  import AttestFields from "./AttestFields.svelte";
  import CollisionWarnBody from "$lib/phorest/CollisionWarnBody.svelte";
  import {
    checkAppointmentCollisions,
    COLLISION_UNAVAILABLE_TOAST,
    type CollisionSummary,
  } from "$lib/phorest/appointmentCollisions";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { salonContext, showSalonOptions } from "$stores/salon-context"; // Issue #853: salon names, one module (#82)
  import {
    LEAVE_TYPE_OPTIONS,
    NEUTRAL_CHIP_LABEL,
    SICK_CODES,
    type CalendarTypeCode,
  } from "$lib/leave/team-calendar-visibility";
  import { leaveDaysLabel } from "$lib/leave/leave-days-label"; // Issue #595 (D-04)
  import {
    exceedancesOf,
    isLeaveLimitExceptionRequired,
    validateExceptionReason,
  } from "$lib/leave-limits/exception"; // Issue #836
  import { exceedanceDescription } from "$lib/leave-limits/sentences"; // Issue #836
  import {
    showsBurlgSection7Notice,
    type LeaveReviewRequest,
    type LeaveOverlapEntry,
  } from "$lib/leave/leave-review";
  import {
    NO_SHIFTS_TEXT,
    reviewResultToast,
    shiftLines,
    vacationBeforeAfter,
    type RangeShift,
  } from "$lib/leave/review-facts"; // Issue #853 (S-29, D-853-08)
  import { mapVacationBalance, type VacationEntitlementRow } from "$lib/leave/vacation-balance";
  import { deriveVacationSummary } from "$lib/leave/vacation-summary";
  import { homeSalonIdOn, type SalonAssignment } from "$lib/employees/salon-assignments";
  import Skeleton from "$components/ui/Skeleton.svelte";

  interface Props {
    /** Bindable open state. The page owns the boolean, exactly like Modal/ConfirmDialog. */
    open: boolean;
    /** The request under review, or null when nothing is selected. */
    request: LeaveReviewRequest | null;
    /** D-03: the self-approval guard comes in as a prop — never read from the auth store. */
    currentEmployeeId: string | null;
    /** D-02: the page-specific reload after a successful review (each page loads different data). */
    onReviewed: () => void | Promise<void>;
    /**
     * Issue #853 (D-853-08): what the caller may read, passed in by the page (this file imports no
     * auth store). Each default is false: a fact line is shown only when its flag is set AND the
     * API answers; the API stays the guard, a missing permission only omits the line.
     */
    canReadEntitlement?: boolean;
    canReadShifts?: boolean;
    canReadEmployee?: boolean;
  }

  let {
    open = $bindable(),
    request,
    currentEmployeeId,
    onReviewed,
    canReadEntitlement = false,
    canReadShifts = false,
    canReadEmployee = false,
  }: Props = $props();

  // ── Local state ──────────────────────────────────────────────────────────
  let note = $state("");
  let saving = $state(false);
  let error = $state("");
  let overlap: LeaveOverlapEntry[] = $state([]);
  let loadingOverlap = $state(false);
  let attestPresent = $state(false);
  let attestFrom = $state("");
  let attestTo = $state("");

  // ── Issue #853 (D-853-08): optional decision facts ──────────────────────────
  // `null` = not shown (flag off, not loaded yet, or the read was refused). A refusal or a network
  // error omits the line silently; no error text is ever rendered for these lines.
  let homeSalonId = $state<string | null>(null);
  // The name comes from the salon context store (the only module that reads /me/context, #82),
  // gated by its one rule `showSalonOptions` (#64): a salon outside the caller's reach is not in
  // its list, so the line is omitted for it.
  let homeSalonName = $derived(
    showSalonOptions($salonContext)
      ? ($salonContext.salons.find((x) => x.id === homeSalonId)?.name ?? null)
      : null,
  );
  let vacationFact = $state<{ label: string; value: string } | null>(null);
  let shiftFactLines = $state<string[] | null>(null);
  // The request the facts belong to; a late answer for another request is discarded (T-853-15).
  let factsFor: string | null = null;

  // ── Phase 87: appointment-collision warn-and-confirm on APPROVE (D-05) ─────
  let collisionOpen = $state(false);
  let collisionSummary = $state<CollisionSummary | null>(null);
  let pendingApprove = $state<{ id: string; typeCode: CalendarTypeCode } | null>(null);

  // ── Issue #836: leave-limit exception step on APPROVE (D-836-16) ───────────
  // The API answers 409 LEAVE_LIMIT_EXCEPTION_REQUIRED when the approval would exceed a limit;
  // the approver then gives a reason and the approval is resent with `limitException`.
  let exceptionOpen = $state(false);
  let exceptionText = $state("");
  let pendingException = $state<{ id: string; typeCode: CalendarTypeCode } | null>(null);

  // Re-initialise whenever the dialog is open with a request to show — including the very first
  // mount with `open: true` already set, which is how every mounted test in this file renders the
  // component (there is no earlier `false` state to transition FROM in that case). The idiom is
  // the simpler of the two shapes RetroactiveBSWizard.svelte uses (`:52-61`, `if (open) { … }`,
  // not its OTHER `prevOpen`-gated effect at `:69-74`): that second shape exists there only to
  // fire an `onClose` callback on the close transition specifically, which this component does
  // not need (D-02 — neither caller reacts to a dismiss). Modal.svelte sets `open = false` on
  // Escape/backdrop directly with no callback of its own; nothing here needs to observe that.
  $effect(() => {
    if (open && request) {
      note = "";
      error = "";
      overlap = [];
      attestPresent = request.attestPresent ?? false;
      attestFrom = request.attestValidFrom ?? "";
      attestTo = request.attestValidTo ?? "";
      loadingOverlap = true;
      api
        .get<LeaveOverlapEntry[]>(
          `/leave/overlap?startDate=${request.startDate}&endDate=${request.endDate}`,
        )
        .then((rows) => {
          overlap = rows;
        })
        .catch(() => {
          overlap = [];
        })
        .finally(() => {
          loadingOverlap = false;
        });
    }
  });

  // Issue #853 (D-853-08): the optional facts. One effect per open request; each read runs only
  // behind its own flag, and every answer is compared with the request id it was asked for.
  $effect(() => {
    homeSalonId = null;
    vacationFact = null;
    shiftFactLines = null;
    if (!open || !request) {
      factsFor = null;
      return;
    }
    const rid = request.id;
    const employeeId = request.employeeId;
    const startDate = request.startDate;
    const endDate = request.endDate;
    const status = request.status;
    const days = Number(request.days);
    const isVacation = request.typeCode === "VACATION";
    const wantEmployee = canReadEmployee;
    const wantEntitlement = canReadEntitlement && isVacation;
    const wantShifts = canReadShifts;
    factsFor = rid;
    const current = () => factsFor === rid;

    if (wantEmployee) {
      api
        .get<{ assignments: SalonAssignment[] }>(`/employees/${employeeId}/salon-assignments`)
        .then((assigned) => {
          if (current()) homeSalonId = homeSalonIdOn(assigned.assignments, startDate);
        })
        .catch(() => {});
    }

    if (wantEntitlement) {
      const year = startDate.slice(0, 4);
      api
        .get<VacationEntitlementRow[]>(`/leave/entitlements/${employeeId}?year=${year}`)
        .then((rows) => {
          if (!current()) return;
          const balance = mapVacationBalance(rows.find((r) => r.typeCode === "VACATION"));
          const fact = vacationBeforeAfter({
            remaining: deriveVacationSummary(balance, 0).remaining,
            days,
            status,
            startDate,
            endDate,
          });
          if (fact) vacationFact = { label: fact.label, value: fact.value };
        })
        .catch(() => {});
    }

    if (wantShifts) {
      api
        .get<RangeShift[]>(`/shifts/range?from=${startDate}&to=${endDate}&employeeId=${employeeId}`)
        .then((rows) => {
          if (current()) shiftFactLines = shiftLines(rows);
        })
        .catch(() => {});
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────
  function typeName(code: CalendarTypeCode): string {
    return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  let approvedOverlap = $derived(overlap.filter((o) => o.status === "APPROVED"));
  let isCancellationReview = $derived(request?.status === "CANCELLATION_REQUESTED");
  let isSelfApproval = $derived(request !== null && request.employeeId === currentEmployeeId);
  // Issue #853 (D-853-09): a rejection needs a reason. UI-only guard; the API stays as it is.
  let reasonMissing = $derived(note.trim() === "");
  let personName = $derived(
    request ? `${request.employee.firstName} ${request.employee.lastName}` : "",
  );
  let isDecidable = $derived(
    request !== null &&
      (request.status === "PENDING" || request.status === "CANCELLATION_REQUESTED"),
  );

  // ── Mutation ─────────────────────────────────────────────────────────────
  async function submitReview(status: "APPROVED" | "REJECTED") {
    if (!request) return;
    // Pre-check only a genuine leave APPROVAL. A CANCELLATION_REQUESTED review shares this
    // "APPROVED" path, but approving a cancellation makes the employee present again — booked
    // appointments are a reason TO cancel, not a risk of proceeding — so the collision warning
    // would be semantically inverted and is skipped. Reject is never gated either.
    if (status === "APPROVED" && request.status !== "CANCELLATION_REQUESTED") {
      const summary = await checkAppointmentCollisions({
        employeeId: request.employeeId,
        from: request.startDate,
        to: request.endDate,
      });
      if (summary && summary.total > 0) {
        pendingApprove = { id: request.id, typeCode: request.typeCode };
        collisionSummary = summary;
        // Close the review Modal so exactly ONE scrim is live (Pitfall 5 / T-87-08 — never stack
        // two Modal instances, their `inert`-on-siblings logic would fight over focus).
        open = false;
        collisionOpen = true;
        return;
      }
      if (summary === null) {
        // Fail-open: proceed with the approval, surface a non-blocking notice.
        toasts.error(COLLISION_UNAVAILABLE_TOAST);
      }
    }
    await runReview(status, { id: request.id, typeCode: request.typeCode });
  }

  // Confirm handler for the collision dialog on the approve path. Throws on failure so
  // ConfirmDialog stays open (its documented contract).
  async function confirmApproveWithCollisions() {
    if (!pendingApprove) return;
    const ok = await runReview("APPROVED", pendingApprove);
    // The server asked for a limit exception: this dialog hands over to the reason dialog, so
    // it closes without an error (exactly one dialog stays live).
    if (!ok && pendingException) {
      collisionOpen = false;
      return;
    }
    if (!ok) throw new Error("Genehmigung fehlgeschlagen");
  }

  // Confirm handler of the exception step: resends the same approval with the reason. Throws to
  // keep the reason dialog open (its contract) when the reason is invalid or the resend fails.
  async function confirmException(reason: string) {
    const invalid = validateExceptionReason(reason);
    if (invalid) throw new Error(invalid);
    if (!pendingException) return;
    const ok = await runReview("APPROVED", pendingException, {
      limitException: { reason: reason.trim() },
    });
    if (!ok) throw new Error(error || "Genehmigung fehlgeschlagen");
    pendingException = null;
  }

  function cancelException() {
    pendingException = null;
  }

  // Shared review mutation, moved verbatim (with D-04's two adjustments below) from
  // team/leave/+page.svelte's former `runReview` (D-01). Returns true on success, false on
  // failure, so the collision-confirm path can decide whether to keep its own dialog open.
  async function runReview(
    status: "APPROVED" | "REJECTED",
    ctx: { id: string; typeCode: CalendarTypeCode },
    extra?: { limitException?: { reason: string } },
  ): Promise<boolean> {
    saving = true;
    error = "";
    try {
      await api.patch(`/leave/requests/${ctx.id}/review`, {
        status,
        reviewNote: note || null,
        ...extra,
      });
      if (SICK_CODES.includes(ctx.typeCode)) {
        // D-02 (Phase 104-10): deliberately left untouched — this is the pre-existing,
        // consequence-free display toggle on legacy data of unknown quality. The § 9 credit
        // fires ONLY from the "AU liegt vor" dialog on /team/leave; never wire this call to the
        // § 9 confirm flow.
        await api.patch(`/leave/requests/${ctx.id}/attest`, {
          attestPresent,
          attestValidFrom: attestPresent && attestFrom ? attestFrom : null,
          attestValidTo: attestPresent && attestTo ? attestTo : null,
        });
      }
      // Issue #853 (S-29): acknowledge the result once the server answered. The text names person
      // and decision, never the leave type (sick leave is health data).
      toasts.success(reviewResultToast(status, personName, isCancellationReview));
      open = false;
      pendingApprove = null;
      await onReviewed();
      return true;
    } catch (e: unknown) {
      // Issue #836: a limit-exceeding APPROVAL is asked for an exception reason, never shown as a
      // plain error. Only the first answer opens the step; a resend (extra set) that is refused
      // again falls through to the normal error path.
      if (status === "APPROVED" && !extra && isLeaveLimitExceptionRequired(e)) {
        // Never empty: an empty text would leave the request stuck with no visible dialog.
        exceptionText =
          exceedanceDescription(exceedancesOf(e)) || "Eine Urlaubsgrenze ist überschritten.";
        pendingException = ctx;
        // One scrim at a time, as on the collision path.
        open = false;
        exceptionOpen = true;
        return false;
      }
      // D-04: /inbox's better error text — `data.error` is the German API message, `message` is
      // only the HTTP status text.
      const apiErr = e as { data?: { error?: string }; message?: string };
      error = apiErr?.data?.error ?? apiErr?.message ?? "Fehler";
      // If the review Modal was already closed (collision-confirm path), the inline error above
      // is not visible — surface it via a toast instead.
      if (!open) toasts.error(error);
      return false;
    } finally {
      saving = false;
    }
  }
</script>

<!-- Phase 73-04 testid strategy, carried forward from team/leave/+page.svelte:
     - Regular APPROVAL/REJECTION review → testids use the `leave-approval-modal-*` prefix.
     - CANCELLATION_REQUESTED review → testids use the `leave-cancel-approval-modal-*` prefix
       (matches CLAUDE.md's leave-cancellation flow contract). The same component renders both
       states because the multi-step flow is owned by the same modal in this codebase. -->
{#if request}
  <Dialog
    bind:open
    eyebrow={isCancellationReview ? "Stornierung" : "Antrag"}
    title={isCancellationReview ? "Stornierungsantrag prüfen" : "Antrag prüfen"}
  >
    <div
      data-testid={isCancellationReview ? "leave-cancel-approval-modal" : "leave-approval-modal"}
      style="display: contents"
    >
      <!-- Issue #853: the facts of the decision, first -->
      <dl
        class="facts"
        data-testid={isCancellationReview
          ? "leave-cancel-approval-modal-summary"
          : "leave-approval-modal-summary"}
      >
        <div class="fact">
          <dt>Person</dt>
          <dd>{personName}</dd>
        </div>
        <div class="fact">
          <dt>Art</dt>
          <dd>{typeName(request.typeCode)}</dd>
        </div>
        <div class="fact">
          <dt>Zeitraum</dt>
          <dd>{fmtDate(request.startDate)} – {fmtDate(request.endDate)}</dd>
        </div>
        <div class="fact">
          <dt>Umfang</dt>
          <dd>{leaveDaysLabel(Number(request.days), request.halfDay, request.typeCode)}</dd>
        </div>
        {#if homeSalonName}
          <div class="fact" data-testid="review-fact-home-salon">
            <dt>Stammsalon</dt>
            <dd>{homeSalonName}</dd>
          </div>
        {/if}
        {#if vacationFact}
          <div class="fact" data-testid="review-fact-vacation">
            <dt>{vacationFact.label}</dt>
            <dd>{vacationFact.value}</dd>
          </div>
        {/if}
        {#if shiftFactLines}
          <div class="fact fact--full" data-testid="review-fact-shifts">
            <dt>Schichten im Zeitraum</dt>
            <dd>
              {#if shiftFactLines.length === 0}
                {NO_SHIFTS_TEXT}
              {:else}
                <ul class="shift-lines">
                  {#each shiftFactLines as line, i (i)}
                    <li>{line}</li>
                  {/each}
                </ul>
              {/if}
            </dd>
          </div>
        {/if}
        {#if request.note}
          <div class="fact fact--full">
            <dt>Anmerkung Mitarbeiter</dt>
            <dd>„{request.note}"</dd>
          </div>
        {/if}
      </dl>

      <!-- Overlapping colleagues -->
      <section class="overlap-box review-section">
        <p class="overlap-title">Kolleg:innen im gleichen Zeitraum</p>
        {#if loadingOverlap}
          <Skeleton shape="line" />
        {:else if approvedOverlap.length === 0}
          <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
        {:else}
          <div class="overlap-list">
            {#each approvedOverlap as o (o.id)}
              <div class="overlap-row">
                <span class="overlap-name">{o.employeeName}</span>
                <Chip>{o.typeName ?? NEUTRAL_CHIP_LABEL}</Chip>
                <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      {#if showsBurlgSection7Notice(request.typeCode)}
        <div class="review-section">
          <Note tone="info">
            <b>BUrlG § 7:</b> Urlaubsantrag muss zeitnah entschieden werden — gewährter Urlaub muss im
            laufenden Jahr gewährt werden, andernfalls verfällt er gem. § 7 Abs. 3 zum 31.03. des Folgejahres.
          </Note>
        </div>
      {/if}

      <!-- Attest (sickness types only) -->
      {#if SICK_CODES.includes(request.typeCode)}
        <div class="review-section">
          <AttestFields
            bind:present={attestPresent}
            bind:validFrom={attestFrom}
            bind:validTo={attestTo}
            idPrefix="r"
          />
        </div>
      {/if}

      <!-- Review note: the reason is required for a rejection (Issue #853, D-853-09) -->
      <div class="review-section">
        <FormField label="Begründung" help="Pflicht beim Ablehnen">
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              data-testid={isCancellationReview
                ? "leave-cancel-approval-modal-reason"
                : "leave-approval-modal-reason"}
              type="text"
              bind:value={note}
              class="form-input"
              placeholder="Grund für Ablehnung o.ä."
              aria-describedby={describedBy}
              aria-invalid={invalid ? "true" : undefined}
            />
          {/snippet}
        </FormField>
      </div>

      {#if error}
        <div class="review-error" role="alert">
          <Note tone="bad">{error}</Note>
        </div>
      {/if}
    </div>
    <!-- /leave-approval-modal body wrapper -->

    {#snippet footer()}
      <button
        data-testid={isCancellationReview
          ? "leave-cancel-approval-modal-close"
          : "leave-approval-modal-close"}
        class="btn btn-ghost"
        onclick={() => {
          open = false;
        }}
        disabled={saving}
      >
        Abbrechen
      </button>
      <span class="spacer"></span>
      {#if isSelfApproval}
        <p class="text-muted self-approval-note" data-testid="leave-approval-modal-self-block">
          Eigene Anträge können nicht selbst genehmigt werden.
        </p>
      {:else if isDecidable}
        {#if reasonMissing}
          <p class="text-muted reason-hint" id="review-reason-hint">Bitte nenne einen Grund.</p>
        {/if}
        {#if isCancellationReview}
          <button
            data-testid="leave-cancel-approval-modal-reject"
            class="btn btn-secondary"
            onclick={() => submitReview("REJECTED")}
            disabled={saving || reasonMissing}
            aria-describedby={reasonMissing ? "review-reason-hint" : undefined}
          >
            {saving ? "…" : "Stornierung ablehnen"}
          </button>
          <button
            data-testid="leave-cancel-approval-modal-approve"
            class="btn btn-danger"
            onclick={() => submitReview("APPROVED")}
            disabled={saving}
          >
            {saving ? "…" : "Stornierung genehmigen"}
          </button>
        {:else}
          <button
            data-testid="leave-approval-modal-reject"
            class="btn btn-secondary"
            onclick={() => submitReview("REJECTED")}
            disabled={saving || reasonMissing}
            aria-describedby={reasonMissing ? "review-reason-hint" : undefined}
          >
            {saving ? "…" : "Ablehnen"}
          </button>
          <button
            data-testid="leave-approval-modal-approve"
            class="btn btn-primary"
            onclick={() => submitReview("APPROVED")}
            disabled={saving}
          >
            {saving ? "…" : "Genehmigen"}
          </button>
        {/if}
      {:else}
        <span class="footer-note">Antrag bereits entschieden.</span>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<!-- Phase 87: appointment-collision warning (approve) -->
{#if collisionSummary}
  <ConfirmDialog
    bind:open={collisionOpen}
    title="Kundentermine im Zeitraum gebucht"
    confirmLabel="Trotzdem fortfahren"
    cancelLabel="Abbrechen"
    onConfirm={confirmApproveWithCollisions}
  >
    {#snippet body()}
      {#if collisionSummary}
        <CollisionWarnBody summary={collisionSummary} variant="range" />
      {/if}
    {/snippet}
  </ConfirmDialog>
{/if}

<!-- Issue #836: leave-limit exception (approve) — reason is mandatory and audited by the API -->
{#if exceptionText}
  <ReasonDialog
    bind:open={exceptionOpen}
    title="Ausnahme von der Urlaubsgrenze"
    description={`Mit dieser Genehmigung wird eine Urlaubsgrenze überschritten:\n${exceptionText}`}
    label="Begründung der Ausnahme"
    confirmLabel="Trotzdem genehmigen"
    onConfirm={confirmException}
    onCancel={cancelException}
  />
{/if}

<style>
  /* The facts are a plain definition list on the dialog surface (Issue #853); no bespoke box. */
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
  .fact--full {
    grid-column: 1 / -1;
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
  .shift-lines {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 9.5rem;
    overflow-y: auto;
  }
  .review-section {
    margin-top: var(--s-5);
  }
  .review-error {
    margin-top: var(--s-3);
  }

  /* Overlap — exclusive to this dialog (RESEARCH.md § Scoped Styles). */
  .overlap-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
    margin: 0 0 var(--s-2);
  }
  .overlap-empty {
    font-size: var(--fs-base);
    margin: 0;
  }
  .overlap-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .overlap-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
    font-size: var(--fs-base);
  }
  .overlap-name {
    font-weight: 600;
  }
  .overlap-dates {
    font-size: var(--fs-sm);
    margin-left: auto;
  }
  .self-approval-note,
  .reason-hint {
    font-size: var(--fs-sm);
    margin: 0 auto 0 0;
  }
  .footer-note {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  @media (max-width: 700px) {
    .facts {
      grid-template-columns: 1fr;
    }
    .overlap-dates {
      margin-left: 0;
    }
  }
</style>
