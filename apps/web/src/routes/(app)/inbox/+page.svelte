<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";

  // ── Types ────────────────────────────────────────────────────────────────
  type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";

  type TypeCode =
    | "VACATION"
    | "OVERTIME_COMP"
    | "SPECIAL"
    | "UNPAID"
    | "SICK"
    | "SICK_CHILD"
    | "EDUCATION"
    | "HOLIDAY"
    | "MATERNITY"
    | "PARENTAL";

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
  }

  interface OverlapEntry {
    id: string;
    employeeName: string;
    typeName: string;
    startDate: string;
    endDate: string;
    status: Status;
  }

  // Phase 63 (D-14..D-17, D-22): read-only BS-day row in the Inbox.
  // GET /vocational-school/upcoming returns these — manager-scope, next 14 days.
  // No approval flow: the day is legally mandated (BBiG §15), so the row only
  // shows the date + a lock icon. `source` drives the "(Vorlage)" / "(manuell)"
  // suffix on the badge.
  interface VocationalSchoolUpcoming {
    id: string;
    employeeId: string;
    employee: { firstName: string; lastName: string; employeeNumber?: string };
    date: string; // YYYY-MM-DD
    source: "PATTERN" | "MANUAL";
  }

  type TabKey = "open" | "approved" | "rejected" | "all";

  const TYPE_LABELS: Record<TypeCode, string> = {
    VACATION: "Urlaub",
    OVERTIME_COMP: "Überstundenausgleich",
    SPECIAL: "Sonderurlaub",
    EDUCATION: "Bildungsurlaub",
    SICK: "Krankmeldung",
    SICK_CHILD: "Kinderkrank",
    UNPAID: "Unbezahlter Urlaub",
    HOLIDAY: "Feiertag",
    MATERNITY: "Mutterschutz",
    PARENTAL: "Elternzeit",
  };

  function typeLabel(code: TypeCode): string {
    return TYPE_LABELS[code] ?? code;
  }

  // ── State ────────────────────────────────────────────────────────────────
  let requests: LeaveRequest[] = $state([]);
  // Phase 63 D-14: rolling 14-day list of upcoming BS-days for the manager's
  // tenant scope. Loaded in parallel with leave requests via Promise.all.
  let upcomingBs: VocationalSchoolUpcoming[] = $state([]);
  let loading = $state(true);
  let error = $state("");
  let tab: TabKey = $state("open");

  // Detail modal — Modal primitive owns Escape/backdrop/focus-trap.
  let detailRequest: LeaveRequest | null = $state(null);
  let detailOpen = $state(false);
  let detailOverlap: OverlapEntry[] = $state([]);
  let detailLoadingOverlap = $state(false);
  let reviewNote = $state("");
  let reviewSaving = $state(false);
  let reviewError = $state("");

  // ── Role gate ────────────────────────────────────────────────────────────
  onMount(() => {
    const role = $authStore.user?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      void goto("/dashboard");
      return;
    }
    void loadRequests();
  });

  // ── Data loading ─────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();

  async function loadRequests() {
    loading = true;
    error = "";
    try {
      // Phase 63 D-14: parallel fetch — leave requests + BS-days window (today..+14d).
      const today = new Date();
      const in14days = new Date(today.getTime() + 14 * 86_400_000);
      const fmtIso = (d: Date) => d.toISOString().slice(0, 10);
      const [leave, bs] = await Promise.all([
        api.get<LeaveRequest[]>(`/leave/requests?year=${currentYear}`),
        api.get<VocationalSchoolUpcoming[]>(
          `/vocational-school/upcoming?from=${fmtIso(today)}&to=${fmtIso(in14days)}`,
        ),
      ]);
      requests = leave;
      upcomingBs = bs;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
      requests = [];
      upcomingBs = [];
    } finally {
      loading = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function daysLabel(days: number, halfDay: boolean): string {
    if (halfDay) return "½ Tag";
    return days === 1 ? "1 Tag" : `${days} Tage`;
  }

  function initials(first: string, last: string): string {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  }

  // ── Derived: filtered lists + KPIs ───────────────────────────────────────
  let openRequests = $derived(
    requests.filter((r) => r.status === "PENDING" || r.status === "CANCELLATION_REQUESTED"),
  );
  let approvedRequests = $derived(requests.filter((r) => r.status === "APPROVED"));
  let rejectedRequests = $derived(requests.filter((r) => r.status === "REJECTED"));

  let visibleRequests = $derived.by(() => {
    if (tab === "open") return openRequests;
    if (tab === "approved") return approvedRequests;
    if (tab === "rejected") return rejectedRequests;
    return requests;
  });

  // Phase 63 D-14..D-17: BS rows are informational and time-bound (next 14
  // days). They appear only in the "open" and "all" tabs (no approval status
  // → never "approved" or "rejected"). Sorted by date ascending for visual
  // chronology alongside the leave requests in the same view.
  let visibleBs = $derived.by(() => {
    if (tab !== "open" && tab !== "all") return [];
    return [...upcomingBs].sort((a, b) => a.date.localeCompare(b.date));
  });

  let kpiPending = $derived(openRequests.length);
  let kpiApproved = $derived(approvedRequests.length);
  let kpiRejected = $derived(rejectedRequests.length);

  // ── Detail modal ─────────────────────────────────────────────────────────
  async function openDetail(req: LeaveRequest) {
    detailRequest = req;
    detailOpen = true;
    reviewNote = "";
    reviewError = "";
    detailOverlap = [];
    detailLoadingOverlap = true;
    try {
      detailOverlap = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${req.startDate}&endDate=${req.endDate}`,
      );
    } catch {
      detailOverlap = [];
    } finally {
      detailLoadingOverlap = false;
    }
  }

  function closeDetail() {
    if (reviewSaving) return;
    detailOpen = false;
    detailRequest = null;
    reviewError = "";
  }

  async function submitReview(status: "APPROVED" | "REJECTED") {
    if (!detailRequest) return;
    reviewSaving = true;
    reviewError = "";
    try {
      await api.patch(`/leave/requests/${detailRequest.id}/review`, {
        status,
        reviewNote: reviewNote || null,
      });
      detailOpen = false;
      detailRequest = null;
      await loadRequests();
    } catch (e: unknown) {
      const apiErr = e as { data?: { error?: string }; message?: string };
      reviewError = apiErr?.data?.error ?? apiErr?.message ?? "Fehler";
    } finally {
      reviewSaving = false;
    }
  }

  function isSelfApproval(req: LeaveRequest): boolean {
    return req.employeeId === $authStore.user?.employeeId;
  }

  let approvedOverlap = $derived(detailOverlap.filter((o) => o.status === "APPROVED"));
</script>

<svelte:head>
  <title>Inbox – Clokr</title>
</svelte:head>

<PageHead eyebrow="Manager" title="Inbox" accent="Inbox" />

{#if error}
  <div class="callout error" role="alert" style="margin-bottom: 16px;">
    <span class="ico">⚠</span>
    <p>{error}</p>
  </div>
{/if}

<!-- ── KPI row (3 stats: pending / approved / rejected) ──────────────────── -->
<div class="kpi-row">
  <Card animate>
    <KPIStat
      label="Offen"
      value={String(kpiPending)}
      unit={kpiPending === 1 ? "Antrag" : "Anträge"}
    />
  </Card>
  <Card animate>
    <KPIStat
      label="Genehmigt"
      value={String(kpiApproved)}
      unit={kpiApproved === 1 ? "Antrag" : "Anträge"}
    />
  </Card>
  <Card animate>
    <KPIStat
      label="Abgelehnt"
      value={String(kpiRejected)}
      unit={kpiRejected === 1 ? "Antrag" : "Anträge"}
    />
  </Card>
</div>

<!-- ── Global view-tabs above the list card ──────────────────────────────── -->
<div class="view-tabs" role="tablist">
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={tab === "open"}
    role="tab"
    aria-selected={tab === "open"}
    onclick={() => (tab = "open")}
  >
    Offen
    {#if openRequests.length > 0}
      <span class="tab-badge">{openRequests.length}</span>
    {/if}
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={tab === "approved"}
    role="tab"
    aria-selected={tab === "approved"}
    onclick={() => (tab = "approved")}
  >
    Genehmigt
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={tab === "rejected"}
    role="tab"
    aria-selected={tab === "rejected"}
    onclick={() => (tab = "rejected")}
  >
    Abgelehnt
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={tab === "all"}
    role="tab"
    aria-selected={tab === "all"}
    onclick={() => (tab = "all")}
  >
    Alle
  </button>
</div>

<!-- ── List card with ApprovalRow entries ───────────────────────────────── -->
<Card animate class="list-card" style="padding: 0;">
  <div class="list-card-header">
    <CardHeader
      title="Anträge"
      sub={tab === "open"
        ? "Offen — auf Entscheidung wartend"
        : tab === "approved"
          ? `Genehmigt in ${currentYear}`
          : tab === "rejected"
            ? `Abgelehnt in ${currentYear}`
            : `Alle Anträge in ${currentYear}`}
    />
  </div>

  {#if loading}
    <div class="list-empty">Lädt…</div>
  {:else if visibleRequests.length === 0 && visibleBs.length === 0}
    {#if tab === "open"}
      <EmptyState
        icon="inbox"
        title="Keine offenen Anträge"
        description="Alle Anträge in diesem Tab sind bearbeitet."
      />
    {:else if tab === "approved"}
      <EmptyState
        icon="inbox"
        title="Keine genehmigten Anträge"
        description={`Im Jahr ${currentYear} wurden keine Anträge genehmigt.`}
      />
    {:else if tab === "rejected"}
      <EmptyState
        icon="inbox"
        title="Keine abgelehnten Anträge"
        description={`Im Jahr ${currentYear} wurden keine Anträge abgelehnt.`}
      />
    {:else}
      <EmptyState
        icon="inbox"
        title="Keine Anträge"
        description={`Im Jahr ${currentYear} liegen keine Anträge vor.`}
      />
    {/if}
  {:else}
    {#each visibleRequests as req (req.id)}
      <ApprovalRow
        avatar={initials(req.employee.firstName, req.employee.lastName)}
        name={`${req.employee.firstName} ${req.employee.lastName}`}
        dates={`${fmtDate(req.startDate)} – ${fmtDate(req.endDate)} · ${daysLabel(Number(req.days), req.halfDay)}`}
        onclick={() => openDetail(req)}
      >
        {#snippet metaContent()}
          <span class="chip chip-brand">{typeLabel(req.typeCode)}</span>
          {#if req.status === "CANCELLATION_REQUESTED"}
            <span class="chip chip-warn">Stornierung beantragt</span>
          {:else if req.status === "PENDING"}
            <span class="chip chip-warn">Ausstehend</span>
          {:else if req.status === "APPROVED"}
            <span class="chip chip-good">Genehmigt</span>
          {:else if req.status === "REJECTED"}
            <span class="chip chip-bad">Abgelehnt</span>
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if req.status === "PENDING" || req.status === "CANCELLATION_REQUESTED"}
            <!--
              Previously this branch rendered two buttons labeled "Ablehnen"
              and "Genehmigen" that both only opened the detail modal — a UX
              correctness bug (REVIEW WR-02). A manager clicking "Ablehnen"
              in a hurry would expect an immediate reject, not a modal open.
              The actual approve/reject controls live inside the modal and
              require an explicit confirmation step (and a reviewNote), so
              the row now exposes a single neutral "Prüfen" button whose
              label matches what the click actually does: open the detail
              modal for review.
            -->
            <button
              class="btn btn-primary sm"
              onclick={(e) => {
                e.stopPropagation();
                void openDetail(req);
              }}
            >
              Prüfen
            </button>
          {:else}
            <button
              class="btn btn-ghost sm"
              onclick={(e) => {
                e.stopPropagation();
                void openDetail(req);
              }}>Details</button
            >
          {/if}
        {/snippet}
      </ApprovalRow>
    {/each}

    <!-- Phase 63 D-14..D-17, D-22: read-only Berufsschultag rows. No approval
         flow — BBiG §15 mandates these days, so they exist only to inform the
         manager. Lock icon replaces the approve/reject buttons. -->
    {#each visibleBs as bs (bs.id)}
      <ApprovalRow
        avatar={initials(bs.employee.firstName, bs.employee.lastName)}
        name={`${bs.employee.firstName} ${bs.employee.lastName}`}
        dates={fmtDate(bs.date)}
      >
        {#snippet metaContent()}
          <span
            class="bs-badge"
            title="Gesetzlich vorgeschrieben — keine Genehmigung nötig (BBiG §15)"
          >
            Berufsschule
            <span class="bs-suffix">
              {bs.source === "PATTERN" ? "(Vorlage)" : "(manuell)"}
            </span>
          </span>
        {/snippet}
        {#snippet actions()}
          <span
            class="bs-lock"
            aria-label="Kein Genehmigungsprozess"
            title="Gesetzlich vorgeschrieben — keine Genehmigung nötig (BBiG §15)"
          >
            🔒
          </span>
        {/snippet}
      </ApprovalRow>
    {/each}
  {/if}
</Card>

<!-- ── Detail modal ──────────────────────────────────────────────────────── -->
{#if detailRequest}
  <Modal
    bind:open={detailOpen}
    eyebrow={detailRequest.status === "CANCELLATION_REQUESTED"
      ? "Stornierung prüfen"
      : "Antrag prüfen"}
    title={`${detailRequest.employee.firstName} ${detailRequest.employee.lastName}`}
  >
    <!-- Antragsdetails als MiniStats -->
    <div class="mini-stat-grid">
      <div class="mini-stat">
        <span class="label">Art</span>
        <span class="value">{typeLabel(detailRequest.typeCode)}</span>
      </div>
      <div class="mini-stat">
        <span class="label">Zeitraum</span>
        <span class="value mini-stat-value-md">
          {fmtDate(detailRequest.startDate)} – {fmtDate(detailRequest.endDate)}
        </span>
      </div>
      <div class="mini-stat">
        <span class="label">Umfang</span>
        <span class="value">{daysLabel(Number(detailRequest.days), detailRequest.halfDay)}</span>
      </div>
    </div>

    {#if detailRequest.note}
      <div class="note-block">
        <div class="note-label">Anmerkung Mitarbeiter</div>
        <div class="note-text">„{detailRequest.note}"</div>
      </div>
    {/if}

    <!-- Team overlap -->
    <div class="overlap-block">
      <div class="overlap-title">Kolleg:innen im gleichen Zeitraum</div>
      {#if detailLoadingOverlap}
        <div class="overlap-empty">Lädt…</div>
      {:else if approvedOverlap.length === 0}
        <div class="overlap-empty">Niemand sonst abwesend ✓</div>
      {:else}
        <div class="overlap-list">
          {#each approvedOverlap as o (o.id)}
            <div class="overlap-row">
              <span class="overlap-name">{o.employeeName}</span>
              <span class="chip">{o.typeName}</span>
              <span class="overlap-dates">
                {fmtDate(o.startDate)} – {fmtDate(o.endDate)}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- BUrlG § 7 callout -->
    <div class="callout">
      <span class="ico" aria-hidden="true">⚖</span>
      <p>
        <b>BUrlG § 7:</b> Urlaubsantrag muss zeitnah entschieden werden — gewährter Urlaub muss im laufenden
        Jahr gewährt werden, andernfalls verfällt er gem. § 7 Abs. 3 zum 31.03. des Folgejahres.
      </p>
    </div>

    <!-- Review note -->
    <div class="review-note-field">
      <label class="review-note-label" for="inbox-review-note">Anmerkung (optional)</label>
      <input
        id="inbox-review-note"
        type="text"
        class="review-note-input"
        bind:value={reviewNote}
        placeholder="Grund für Ablehnung o.ä."
      />
    </div>

    {#if reviewError}
      <div class="callout error" role="alert">
        <span class="ico">⚠</span>
        <p>{reviewError}</p>
      </div>
    {/if}

    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeDetail} disabled={reviewSaving}>
        Abbrechen
      </button>
      <span class="spacer"></span>
      {#if isSelfApproval(detailRequest)}
        <span class="footer-note"> Eigene Anträge können nicht selbst genehmigt werden. </span>
      {:else if detailRequest.status === "PENDING" || detailRequest.status === "CANCELLATION_REQUESTED"}
        <button
          class="btn btn-danger"
          onclick={() => submitReview("REJECTED")}
          disabled={reviewSaving}
        >
          {reviewSaving ? "…" : "Ablehnen"}
        </button>
        <button
          class="btn btn-primary"
          onclick={() => submitReview("APPROVED")}
          disabled={reviewSaving}
        >
          {reviewSaving ? "…" : "Genehmigen"}
        </button>
      {:else}
        <span class="footer-note">Antrag bereits entschieden.</span>
      {/if}
    {/snippet}
  </Modal>
{/if}

<style>
  /* ── KPI row ──────────────────────────────────────────────────────────── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 16px;
  }

  @media (max-width: 720px) {
    .kpi-row {
      grid-template-columns: 1fr;
    }
  }

  /* ── List card (overrides .card padding for full-bleed rows) ─────────── */
  :global(.list-card) {
    overflow: hidden;
  }

  /* Header wrapper that adds the bottom border separation when the CardHeader
     sits at the top of a padding:0 list card. */
  .list-card-header {
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--border);
  }
  .list-card-header :global(.card-hd) {
    margin-bottom: 0;
  }

  .list-empty {
    padding: 32px 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
  }

  /* ── Modal body helpers ───────────────────────────────────────────────── */
  .mini-stat-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    padding: 14px 16px;
    background: var(--bg-subtle);
    border-radius: var(--r-md);
    border: 1px solid var(--border);
  }
  .mini-stat-value-md {
    font-size: 16px;
  }

  @media (max-width: 560px) {
    .mini-stat-grid {
      grid-template-columns: 1fr;
    }
  }

  .note-block {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 12px 14px;
  }
  .note-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 6px;
  }
  .note-text {
    font-size: 13.5px;
    color: var(--text);
    font-style: italic;
  }

  /* ── Overlap section ──────────────────────────────────────────────────── */
  .overlap-block {
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  .overlap-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 10px;
  }
  .overlap-empty {
    font-size: 13.5px;
    color: var(--text-muted);
  }
  .overlap-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .overlap-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .overlap-name {
    font-weight: 600;
    color: var(--text);
  }
  .overlap-dates {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    font-size: 12.5px;
  }

  /* ── Review note input ────────────────────────────────────────────────── */
  .review-note-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .review-note-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .review-note-input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-card);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 13.5px;
    transition: border-color 160ms var(--ease);
  }
  .review-note-input:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
    border-color: var(--brand);
  }

  .footer-note {
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .spacer {
    flex: 1;
  }

  /* ── Phase 63 D-14..D-17, D-22 — read-only Berufsschule badge ─────────── */
  .bs-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--brand-soft);
    color: var(--brand);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 2px 8px;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .bs-suffix {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.75rem;
  }
  .bs-lock {
    font-size: 1rem;
    opacity: 0.7;
    line-height: 1;
  }

  /* D-17 mobile: keep badge + lock visible, hide the (Vorlage)/(manuell)
     suffix so the row stays a single line on narrow viewports. */
  @media (max-width: 640px) {
    .bs-suffix {
      display: none;
    }
  }
</style>
