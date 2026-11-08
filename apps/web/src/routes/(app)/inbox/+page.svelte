<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { hasAnyPermission } from "$lib/permissions"; // Phase 378 (#378)
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // § 9 reject reason (moved from /team/leave, #840)
  import EmptyState from "$components/ui/EmptyState.svelte";
  import { LEAVE_TYPE_OPTIONS, type CalendarTypeCode } from "$lib/leave/team-calendar-visibility"; // Phase 262, Phase 255
  import { leaveDaysLabel } from "$lib/leave/leave-days-label"; // Issue #595 (D-04)
  import LeaveReviewDialog from "$lib/components/leave/LeaveReviewDialog.svelte"; // Phase 255

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

  // LEAVE_TYPE_OPTIONS has no HOLIDAY entry (it is the nine-element set of types a
  // LeaveRequest can actually carry — team-calendar-visibility.ts:106-108). typeName("HOLIDAY")
  // would fall back to the raw code, but LeaveRequest.typeCode can never be HOLIDAY — that value
  // exists only in CalendarTypeCode, for calendar holiday colouring (CONTEXT <deferred>,
  // RESEARCH § Vocabulary Duplication). Measured gap, not a bug.
  function typeName(code: TypeCode): string {
    return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  // ── State ────────────────────────────────────────────────────────────────
  let requests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error = $state("");
  let tab: TabKey = $state("open");

  // Detail modal — Phase 255: markup and mutation now live in the shared LeaveReviewDialog
  // component; the page only keeps the two pieces of state that select which request is
  // under review.
  let detailRequest: LeaveRequest | null = $state(null);
  let detailOpen = $state(false);

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

  // Hint only (T-840-28): shows the § 9 section to holders of either § 9 key.
  const canSection9 = $derived(
    hasAnyPermission($authStore.user, ["section9:read:ZUGEWIESEN", "section9:decide:ZUGEWIESEN"]),
  );

  // ── Permission gate (Phase 378, #378) ─────────────────────────────────────
  // Either approve permission is enough — this Postfach approves both leave requests and
  // Zeitnachträge. A Salonmanager (Salon-Scope role assignment) holds both; an Ausbilder holds
  // neither (read-only template, #76) and correctly never reaches this page.
  onMount(() => {
    const canApprove = hasAnyPermission($authStore.user, [
      "leave-request:approve:ZUGEWIESEN",
      "retro-request:approve:ZUGEWIESEN",
    ]);
    if (!canApprove) {
      void goto("/dashboard");
      return;
    }
    void loadRequests();
    void loadRetroRequests();
    // The § 9 section is only a UX hint: the API answers 403 without `section9:read` and decides
    // every action by `section9:decide`.
    if (canSection9) void loadSection9Cases();
    else section9Loading = false;
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
  function openDetail(req: LeaveRequest) {
    detailRequest = req;
    detailOpen = true;
  }

  function isRetroSelfApproval(req: RetroEntryRequest): boolean {
    return req.employeeId === $authStore.user?.employeeId;
  }

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
      await Promise.all([loadRequests(), loadSection9Cases()]);
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
    await Promise.all([loadRequests(), loadSection9Cases()]);
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
        dates={`${fmtDate(req.startDate)} – ${fmtDate(req.endDate)} · ${leaveDaysLabel(Number(req.days), req.halfDay, req.typeCode)}`}
        onclick={() => openDetail(req)}
      >
        {#snippet metaContent()}
          <span class="chip chip-brand">{typeName(req.typeCode)}</span>
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
                openDetail(req);
              }}
            >
              Prüfen
            </button>
          {:else}
            <button
              class="btn btn-ghost sm"
              onclick={(e) => {
                e.stopPropagation();
                openDetail(req);
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

<!-- ── § 9 BUrlG — Fälle (Phase 104-10, R6/D-27/D-11; moved here from /team/leave, #840 D-840-05) ── -->
{#if canSection9}
  <Card animate class="list-card section9-list-card" style="padding: 0;">
    <div class="list-card-header">
      <CardHeader
        title="§ 9-Fälle"
        sub="§ 9 BUrlG — Urlaub und Krankheit überschneiden sich, die AU wartet auf deine Entscheidung"
      />
    </div>
    <div class="section9-cases" data-testid="section9-cases-list">
      {#if section9Loading}
        <div class="list-empty">Lädt…</div>
      {:else if openSection9Cases.length === 0}
        <EmptyState
          icon="inbox"
          title="Keine offenen § 9-Fälle"
          description="Es wartet keine Entscheidung zu einer Arbeitsunfähigkeit im Urlaub."
        />
      {:else}
        {#each openSection9Cases as c (c.id)}
          <div
            class="section9-case-row"
            id="section9-{c.id}"
            class:highlight-row={highlightSection9Id === c.id}
          >
            <div class="pending-info">
              <span class="pending-name">{c.employeeName}</span>
              <span class="pending-type">
                Urlaub {fmtDate(c.vacationRequest.startDate)}–{fmtDate(c.vacationRequest.endDate)} · Krank
                {fmtDate(c.sickRequest.startDate)}–{fmtDate(c.sickRequest.endDate)}
              </span>
              {#if c.status === "REJECTED"}
                <span class="badge badge-red" data-testid="section9-case-status">AU abgelehnt</span>
                {#if c.reason}
                  <span class="text-muted" title={c.reason}>„{c.reason}"</span>
                {/if}
              {:else}
                <span class="badge badge-yellow" data-testid="section9-case-status"
                  >AU ausstehend</span
                >
              {/if}
            </div>
            <div class="section9-case-actions">
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
                <p class="section9-case-hint text-muted">
                  Trifft die AU später ein, kann der Vorgang wieder eröffnet werden.
                </p>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </Card>
{/if}

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

<!-- ── Phase 104-10 (R6/D-27/D-26): "AU liegt vor" — Confirm-Dialog ─────────── -->
{#if section9ConfirmCase}
  <Modal bind:open={section9ConfirmOpen} eyebrow="§ 9 BUrlG" title="AU liegt vor">
    <div data-testid="section9-confirm-modal" style="display: contents">
      <div class="review-grid">
        <div class="review-field">
          <span class="review-label">Mitarbeiter</span>
          <span class="review-value">{section9ConfirmCase.employeeName}</span>
        </div>
        <div class="review-field">
          <span class="review-label">Überschneidung</span>
          <span class="review-value font-mono"
            >{fmtDate(section9ConfirmCase.overlapStart)} – {fmtDate(
              section9ConfirmCase.overlapEnd,
            )}</span
          >
        </div>
      </div>

      <div class="form-group review-section">
        <span class="form-label">Gültigkeit der AU</span>
        <div class="attest-dates">
          <div class="form-group">
            <label class="form-label" for="s9-from">Gültig von</label>
            <input
              id="s9-from"
              type="date"
              bind:value={section9AttestFrom}
              class="form-input attest-date-input"
            />
          </div>
          <div class="form-group">
            <label class="form-label" for="s9-to">Gültig bis</label>
            <input
              id="s9-to"
              type="date"
              bind:value={section9AttestTo}
              class="form-input attest-date-input"
            />
          </div>
        </div>
      </div>

      <div class="form-group review-section">
        <span class="form-label">Herkunft</span>
        <label class="toggle-label">
          <input type="radio" name="s9-source" value="EAU" bind:group={section9AttestSource} />
          <span>eAU abgerufen</span>
        </label>
        <label class="toggle-label">
          <input type="radio" name="s9-source" value="PAPIER" bind:group={section9AttestSource} />
          <span>Papier</span>
        </label>
      </div>

      {#if section9AttestSource === "PAPIER"}
        <div class="form-group review-section">
          <label class="form-label" for="s9-file">Papier-AU (optional)</label>
          <input
            id="s9-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            class="form-input"
            onchange={(e) => (section9File = (e.target as HTMLInputElement).files?.[0] ?? null)}
          />
          <p class="text-muted section9-hint">PDF, JPG oder PNG, max. 10 MB.</p>
        </div>
      {/if}

      <div class="form-group review-section">
        <label class="form-label" for="s9-reason">Begründung</label>
        <textarea
          id="s9-reason"
          class="form-input"
          rows="2"
          bind:value={section9Reason}
          placeholder="Verwaltungsvermerk zur Nachvollziehbarkeit"
        ></textarea>
        <p class="text-muted section9-hint">
          Verwaltungsvermerk zur Nachvollziehbarkeit — bitte keine Diagnose oder Arztangaben
          eintragen.
        </p>
      </div>

      {#if section9Error}
        <div class="alert alert-error review-error" role="alert">
          <span>⚠</span><span>{section9Error}</span>
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
  </Modal>
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
  onReviewed={loadRequests}
/>

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
  /* Shared with the retro-entry review dialog (out of scope, Issue #255) — the absence */
  /* review dialog moved to LeaveReviewDialog.svelte, these did NOT become dead CSS. */
  .mini-stat-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    padding: 14px 16px;
    background: var(--bg-subtle);
    border-radius: var(--r-md);
    border: 1px solid var(--border);
  }

  @media (max-width: 560px) {
    .mini-stat-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Shared with the retro-entry review dialog (out of scope, Issue #255) — the absence */
  /* review dialog moved to LeaveReviewDialog.svelte, these did NOT become dead CSS. */
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

  /* ── Review note input ────────────────────────────────────────────────── */
  /* Shared with the retro-entry review dialog (out of scope, Issue #255) — the absence */
  /* review dialog moved to LeaveReviewDialog.svelte, these did NOT become dead CSS. */
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

  /* Shared with the retro-entry review dialog (out of scope, Issue #255) — the absence */
  /* review dialog moved to LeaveReviewDialog.svelte, these did NOT become dead CSS. */
  .footer-note {
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .spacer {
    flex: 1;
  }

  /* ── § 9 cases (moved from /team/leave, #840) ─────────────────────────── */
  .section9-cases {
    display: flex;
    flex-direction: column;
    padding: 0 18px;
  }
  .section9-case-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.75rem 0;
    border-top: 1px solid var(--border);
  }
  .section9-case-row:first-child {
    border-top: none;
  }
  .section9-case-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .section9-case-hint {
    font-size: 0.8125rem;
    margin: 0;
  }
  .section9-hint {
    font-size: 0.8125rem;
    margin: 0.25rem 0 0;
  }
  .pending-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  .pending-name {
    font-weight: 600;
    white-space: nowrap;
  }
  .pending-type {
    color: var(--brand);
    font-weight: 500;
  }
  @keyframes highlight-fade {
    0% {
      background-color: var(--brand-soft);
    }
    100% {
      background-color: transparent;
    }
  }
  .highlight-row {
    animation: highlight-fade 3s var(--ease-out) both;
  }

  /* Modal body of the "AU liegt vor" dialog. */
  .attest-dates {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .attest-date-input {
    max-width: 160px;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
  }
  .review-error {
    margin-top: 0.75rem;
  }
  .review-section {
    margin-top: 1.25rem;
  }
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
</style>
