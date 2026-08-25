<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
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

  type TabKey = "open" | "approved" | "rejected" | "all";

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

  type RetroTabKey = "open" | "approved" | "rejected" | "all";

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

  // ── RetroEntryRequest state ──────────────────────────────────────────────
  let retroRequests: RetroEntryRequest[] = $state([]);
  let retroLoading = $state(true);
  let retroTab: RetroTabKey = $state("open");

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

  // ── Role gate ────────────────────────────────────────────────────────────
  onMount(() => {
    const role = $authStore.user?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      void goto("/dashboard");
      return;
    }
    void loadRequests();
    void loadRetroRequests();
  });

  // ── Data loading ─────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();

  async function loadRequests() {
    loading = true;
    error = "";
    try {
      requests = await api.get<LeaveRequest[]>(`/leave/requests?year=${currentYear}`);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
      requests = [];
    } finally {
      loading = false;
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

  function isRetroSelfApproval(req: RetroEntryRequest): boolean {
    return req.employeeId === $authStore.user?.employeeId;
  }

  let approvedOverlap = $derived(detailOverlap.filter((o) => o.status === "APPROVED"));

  // ── Retro derived: filtered lists + KPI ──────────────────────────────────
  let retroOpenRequests = $derived(retroRequests.filter((r) => r.status === "PENDING"));
  let retroApprovedRequests = $derived(
    retroRequests.filter((r) => r.status === "APPROVED" || r.status === "USED"),
  );
  let retroRejectedRequests = $derived(retroRequests.filter((r) => r.status === "REJECTED"));

  let retroVisible = $derived.by(() => {
    if (retroTab === "open") return retroOpenRequests;
    if (retroTab === "approved") return retroApprovedRequests;
    if (retroTab === "rejected") return retroRejectedRequests;
    return retroRequests;
  });

  let kpiRetroPending = $derived(retroOpenRequests.length);

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

<!-- ── KPI row (4 stats: leave pending/approved/rejected + retro pending) ── -->
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
  <Card animate>
    <KPIStat
      label="Retro-Anträge"
      value={String(kpiRetroPending)}
      unit={kpiRetroPending === 1 ? "offen" : "offen"}
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
  {:else if visibleRequests.length === 0}
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
  {/if}
</Card>

<!-- ── Detail modal ──────────────────────────────────────────────────────── -->
<!-- ── Retro-Anträge view-tabs ─────────────────────────────────────────── -->
<div class="view-tabs retro-tabs" role="tablist">
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={retroTab === "open"}
    role="tab"
    aria-selected={retroTab === "open"}
    onclick={() => (retroTab = "open")}
  >
    Offen
    {#if retroOpenRequests.length > 0}
      <span class="tab-badge">{retroOpenRequests.length}</span>
    {/if}
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={retroTab === "approved"}
    role="tab"
    aria-selected={retroTab === "approved"}
    onclick={() => (retroTab = "approved")}
  >
    Genehmigt
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={retroTab === "rejected"}
    role="tab"
    aria-selected={retroTab === "rejected"}
    onclick={() => (retroTab = "rejected")}
  >
    Abgelehnt
  </button>
  <button
    type="button"
    class="view-tab"
    class:view-tab--active={retroTab === "all"}
    role="tab"
    aria-selected={retroTab === "all"}
    onclick={() => (retroTab = "all")}
  >
    Alle
  </button>
</div>

<!-- ── Retro-Anträge list card ────────────────────────────────────────── -->
<Card animate class="list-card retro-list-card" style="padding: 0;">
  <div class="list-card-header">
    <CardHeader
      title="Nachträgliche Zeiterfassungs-Anträge"
      sub="Anträge auf rückwirkende Einträge außerhalb des Selbstbearbeitungsfensters"
    />
  </div>

  {#if retroLoading}
    <div class="list-empty">Lädt…</div>
  {:else if retroVisible.length === 0}
    {#if retroTab === "open"}
      <EmptyState
        icon="inbox"
        title="Keine Retro-Anträge"
        description="Alle Anträge auf rückwirkende Einträge wurden bearbeitet."
      />
    {:else if retroTab === "approved"}
      <EmptyState
        icon="inbox"
        title="Keine Retro-Anträge"
        description="In diesem Zeitraum wurden keine Retro-Anträge genehmigt."
      />
    {:else if retroTab === "rejected"}
      <EmptyState
        icon="inbox"
        title="Keine Retro-Anträge"
        description="In diesem Zeitraum wurden keine Retro-Anträge abgelehnt."
      />
    {:else}
      <EmptyState
        icon="inbox"
        title="Keine Retro-Anträge"
        description="Keine Anträge auf rückwirkende Einträge vorhanden."
      />
    {/if}
  {:else}
    {#each retroVisible as req (req.id)}
      <ApprovalRow
        avatar={initials(req.employee.firstName, req.employee.lastName)}
        name={`${req.employee.firstName} ${req.employee.lastName}`}
        dates={`Eintrag vom ${fmtDate(req.targetDate)}${req.startTime && req.endTime ? ` · ${req.startTime}–${req.endTime}` : ""} · Alter: ${req.entryAgeInDays ?? "?"} Tage`}
        onclick={() => openRetroDetail(req)}
      >
        {#snippet metaContent()}
          <span class="chip chip-warn">Rückwirkend</span>
          <span class="chip">{fmtDate(req.targetDate)}</span>
          {#if req.status === "PENDING"}
            <span class="badge badge-yellow">Ausstehend</span>
          {:else if req.status === "APPROVED"}
            <span class="badge badge-green">Genehmigt</span>
          {:else if req.status === "REJECTED"}
            <span class="badge badge-red">Abgelehnt</span>
          {:else if req.status === "USED"}
            <span class="badge badge-gray">Verwendet</span>
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if req.status === "PENDING"}
            <button
              class="btn btn-primary btn-sm"
              onclick={(e) => {
                e.stopPropagation();
                openRetroDetail(req);
              }}
            >
              Prüfen
            </button>
          {:else}
            <button
              class="btn btn-ghost btn-sm"
              onclick={(e) => {
                e.stopPropagation();
                openRetroDetail(req);
              }}>Details</button
            >
          {/if}
        {/snippet}
      </ApprovalRow>
    {/each}
  {/if}
</Card>

<!-- ── Retro detail/review modal ──────────────────────────────────────── -->
{#if retroDetail}
  <Modal
    bind:open={retroDetailOpen}
    eyebrow="Retro-Antrag prüfen"
    title={`${retroDetail.employee.firstName} ${retroDetail.employee.lastName}`}
  >
    <!-- Mini-stat grid: Mitarbeiter / Zieldatum / Alter -->
    <div class="mini-stat-grid">
      <div class="mini-stat">
        <span class="label">Mitarbeiter</span>
        <span class="value">{retroDetail.employee.firstName} {retroDetail.employee.lastName}</span>
      </div>
      <div class="mini-stat">
        <span class="label">Zieldatum</span>
        <span class="value">{fmtDate(retroDetail.targetDate)}</span>
      </div>
      <div class="mini-stat">
        <span class="label">Alter (Tage)</span>
        <span
          class="value"
          style="font-family: var(--font-mono); font-variant-numeric: tabular-nums;"
        >
          {retroDetail.entryAgeInDays ?? "?"}
        </span>
      </div>
    </div>

    <!-- Vorgeschlagene Zeiten (RETRO-16/D-10: editable on approve — manager can
         correct the employee's proposal before it is written to the entry). -->
    {#if retroDetail.startTime && retroDetail.endTime}
      <div class="note-block">
        <div class="note-label">Vorgeschlagene Zeiten</div>
        <div class="retro-times-row">
          <div class="review-note-field">
            <label class="review-note-label" for="retro-edit-start">Von</label>
            <input
              id="retro-edit-start"
              type="time"
              class="review-note-input"
              bind:value={retroEditStartTime}
              disabled={retroReviewSaving}
            />
          </div>
          <div class="review-note-field">
            <label class="review-note-label" for="retro-edit-end">Bis</label>
            <input
              id="retro-edit-end"
              type="time"
              class="review-note-input"
              bind:value={retroEditEndTime}
              disabled={retroReviewSaving}
            />
          </div>
          <div class="review-note-field">
            <label class="review-note-label" for="retro-edit-break">Pause (Min.)</label>
            <input
              id="retro-edit-break"
              type="number"
              min="0"
              step="1"
              class="review-note-input"
              bind:value={retroEditBreakMinutes}
              disabled={retroReviewSaving}
            />
          </div>
        </div>
      </div>
    {/if}

    <!-- Begründung Mitarbeiter -->
    <div class="note-block">
      <div class="note-label">Begründung Mitarbeiter</div>
      <div class="note-text">„{retroDetail.reason}"</div>
    </div>

    <!-- Age warning callout (if age > window) -->
    {#if retroDetail.entryAgeInDays != null && retroDetail.windowDays != null && retroDetail.entryAgeInDays > retroDetail.windowDays}
      <div class="callout warning" role="alert">
        <span class="ico" aria-hidden="true">⚠</span>
        <p>
          Eintrag vom {fmtDate(retroDetail.targetDate)} liegt {retroDetail.entryAgeInDays} Tage in der
          Vergangenheit (Fenster: {retroDetail.windowDays} Tage).
        </p>
      </div>
    {/if}

    <!-- ArbZG legal callout (always shown) -->
    <div class="callout" role="note">
      <span class="ico" aria-hidden="true">⚖</span>
      <p>Rückwirkende Korrekturen müssen revisionssicher begründet sein (ArbZG § 16 Abs. 2).</p>
    </div>

    <!-- Review note — optional on approve, mandatory on reject (Revisionssicherheit) -->
    <div class="review-note-field">
      <label class="review-note-label" for="retro-review-note"
        >Kommentar <span class="text-muted">(optional bei Genehmigung, Pflicht bei Ablehnung)</span
        ></label
      >
      <input
        id="retro-review-note"
        type="text"
        class="review-note-input"
        bind:value={retroReviewNote}
        placeholder="Begründung für Genehmigung oder Ablehnung"
        disabled={retroReviewSaving}
      />
    </div>

    {#if retroReviewError}
      <div class="callout error" role="alert">
        <span class="ico">⚠</span>
        <p>{retroReviewError}</p>
      </div>
    {/if}

    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeRetroDetail} disabled={retroReviewSaving}>
        Abbrechen
      </button>
      <span class="spacer"></span>
      {#if retroDetail && isRetroSelfApproval(retroDetail)}
        <span class="footer-note">Eigene Anträge können nicht selbst genehmigt werden.</span>
      {:else if retroDetail?.status === "PENDING"}
        <button
          class="btn btn-danger"
          onclick={() => submitRetroReview("REJECTED")}
          disabled={retroReviewSaving || !retroReviewNote.trim()}
        >
          {retroReviewSaving ? "…" : "Ablehnen"}
        </button>
        <button
          class="btn btn-primary"
          onclick={() => submitRetroReview("APPROVED")}
          disabled={retroReviewSaving}
        >
          {retroReviewSaving ? "…" : "Genehmigen"}
        </button>
      {:else}
        <span class="footer-note">Antrag bereits entschieden.</span>
      {/if}
    {/snippet}
  </Modal>
{/if}

<!-- ── Leave detail modal ─────────────────────────────────────────────── -->
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
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 16px;
  }

  @media (max-width: 900px) {
    .kpi-row {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 560px) {
    .kpi-row {
      grid-template-columns: 1fr;
    }
  }

  /* ── Retro section spacing ────────────────────────────────────────────── */
  .retro-tabs {
    margin-top: 28px;
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

  /* ── Retro editable proposed-times row (RETRO-16/D-10) ──────────────────
     Layout-only wrapper around 3 existing .review-note-field/-input pairs —
     no new color/radius/spacing tokens, reuses the review-note-input look. */
  .retro-times-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .retro-times-row .review-note-field {
    flex: 1;
    min-width: 100px;
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
</style>
