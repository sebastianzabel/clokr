<script lang="ts">
  /**
   * Issue #468 (D-12, A-2) — "Elternzeit-Kürzung erklären" dialog: preview, declaration and
   * commit of a § 17 Abs. 1 BEEG vacation reduction per calendar year touched by an approved
   * `PARENTAL` leave request.
   *
   * Like `LeaveReviewDialog.svelte` (Phase 255), this component does NOT import the shared auth
   * store — mounting pulls in `$app/environment` through that store, which
   * `apps/web/vitest.config.ts` registers no alias for outside the auth-store test shim. The
   * caller passes everything this dialog needs as props instead.
   *
   * T-468-23: every number shown here comes straight from the server preview
   * (`GET /leave/parental-reductions/:leaveRequestId`) — this component computes none of them.
   */
  import Modal from "$components/ui/Modal.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte"; // Issue #853
  import {
    PARENTAL_REDUCTION_HINT,
    formatDays,
    type ParentalReductionPreview,
    type ParentalReductionCommitResponse,
  } from "$lib/leave/parental-reduction";

  interface ParentalReductionRequest {
    id: string;
    employeeName: string;
    startDate: string;
    endDate: string;
  }

  interface Props {
    /** Bindable open state. The page owns the boolean, exactly like Modal/LeaveReviewDialog. */
    open: boolean;
    /** The Elternzeit request under review, or null when nothing is selected. */
    request: ParentalReductionRequest | null;
    /** The page-specific reload after a successful commit (mirrors LeaveReviewDialog's onReviewed). */
    onChanged: () => void | Promise<void>;
  }

  let { open = $bindable(), request, onChanged }: Props = $props();

  // ── Local state ──────────────────────────────────────────────────────────
  let preview = $state<ParentalReductionPreview | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state("");
  let declaredAt = $state("");
  let selectedYears: number[] = $state([]);
  // D-10: which year's revocation is being confirmed, or null when the ReasonDialog is closed.
  let revokeYear: number | null = $state(null);
  let revokeOpen = $state(false);

  const todayIso = new Date().toISOString().slice(0, 10);

  // Shared by the initial load (the $effect below) and by a successful revoke (D-10's "reloads
  // the preview") — one place, never two copies of the same fetch.
  async function loadPreview() {
    if (!request) return;
    error = "";
    loading = true;
    try {
      const p = await api.get<ParentalReductionPreview>(`/leave/parental-reductions/${request.id}`);
      preview = p;
      // Committable years are preselected (D-12) — the manager opts OUT, not in.
      selectedYears = p.years.filter((y) => y.committable).map((y) => y.year);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden der Vorschau.";
    } finally {
      loading = false;
    }
  }

  // Re-fetch the preview whenever the dialog opens with a request to show — including the very
  // first mount with `open: true` already set (same idiom as LeaveReviewDialog.svelte:83-106;
  // there is no earlier `false` state to transition FROM in a mounted test).
  $effect(() => {
    if (open && request) {
      declaredAt = "";
      selectedYears = [];
      preview = null;
      void loadPreview();
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }

  function toggleYear(year: number) {
    selectedYears = selectedYears.includes(year)
      ? selectedYears.filter((y) => y !== year)
      : [...selectedYears, year];
  }

  // Issue #853 (D-853-18): the year table is the DataTable block, one row per year of the preview.
  type YearRow = { id: number; y: ParentalReductionPreview["years"][number] };
  const YEAR_COLUMNS: DataTableColumn[] = [
    { key: "year", label: "Jahr", primary: true },
    { key: "months", label: "Volle Monate" },
    { key: "regular", label: "Jahresanspruch" },
    { key: "reduced", label: "Kürzung (Tage)" },
    { key: "entitlement", label: "Anspruch (alt → neu)" },
    { key: "status", label: "Status" },
  ];
  const yearRows: YearRow[] = $derived((preview?.years ?? []).map((y) => ({ id: y.year, y })));
  const yearRowKey = (row: YearRow) => row.id;
  const yearRowTestId = (row: YearRow) => `parental-reduction-row-${row.y.year}`;

  let canSubmit = $derived(declaredAt !== "" && selectedYears.length > 0);
  let anyCommittable = $derived(preview?.years.some((y) => y.committable) ?? false);

  function openRevoke(year: number) {
    revokeYear = year;
    revokeOpen = true;
  }

  // Never catches — a rejection must propagate so ReasonDialog's own throw-keeps-open contract
  // (see its doc comment) surfaces the server's German message inline and leaves the dialog open.
  async function confirmRevoke(reason: string) {
    if (!request || revokeYear === null) return;
    const year = revokeYear;
    await api.post(`/leave/parental-reductions/${request.id}/revoke`, { year, reason });
    toasts.success("Elternzeit-Kürzung widerrufen.");
    revokeYear = null;
    await loadPreview();
    await onChanged();
  }

  // ── Mutation ─────────────────────────────────────────────────────────────
  async function submit() {
    if (!request || !canSubmit) return;
    saving = true;
    error = "";
    try {
      const res = await api.post<ParentalReductionCommitResponse>(
        `/leave/parental-reductions/${request.id}`,
        { declaredAt, years: selectedYears },
      );
      toasts.success("Elternzeit-Kürzung gebucht.");
      for (const warning of res.warnings) toasts.warning(warning);
      open = false;
      await onChanged();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler";
    } finally {
      saving = false;
    }
  }
</script>

{#if request}
  <Modal
    bind:open
    eyebrow={`${request.employeeName} · ${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`}
    title="Elternzeit-Kürzung erklären"
  >
    <div data-testid="parental-reduction-dialog" style="display: contents">
      {#if loading}
        <Skeleton shape="line" />
      {:else if preview}
        <DataTable
          caption="Kürzung je Kalenderjahr"
          columns={YEAR_COLUMNS}
          rows={yearRows}
          rowKey={yearRowKey}
          rowTestId={yearRowTestId}
        >
          {#snippet cell(row, column)}
            {@const y = row.y}
            {#if column.key === "year"}
              {y.year}
            {:else if column.key === "months"}
              {y.months === 0 ? "kein voller Monat" : formatDays(y.months)}
            {:else if column.key === "regular"}
              {formatDays(y.regularDays)}
            {:else if column.key === "reduced"}
              {formatDays(y.proposedReducedDays)}
            {:else if column.key === "entitlement"}
              {#if y.currentTotalDays !== null && y.resultingTotalDays !== null}
                {formatDays(y.currentTotalDays)} → {formatDays(y.resultingTotalDays)}
              {:else}
                —
              {/if}
            {:else if column.key === "status"}
              {#if y.existing?.status === "ACTIVE"}
                <Chip tone="ok">erklärt am {fmtDate(y.existing.declaredAt)}</Chip>
                <button
                  class="btn btn-sm btn-ghost text-red"
                  data-testid={`parental-reduction-revoke-${y.year}`}
                  onclick={() => openRevoke(y.year)}
                >
                  Widerrufen
                </button>
              {:else if y.existing?.status === "REVOKED"}
                <Chip tone="neutral">widerrufen am {fmtDate(y.existing.revokedAt ?? "")}</Chip>
              {:else if y.committable}
                <input
                  type="checkbox"
                  aria-label={`Kürzung ${y.year} buchen`}
                  data-testid={`parental-reduction-select-${y.year}`}
                  checked={selectedYears.includes(y.year)}
                  onchange={() => toggleYear(y.year)}
                />
              {:else}
                <span class="text-muted">—</span>
              {/if}
            {/if}
          {/snippet}
        </DataTable>

        <div class="form-group parental-declare-field">
          <label class="form-label" for="parental-declared-at"
            >Erklärung gegenüber dem Mitarbeiter abgegeben am</label
          >
          <input
            id="parental-declared-at"
            data-testid="parental-reduction-declared-at"
            type="date"
            bind:value={declaredAt}
            max={todayIso}
            class="form-input"
            required
          />
        </div>

        <div class="callout">
          <span class="ico" aria-hidden="true">⚖</span>
          <p>{PARENTAL_REDUCTION_HINT}</p>
        </div>

        {#if !anyCommittable}
          <div class="callout brand">
            <span class="ico" aria-hidden="true">ℹ</span>
            <p>Für diese Elternzeit ist keine weitere Kürzung möglich.</p>
          </div>
        {/if}
      {/if}

      {#if error}
        <div class="callout error" role="alert">
          <span class="ico" aria-hidden="true">⚠</span>
          <p>{error}</p>
        </div>
      {/if}
    </div>

    {#snippet footer()}
      <button
        class="btn btn-ghost"
        onclick={() => {
          open = false;
        }}
        disabled={saving}
      >
        Abbrechen
      </button>
      <span class="spacer"></span>
      {#if anyCommittable}
        <button
          data-testid="parental-reduction-commit"
          class="btn btn-primary"
          onclick={submit}
          disabled={!canSubmit || saving}
        >
          {saving ? "…" : "Kürzung buchen"}
        </button>
      {/if}
    {/snippet}
  </Modal>

  <ReasonDialog
    bind:open={revokeOpen}
    title="Elternzeit-Kürzung widerrufen"
    label="Begründung"
    confirmLabel="Widerrufen"
    danger
    onConfirm={confirmRevoke}
  />
{/if}

<style>
  .parental-declare-field {
    margin-top: 1.25rem;
  }

  .spacer {
    flex: 1;
  }
</style>
