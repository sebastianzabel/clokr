<script lang="ts">
  // Phase 87 — the single, shared, PII-free render surface for the appointment
  // collision warning. Passed as the `body` snippet into ConfirmDialog from all
  // three flows (leave create, leave approve + on-behalf create, shift delete).
  //
  // DSGVO boundary (T-87-07): this component renders ONLY {date, count} rows +
  // the optional deep-link. It never receives (and never renders) customer
  // names, service types, or appointment ids — the summary carries none.

  import {
    type CollisionSummary,
    formatCollisionDate,
    collisionCountLabel,
    collisionIntro,
  } from "$lib/phorest/appointmentCollisions";

  interface Props {
    summary: CollisionSummary;
    /** "range" = leave flows, "shift" = dated-shift delete. */
    variant?: "range" | "shift";
  }

  let { summary, variant = "range" }: Props = $props();
</script>

<div class="collision-warn">
  <p class="collision-intro">{collisionIntro(summary.total, variant)}</p>

  <ul class="collision-list">
    {#each summary.collisions as row (row.date)}
      <li class="collision-row">
        <span class="collision-date">{formatCollisionDate(row.date)}</span>
        <span class="collision-sep">—</span>
        <span class="collision-count">{collisionCountLabel(row.count)}</span>
      </li>
    {/each}
  </ul>

  {#if summary.deepLink}
    <a class="collision-deeplink" href={summary.deepLink} target="_blank" rel="noopener noreferrer">
      In Phorest-Kalender öffnen ↗
    </a>
  {/if}
</div>

<style>
  .collision-warn {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-3);
    background: var(--warn-soft);
    border: 1px solid var(--warn);
    border-radius: var(--r-md);
  }

  .collision-intro {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
  }

  .collision-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    max-height: 40vh;
    overflow-y: auto;
  }

  .collision-row {
    display: flex;
    align-items: baseline;
    gap: var(--s-1);
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
  }

  .collision-date {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .collision-sep {
    color: var(--text-muted);
  }

  .collision-count {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .collision-deeplink {
    font-size: 14px;
    line-height: 1.5;
    color: var(--brand);
    text-decoration: none;
  }

  .collision-deeplink:hover {
    text-decoration: underline;
  }
</style>
