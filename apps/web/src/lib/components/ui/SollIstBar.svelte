<script lang="ts">
  // Quick task 260820-elk — Soll/Ist progress bar primitive (design variant 1c
  // "Fortschritt"). The hatched deficit segment IS the saldo — reading the bar answers
  // "how far behind/ahead am I" without doing arithmetic (see 260820-elk-CONTEXT.md).
  //
  // Deliberately does NOT take a `saldoMin` prop: deriving `istMin - sollToDateMin`
  // inside the bar guarantees the bar and its labels can never disagree with each
  // other, and it is a subtraction of two server-supplied figures — not a saldo
  // recomputation (CLAUDE.md / CONTEXT: no client-side saldo computation).
  //
  // Geometry: the track represents max(sollToDateMin, istMin) so the segments ALWAYS
  // sum to exactly 100% with no clamping artefacts. Every division is guarded by
  // `hasSoll && span > 0` BEFORE the division happens — there is no code path where a
  // division-by-zero occurs and is sanitised after the fact.
  import { fmtMin } from "$lib/utils/format-minutes";

  interface Props {
    /** Soll to date, minutes. <= 0 selects the "no Soll" branch. */
    sollToDateMin: number;
    /** Ist to date, minutes. */
    istMin: number;
  }

  let { sollToDateMin, istMin }: Props = $props();

  const hasSoll = $derived(sollToDateMin > 0);
  const span = $derived(Math.max(sollToDateMin, istMin));
  const basePct = $derived(
    hasSoll && span > 0 ? (Math.min(istMin, sollToDateMin) / span) * 100 : 0,
  );
  const overPct = $derived(
    hasSoll && span > 0 && istMin > sollToDateMin ? ((istMin - sollToDateMin) / span) * 100 : 0,
  );
  const defPct = $derived(
    hasSoll && span > 0 && istMin < sollToDateMin ? ((sollToDateMin - istMin) / span) * 100 : 0,
  );
  // Soll-position tick, only meaningful when there is an overhang to mark.
  const tickPct = $derived(hasSoll && span > 0 ? (sollToDateMin / span) * 100 : 0);

  const diffMin = $derived(Math.abs(istMin - sollToDateMin));
  const behind = $derived(istMin < sollToDateMin);
  const exact = $derived(hasSoll && istMin === sollToDateMin);

  const midLabel = $derived.by(() => {
    if (exact) return "ausgeglichen";
    return behind ? `fehlen ${fmtMin(diffMin)} h` : `+${fmtMin(diffMin)} h mehr`;
  });

  // 260820-elk follow-up (coordinator-measured deviation #1) — the mid label names the
  // deficit/overhang the hatch/overhang segment depicts; it must not read as quieter than
  // the plain Ist/Soll labels flanking it. "ausgeglichen" (exact match) stays neutral.
  const midTone = $derived.by(() => {
    if (exact) return "neutral";
    return behind ? "bad" : "good";
  });

  const ariaLabel = $derived.by(() => {
    const base = `${fmtMin(istMin)} von ${fmtMin(sollToDateMin)} Stunden erfüllt`;
    if (exact) return `${base}, ausgeglichen`;
    return `${base}, ${fmtMin(diffMin)} Stunden ${behind ? "fehlen" : "mehr"}`;
  });
</script>

{#if !hasSoll}
  <p class="sib-nosoll" data-testid="soll-ist-bar-nosoll">noch keine Sollzeit in diesem Monat</p>
{:else}
  <div class="sib-track" role="img" aria-label={ariaLabel} data-testid="soll-ist-bar">
    <div class="sib-seg sib-seg--base" style:width={`${basePct}%`}></div>
    {#if overPct > 0}
      <div class="sib-seg sib-seg--over" style:width={`${overPct}%`}></div>
      <div class="sib-tick" style:left={`${tickPct}%`} aria-hidden="true"></div>
    {/if}
    {#if defPct > 0}
      <div class="sib-seg sib-seg--deficit" style:width={`${defPct}%`}></div>
    {/if}
  </div>
  <div class="sib-labels">
    <span>Ist {fmtMin(istMin)} h</span>
    <span class="sib-label--mid sib-label--mid--{midTone}">{midLabel}</span>
    <span>Soll {fmtMin(sollToDateMin)} h</span>
  </div>
{/if}

<style>
  .sib-track {
    height: 12px;
    border-radius: var(--r-pill);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    position: relative;
  }

  .sib-seg {
    height: 100%;
    transition: width 240ms ease;
  }

  .sib-seg--base {
    background: var(--brand);
  }

  .sib-seg--over {
    background: var(--good);
  }

  .sib-seg--deficit {
    background-color: var(--bar-hatch-bg);
    background-image: repeating-linear-gradient(
      45deg,
      var(--bar-hatch-line) 0 2px,
      transparent 2px 6px
    );
  }

  .sib-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--border-strong);
  }

  .sib-labels {
    display: flex;
    justify-content: space-between;
    gap: var(--s-2);
    margin-top: var(--s-2);
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .sib-label--mid {
    color: var(--text);
  }

  /* 260820-elk follow-up — the mid label IS the whole point of the bar (it names the
     deficit/overhang the hatch/overhang segment depicts), so it must read heavier than
     the plain Ist/Soll labels flanking it, not quieter. */
  .sib-label--mid--bad {
    color: var(--bad);
    font-weight: 600;
  }

  .sib-label--mid--good {
    color: var(--good);
    font-weight: 600;
  }

  .sib-nosoll {
    font-size: 12px;
    color: var(--text-muted);
    margin: var(--s-2) 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .sib-seg {
      transition: none;
    }
  }
</style>
