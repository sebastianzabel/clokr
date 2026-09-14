<script lang="ts">
  /**
   * AttestFields — Phase 201 (GitHub issue #201).
   *
   * Extracted from the review modal's inline markup because the Attest fields now appear in
   * TWO dialogs: the review modal (`team/leave/+page.svelte`, approve/reject follow-up) and the
   * new standalone Attest dialog (record/change an Attest on an already-APPROVED row). Keeping
   * one copy avoids the two drifting apart.
   *
   * It is also what makes these fields testable at all: `apps/web/vitest.config.ts` registers no
   * `$app/*` aliases, so route pages that `import { page } from "$app/stores"` cannot be mounted
   * in a test — only a component living under `lib/` can be. Extracting this block is what buys
   * real, mounted test coverage instead of a source-read pin.
   *
   * This component holds NO submit control and makes NO API call. It only reads/writes the three
   * bindable values passed to it; the owning dialog decides what to do with them — the review
   * modal sends them as a follow-up to `PATCH /review`, the Attest dialog sends them alone via
   * `PATCH /attest`.
   */
  interface Props {
    /** Whether an Attest is on file. Bindable. */
    present: boolean;
    /** ISO yyyy-mm-dd, "" when unset. Bindable. */
    validFrom: string;
    /** ISO yyyy-mm-dd, "" when unset. Bindable. */
    validTo: string;
    /** Unique per instance — drives the input ids so two instances on one page stay associated. */
    idPrefix: string;
  }

  let {
    present = $bindable(),
    validFrom = $bindable(),
    validTo = $bindable(),
    idPrefix,
  }: Props = $props();
</script>

<div class="attest-box" data-testid="attest-fields">
  <p class="attest-title">Attest / Arbeitsunfähigkeitsbescheinigung</p>
  <label class="toggle-label">
    <input type="checkbox" data-testid="attest-present" bind:checked={present} class="toggle-cb" />
    <span>Attest liegt vor</span>
  </label>
  {#if present}
    <div class="attest-dates">
      <div class="form-group">
        <label class="form-label" for="{idPrefix}-attest-from">Gültig von</label>
        <input
          id="{idPrefix}-attest-from"
          data-testid="attest-valid-from"
          type="date"
          bind:value={validFrom}
          class="form-input attest-date-input"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="{idPrefix}-attest-to">Gültig bis</label>
        <input
          id="{idPrefix}-attest-to"
          data-testid="attest-valid-to"
          type="date"
          bind:value={validTo}
          class="form-input attest-date-input"
        />
      </div>
    </div>
  {/if}
</div>

<style>
  .attest-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.875rem 1rem;
  }
  .attest-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.625rem;
  }
  .attest-dates {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
  }
  .toggle-cb {
    width: 16px;
    height: 16px;
    accent-color: var(--brand);
  }
  .attest-date-input {
    max-width: 160px;
  }
</style>
