<!--
  BulkApplyDialog — preview and explicit confirmation of the bulk apply of the tenant default
  working time (Issue #568, D-07). The server computes the candidate set, the fingerprint and the
  allowed effective dates; this dialog only chooses inside that preview: one checkbox per contract
  (individual contracts start unticked), one month-first from the server's list. Nothing is saved
  until the admin confirms; a stale preview (409) or any other rejection stays inside the dialog.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import { ApiError } from "$api/client";
  import {
    isStalePreviewError,
    type BulkApplyCategory,
    type BulkApplyPreview,
    type BulkApplySelection,
  } from "$lib/api/bulk-apply";
  import {
    CATEGORY_LABELS,
    REASON_LABELS,
    formatContract,
    formatDateDe,
    initialSelection,
    summaryLine,
  } from "$lib/admin/bulk-apply-format";

  interface Props {
    open: boolean;
    /** Loads the server preview for the form's proposed values; undefined = the earliest date. */
    loadPreview: (effectiveFrom?: string) => Promise<BulkApplyPreview>;
    /** Saves the defaults together with the selection; rejects with the server's error. */
    onConfirm: (selection: BulkApplySelection) => Promise<void>;
  }

  let { open = $bindable(), loadPreview, onConfirm }: Props = $props();

  let preview = $state<BulkApplyPreview | null>(null);
  let selected = $state<Set<string>>(new Set());
  let loading = $state(false);
  let saving = $state(false);
  let errorText = $state<string | null>(null);
  let staleText = $state<string | null>(null);
  // Guards against an older response overwriting a newer one when the date is changed quickly.
  let requestId = 0;

  const BADGE_CLASS: Record<BulkApplyCategory, string> = {
    MATCHES_DEFAULTS: "badge-green",
    INDIVIDUAL: "badge-yellow",
    NO_CONTRACT: "badge-gray",
  };

  async function load(effectiveFrom?: string): Promise<boolean> {
    const mine = ++requestId;
    loading = true;
    errorText = null;
    try {
      const result = await loadPreview(effectiveFrom);
      if (mine !== requestId) return false;
      preview = result;
      selected = initialSelection(result);
      return true;
    } catch (err) {
      if (mine !== requestId) return false;
      errorText = messageOf(err);
      return false;
    } finally {
      if (mine === requestId) loading = false;
    }
  }

  function messageOf(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.";
  }

  // Start from a clean state each time the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      preview = null;
      selected = new Set();
      staleText = null;
      void load(undefined);
    });
  });

  let selectedCount = $derived(selected.size);
  let canConfirm = $derived(preview !== null && selectedCount > 0 && !loading && !saving);

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    selected = next;
  }

  async function changeDate(value: string) {
    staleText = null;
    await load(value);
  }

  async function confirm() {
    if (!preview || !canConfirm) return;
    const selection: BulkApplySelection = {
      applyEmployeeIds: [...selected].sort(),
      previewFingerprint: preview.fingerprint,
      effectiveFrom: preview.effectiveFrom,
    };
    saving = true;
    errorText = null;
    staleText = null;
    try {
      await onConfirm(selection);
      open = false;
    } catch (err) {
      if (isStalePreviewError(err)) {
        const reloaded = await load(selection.effectiveFrom);
        if (reloaded) {
          staleText =
            "Die Vorschau ist veraltet, weil sich Verträge oder Vorgaben geändert haben. Sie wurde neu geladen – bitte prüfen Sie die Auswahl erneut.";
        }
      } else {
        errorText = messageOf(err);
      }
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open eyebrow="Auf bestehende Verträge anwenden" title="Vorschau der Vertragsänderungen">
  <div class="bulk-body">
    {#if errorText}
      <div class="callout error" role="alert">{errorText}</div>
    {/if}
    {#if staleText}
      <div class="callout error" role="alert">{staleText}</div>
    {/if}

    {#if preview === null}
      {#if loading}
        <p class="form-hint" role="status">Vorschau wird geladen …</p>
      {/if}
    {:else}
      <div class="callout brand" role="note">
        Die Änderung gilt nie rückwirkend (§ 3 NachwG). Individuelle Verträge werden nur geändert,
        wenn Sie sie ausdrücklich ankreuzen.
      </div>

      <div class="form-group">
        <label class="form-label" for="bulk-effective-from">Gültig ab</label>
        <select
          id="bulk-effective-from"
          class="form-input"
          value={preview.effectiveFrom}
          disabled={loading || saving}
          onchange={(e) => changeDate(e.currentTarget.value)}
        >
          {#each preview.allowedEffectiveFrom as date (date)}
            <option value={date}>{formatDateDe(date)}</option>
          {/each}
        </select>
      </div>

      {#if loading}
        <p class="form-hint" role="status">Vorschau wird geladen …</p>
      {/if}

      {#if preview.candidates.length === 0}
        <div class="bulk-empty">
          <p class="bulk-empty-title">Keine Verträge zu ändern</p>
          <p class="form-hint">
            Entfernen Sie den Haken bei „Auch auf bestehende Mitarbeiter anwenden“, um nur die
            Vorgaben zu speichern.
          </p>
        </div>
      {:else}
        <p class="bulk-summary" role="status">
          {summaryLine(selectedCount, preview.effectiveFrom)}
        </p>
        <ul class="bulk-list">
          {#each preview.candidates as candidate (candidate.employeeId)}
            <li>
              <label class="bulk-row" class:bulk-row-on={selected.has(candidate.employeeId)}>
                <input
                  type="checkbox"
                  aria-label={`${candidate.name} (${candidate.employeeNumber}) ändern`}
                  checked={selected.has(candidate.employeeId)}
                  disabled={saving}
                  onchange={(e) => toggle(candidate.employeeId, e.currentTarget.checked)}
                />
                <span class="bulk-row-main">
                  <span class="bulk-row-head">
                    <span class="bulk-name">{candidate.name}</span>
                    <span class="bulk-number">{candidate.employeeNumber}</span>
                  </span>
                  <span class="bulk-change"
                    >{formatContract(candidate.before)} → {formatContract(candidate.after)}</span
                  >
                  <span class="badge {BADGE_CLASS[candidate.category]}"
                    >{CATEGORY_LABELS[candidate.category]}</span
                  >
                </span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}

      {#if preview.nonCandidates.length > 0}
        <section class="bulk-skipped" aria-labelledby="bulk-skipped-title">
          <h4 id="bulk-skipped-title">Nicht betroffen</h4>
          {#each preview.nonCandidates as group (group.reason)}
            <div class="bulk-skipped-group">
              <p class="bulk-skipped-reason">{REASON_LABELS[group.reason]} ({group.count})</p>
              <p class="bulk-skipped-names">
                {group.employees.map((e) => e.name).join(", ")}
              </p>
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" disabled={saving} onclick={() => (open = false)}>
      Abbrechen
    </button>
    <button type="button" class="btn btn-primary" disabled={!canConfirm} onclick={confirm}>
      {saving ? "Wird übernommen…" : "Änderungen übernehmen"}
    </button>
  {/snippet}
</Modal>

<style>
  .bulk-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .bulk-summary {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .bulk-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bulk-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
    cursor: pointer;
  }
  .bulk-row-on {
    border-color: var(--brand);
    background: var(--brand-soft);
  }
  .bulk-row input {
    accent-color: var(--brand);
    margin-top: 3px;
    flex-shrink: 0;
  }
  .bulk-row-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .bulk-row-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }
  .bulk-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .bulk-number {
    font-size: 12px;
    color: var(--text-muted);
  }
  .bulk-change {
    font-size: 13px;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .bulk-empty {
    padding: 12px 14px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-md);
  }
  .bulk-empty-title {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .bulk-empty .form-hint {
    margin: 0;
  }
  .bulk-skipped {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bulk-skipped h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .bulk-skipped-group p {
    margin: 0;
  }
  .bulk-skipped-reason {
    font-size: 13px;
    color: var(--text);
  }
  .bulk-skipped-names {
    font-size: 12px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
</style>
