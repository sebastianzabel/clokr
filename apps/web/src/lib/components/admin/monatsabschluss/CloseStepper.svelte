<script lang="ts">
  // Issue #854 (plan 854-26, D-854-10) - the four-step indicator of the Monatsabschluss workflow
  // (Prüfen · Korrigieren · Bestätigen · Sperren). Presentation only: the page decides the current
  // step from the status of the month in view; nothing here navigates or writes. The active step
  // carries aria-current="step", finished steps a visually hidden „erledigt“. Colours come from the
  // tokens.css roles, the layout switches on the container (760 px), not on the viewport.
  interface Props {
    /** The step labels in order. */
    steps: string[];
    /** Index of the active step (0-based); every step before it counts as finished. */
    current: number;
    /** Accessible name of the list. */
    ariaLabel?: string;
  }

  let { steps, current, ariaLabel = "Schritte des Monatsabschlusses" }: Props = $props();
</script>

<nav class="close-stepper" aria-label={ariaLabel}>
  <ol class="cs-list">
    {#each steps as step, index (step)}
      {@const done = index < current}
      {@const active = index === current}
      <li
        class="cs-step"
        class:cs-step--active={active}
        class:cs-step--done={done}
        aria-current={active ? "step" : undefined}
        data-testid={`close-step-${index}`}
      >
        {#if index > 0}<span class="cs-connector" aria-hidden="true"></span>{/if}
        <span class="cs-dot" aria-hidden="true">
          {#if done}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2 6l3 3 5-5"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {:else}
            {index + 1}
          {/if}
        </span>
        <span class="cs-label">{step}</span>
        {#if done}<span class="sr-only">(erledigt)</span>{/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .close-stepper {
    container-type: inline-size;
    min-width: 0;
  }

  .cs-list {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cs-step {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-3);
  }

  .cs-connector {
    width: var(--s-8);
    height: 2px;
    margin-right: var(--s-2);
    background: var(--line);
    flex-shrink: 0;
  }

  .cs-step--done .cs-connector {
    background: var(--ok);
  }

  .cs-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border: 2px solid var(--line);
    border-radius: 50%;
    background: var(--card);
    color: var(--text-3);
    font-size: var(--fs-xs, 11px);
    font-weight: 600;
  }

  .cs-step--active .cs-dot {
    border-color: var(--brand);
    background: var(--brand);
    color: var(--brand-ink);
  }

  .cs-step--done .cs-dot {
    border-color: var(--ok);
    background: var(--ok);
    color: var(--card);
  }

  .cs-label {
    font-size: var(--fs-base);
    font-weight: 500;
    white-space: nowrap;
  }

  .cs-step--active .cs-label {
    color: var(--text);
    font-weight: 600;
  }

  .cs-step--done .cs-label {
    color: var(--text-2);
  }

  /* Narrow container (Issue #947): every step keeps its name; the steps wrap onto a second row
     instead of hiding their labels, and the connectors shrink. */
  @container (max-width: 759.98px) {
    .cs-list {
      flex-wrap: wrap;
      row-gap: var(--s-2);
    }

    .cs-label {
      white-space: normal;
      font-size: var(--fs-sm);
    }

    .cs-connector {
      width: var(--s-3);
      margin-right: var(--s-1);
    }
  }
</style>
