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
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import AttestFields from "./AttestFields.svelte";
  import CollisionWarnBody from "$lib/phorest/CollisionWarnBody.svelte";
  import {
    checkAppointmentCollisions,
    COLLISION_UNAVAILABLE_TOAST,
    type CollisionSummary,
  } from "$lib/phorest/appointmentCollisions";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import {
    LEAVE_TYPE_OPTIONS,
    NEUTRAL_CHIP_LABEL,
    SICK_CODES,
    type CalendarTypeCode,
  } from "$lib/leave/team-calendar-visibility";
  import {
    showsBurlgSection7Notice,
    type LeaveReviewRequest,
    type LeaveOverlapEntry,
  } from "$lib/leave/leave-review";

  interface Props {
    /** Bindable open state. The page owns the boolean, exactly like Modal/ConfirmDialog. */
    open: boolean;
    /** The request under review, or null when nothing is selected. */
    request: LeaveReviewRequest | null;
    /** D-03: the self-approval guard comes in as a prop — never read from the auth store. */
    currentEmployeeId: string | null;
    /** D-02: the page-specific reload after a successful review (each page loads different data). */
    onReviewed: () => void | Promise<void>;
  }

  let { open = $bindable(), request, currentEmployeeId, onReviewed }: Props = $props();

  // ── Local state ──────────────────────────────────────────────────────────
  let note = $state("");
  let saving = $state(false);
  let error = $state("");
  let overlap: LeaveOverlapEntry[] = $state([]);
  let loadingOverlap = $state(false);
  let attestPresent = $state(false);
  let attestFrom = $state("");
  let attestTo = $state("");

  // ── Phase 87: appointment-collision warn-and-confirm on APPROVE (D-05) ─────
  let collisionOpen = $state(false);
  let collisionSummary = $state<CollisionSummary | null>(null);
  let pendingApprove = $state<{ id: string; typeCode: CalendarTypeCode } | null>(null);

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

  let approvedOverlap = $derived(overlap.filter((o) => o.status === "APPROVED"));
  let isCancellationReview = $derived(request?.status === "CANCELLATION_REQUESTED");
  let isSelfApproval = $derived(request !== null && request.employeeId === currentEmployeeId);
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
    if (!ok) throw new Error("Genehmigung fehlgeschlagen");
  }

  // Shared review mutation, moved verbatim (with D-04's two adjustments below) from
  // team/leave/+page.svelte's former `runReview` (D-01). Returns true on success, false on
  // failure, so the collision-confirm path can decide whether to keep its own dialog open.
  async function runReview(
    status: "APPROVED" | "REJECTED",
    ctx: { id: string; typeCode: CalendarTypeCode },
  ): Promise<boolean> {
    saving = true;
    error = "";
    try {
      await api.patch(`/leave/requests/${ctx.id}/review`, {
        status,
        reviewNote: note || null,
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
      open = false;
      pendingApprove = null;
      await onReviewed();
      return true;
    } catch (e: unknown) {
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
  <Modal
    bind:open
    eyebrow={isCancellationReview ? "Stornierung" : "Antrag"}
    title={isCancellationReview ? "Stornierungsantrag prüfen" : "Antrag prüfen"}
  >
    <div
      data-testid={isCancellationReview ? "leave-cancel-approval-modal" : "leave-approval-modal"}
      style="display: contents"
    >
      <!-- Request details -->
      <div
        class="review-grid"
        data-testid={isCancellationReview
          ? "leave-cancel-approval-modal-summary"
          : "leave-approval-modal-summary"}
      >
        <div class="review-field">
          <span class="review-label">Mitarbeiter</span>
          <span class="review-value">{request.employee.firstName} {request.employee.lastName}</span>
        </div>
        <div class="review-field">
          <span class="review-label">Art</span>
          <span class="review-value">{typeName(request.typeCode)}</span>
        </div>
        <div class="review-field">
          <span class="review-label">Zeitraum</span>
          <span class="review-value font-mono"
            >{fmtDate(request.startDate)} – {fmtDate(request.endDate)}</span
          >
        </div>
        <div class="review-field">
          <span class="review-label">Umfang</span>
          <span class="review-value">{daysLabel(Number(request.days), request.halfDay)}</span>
        </div>
        {#if request.note}
          <div class="review-field review-field--full">
            <span class="review-label">Anmerkung Mitarbeiter</span>
            <span class="review-value">„{request.note}"</span>
          </div>
        {/if}
      </div>

      <!-- Overlapping colleagues -->
      <div class="overlap-box review-section">
        <p class="overlap-title">Kolleg:innen im gleichen Zeitraum</p>
        {#if loadingOverlap}
          <p class="text-muted overlap-empty">Lädt…</p>
        {:else if approvedOverlap.length === 0}
          <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
        {:else}
          <div class="overlap-list">
            {#each approvedOverlap as o (o.id)}
              <div class="overlap-row">
                <span class="overlap-name">{o.employeeName}</span>
                <span class="chip">{o.typeName ?? NEUTRAL_CHIP_LABEL}</span>
                <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if showsBurlgSection7Notice(request.typeCode)}
        <div class="callout">
          <span class="ico" aria-hidden="true">⚖</span>
          <p>
            <b>BUrlG § 7:</b> Urlaubsantrag muss zeitnah entschieden werden — gewährter Urlaub muss im
            laufenden Jahr gewährt werden, andernfalls verfällt er gem. § 7 Abs. 3 zum 31.03. des Folgejahres.
          </p>
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

      <!-- Review note -->
      <div class="form-group review-section">
        <label class="form-label" for="review-note">Anmerkung (optional)</label>
        <input
          id="review-note"
          data-testid={isCancellationReview
            ? "leave-cancel-approval-modal-reason"
            : "leave-approval-modal-reason"}
          type="text"
          bind:value={note}
          class="form-input"
          placeholder="Grund für Ablehnung o.ä."
        />
      </div>

      {#if error}
        <div class="alert alert-error review-error" role="alert">
          <span>⚠</span><span>{error}</span>
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
        {#if isCancellationReview}
          <button
            data-testid="leave-cancel-approval-modal-reject"
            class="btn btn-ghost"
            onclick={() => submitReview("REJECTED")}
            disabled={saving}
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
            class="btn btn-danger"
            onclick={() => submitReview("REJECTED")}
            disabled={saving}
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
  </Modal>
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
      <CollisionWarnBody summary={collisionSummary} variant="range" />
    {/snippet}
  </ConfirmDialog>
{/if}

<style>
  /* ── Review Grid — copied from team/leave/+page.svelte, NOT cut (D-16): that page's § 9 confirm
     modal, Korrektur modal and standalone Attest-erfassen modal also render .review-* elements
     and are explicitly out of this phase's scope, so these six rules stay duplicated in both
     files rather than being moved out of the page. Do not delete them from the page. */
  .review-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem 1.5rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 1rem 1.25rem;
  }
  .review-field {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .review-field--full {
    grid-column: 1 / -1;
  }
  .review-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .review-value {
    font-size: 0.9375rem;
    font-weight: 500;
  }
  .review-section {
    margin-top: 1.25rem;
  }
  .review-error {
    margin-top: 0.75rem;
  }

  /* ── Overlap — exclusive to this dialog on both former pages (RESEARCH.md § Scoped Styles). */
  .overlap-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
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
  .overlap-dates {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    margin-left: auto;
  }
  .self-approval-note {
    font-size: 0.875rem;
    margin: 0 auto 0 0;
  }
  /* Value from inbox/+page.svelte:1121-1124 (D-04 — the inbox footer wins). */
  .footer-note {
    font-size: 12.5px;
    color: var(--text-muted);
  }

  @media (max-width: 700px) {
    .review-grid {
      grid-template-columns: 1fr;
    }
    .overlap-dates {
      margin-left: 0;
    }
  }
</style>
