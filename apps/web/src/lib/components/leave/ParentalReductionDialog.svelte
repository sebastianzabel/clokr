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
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
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
  let preview: ParentalReductionPreview | null = $state(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state("");
  let declaredAt = $state("");
  let selectedYears: number[] = $state([]);

  const todayIso = new Date().toISOString().slice(0, 10);

  // Re-fetch the preview whenever the dialog opens with a request to show — including the very
  // first mount with `open: true` already set (same idiom as LeaveReviewDialog.svelte:83-106;
  // there is no earlier `false` state to transition FROM in a mounted test).
  $effect(() => {
    if (open && request) {
      error = "";
      declaredAt = "";
      selectedYears = [];
      preview = null;
      loading = true;
      api
        .get<ParentalReductionPreview>(`/leave/parental-reductions/${request.id}`)
        .then((p) => {
          preview = p;
          // Committable years are preselected (D-12) — the manager opts OUT, not in.
          selectedYears = p.years.filter((y) => y.committable).map((y) => y.year);
        })
        .catch((e: unknown) => {
          error = e instanceof Error ? e.message : "Fehler beim Laden der Vorschau.";
        })
        .finally(() => {
          loading = false;
        });
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

  let canSubmit = $derived(declaredAt !== "" && selectedYears.length > 0);

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
        <p class="text-muted">Lädt…</p>
      {:else if preview}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Jahr</th>
                <th>Volle Monate</th>
                <th>Jahresanspruch</th>
                <th>Kürzung (Tage)</th>
                <th>Anspruch (alt → neu)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {#each preview.years as y (y.year)}
                <tr data-testid={`parental-reduction-row-${y.year}`}>
                  <td>{y.year}</td>
                  <td>{y.months === 0 ? "kein voller Monat" : formatDays(y.months)}</td>
                  <td>{formatDays(y.regularDays)}</td>
                  <td>{formatDays(y.proposedReducedDays)}</td>
                  <td>
                    {#if y.currentTotalDays !== null && y.resultingTotalDays !== null}
                      {formatDays(y.currentTotalDays)} → {formatDays(y.resultingTotalDays)}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td>
                    {#if y.existing?.status === "ACTIVE"}
                      <span class="badge badge-green"
                        >erklärt am {fmtDate(y.existing.declaredAt)}</span
                      >
                    {:else if y.existing?.status === "REVOKED"}
                      <span class="badge badge-gray"
                        >widerrufen am {fmtDate(y.existing.revokedAt ?? "")}</span
                      >
                    {:else if y.committable}
                      <input
                        type="checkbox"
                        data-testid={`parental-reduction-select-${y.year}`}
                        checked={selectedYears.includes(y.year)}
                        onchange={() => toggleYear(y.year)}
                      />
                    {:else}
                      <span class="text-muted">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

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
      <button
        data-testid="parental-reduction-commit"
        class="btn btn-primary"
        onclick={submit}
        disabled={!canSubmit || saving}
      >
        {saving ? "…" : "Kürzung buchen"}
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  .parental-declare-field {
    margin-top: 1.25rem;
  }

  .spacer {
    flex: 1;
  }
</style>
