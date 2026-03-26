<script lang="ts">
  interface Props {
    icon?: string;
    title: string;
    description?: string;
    actionLabel?: string;
    onaction?: () => void;
  }

  let { icon = "inbox", title, description, actionLabel, onaction }: Props = $props();
</script>

<!-- Render an empty state with an SVG icon, title, optional description and CTA -->
<div class="empty-state">
  <div class="empty-state-icon">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {#if icon === "inbox"}
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path
          d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
        />
      {:else if icon === "calendar"}
        <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
        <line x1="16" x2="16" y1="2" y2="6" />
        <line x1="8" x2="8" y1="2" y2="6" />
        <line x1="3" x2="21" y1="10" y2="10" />
      {:else if icon === "clock"}
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      {:else if icon === "bar-chart"}
        <path d="M3 3v18h18" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      {:else if icon === "users"}
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      {:else if icon === "file-text"}
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" x2="8" y1="13" y2="13" />
        <line x1="16" x2="8" y1="17" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      {:else if icon === "sun"}
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="m17.66 17.66 1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m6.34 17.66-1.41 1.41" />
        <path d="m19.07 4.93-1.41 1.41" />
      {:else if icon === "bell"}
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      {:else if icon === "search"}
        <circle cx="11" cy="11" r="8" />
        <line x1="21" x2="16.65" y1="21" y2="16.65" />
      {/if}
    </svg>
  </div>
  <h3 class="empty-state-title">{title}</h3>
  {#if description}
    <p class="empty-state-description">{description}</p>
  {/if}
  {#if actionLabel && onaction}
    <button class="btn btn-primary btn-sm empty-state-action" onclick={onaction}>
      {actionLabel}
    </button>
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 2rem;
    text-align: center;
    min-height: 200px;
  }

  .empty-state-icon {
    color: var(--color-text-muted);
    opacity: 0.4;
    margin-bottom: 1.25rem;
  }

  .empty-state-title {
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.5rem;
  }

  .empty-state-description {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
    max-width: 320px;
    line-height: 1.5;
    margin-bottom: 1.25rem;
  }

  .empty-state-action {
    margin-top: 0.5rem;
  }
</style>
