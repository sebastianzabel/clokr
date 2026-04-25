<script lang="ts">
  // Phase 19 will implement the full team time-entries feature.
  // This scaffold satisfies NAV-03 (route accessible to managers).
</script>

<div class="page-wrap card-animate">
  <div class="page-header">
    <h1 class="page-title">Team-Zeiten</h1>
    <p class="page-subtitle">Zeiterfassung aller Teammitglieder</p>
  </div>

  <div class="coming-soon-card">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="coming-soon-icon"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
    <p class="coming-soon-text">
      Hier können Manager die Zeiteinträge aller Teammitglieder einsehen und bearbeiten.
    </p>
    <p class="coming-soon-note">Wird in Phase 19 implementiert.</p>
  </div>
</div>

<style>
  .page-wrap {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .page-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .page-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--color-text-heading);
    margin: 0;
  }

  .page-subtitle {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .coming-soon-card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
    border-radius: var(--radius-md);
    padding: 3rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
  }

  .coming-soon-icon {
    color: var(--color-brand);
    opacity: 0.6;
  }

  .coming-soon-text {
    font-size: 0.9375rem;
    color: var(--color-text);
    max-width: 36rem;
    margin: 0;
    line-height: 1.6;
  }

  .coming-soon-note {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }
</style>
