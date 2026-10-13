<!--
  OperatorBar - the header of the operator console (Issue #89, D-03).

  Brand mark, the Betreiber badge, the session clock, the operator's display name and the logout
  button. It takes the remaining time as a prop and renders it; the layout owns the timer, the
  expiry redirect and the logout. The bar never carries a tenant name, a salon switcher, a
  notification bell or a theme control (UI-SPEC "Shell").

  The chip is not a live region (it changes every second). The two warnings go through a separate
  visually hidden polite status region instead, once at 2:00 and once at 0:30.
-->
<script lang="ts">
  import { announcementFor, formatRemaining, sessionState } from "$lib/operator/countdown";

  interface Props {
    /** Milliseconds until the session expires. */
    remainingMs: number;
    /** From GET /operator/auth/me; null while unknown or when the call failed. */
    displayName?: string | null;
    onLogout: () => void;
  }

  let { remainingMs, displayName = null, onLogout }: Props = $props();

  const chipState = $derived(sessionState(remainingMs));

  let announcement = $state("");
  // The reading before the current one. Null until the first reading, so loading the page inside
  // the warning window does not announce anything.
  let previousMs: number | null = null;

  $effect(() => {
    const ms = remainingMs;
    if (previousMs !== null) {
      const text = announcementFor(previousMs, ms);
      if (text !== null) announcement = text;
    }
    previousMs = ms;
  });
</script>

<header class="op-bar" data-testid="op-bar">
  <div class="op-brand">
    <img src="/clokr-icon.png" alt="" width="28" height="28" class="op-mark" />
    <span class="op-word">Clokr</span>
    <span class="badge badge-purple" data-testid="op-badge">Betreiber</span>
  </div>

  <div class="op-actions">
    <span
      class="badge op-chip"
      class:badge-gray={chipState !== "warning"}
      class:badge-yellow={chipState === "warning"}
      data-testid="op-session-chip"
      data-state={chipState}
    >
      Sitzung endet in
      <span class="op-remaining" data-testid="op-session-remaining"
        >{formatRemaining(remainingMs)}</span
      >
    </span>
    {#if displayName}
      <span class="op-name">{displayName}</span>
    {/if}
    <button
      type="button"
      class="btn btn-ghost btn-sm op-logout"
      data-testid="op-logout"
      onclick={onLogout}
    >
      Abmelden
    </button>
  </div>

  <span class="sr-only" role="status" data-testid="op-session-announce">{announcement}</span>
</header>

<style>
  .op-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: var(--topbar-h);
    padding: 8px 24px;
    background: var(--bg-card);
    border-top: 2px solid var(--brand);
    border-bottom: 1px solid var(--border);
  }

  .op-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .op-mark {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }

  .op-word {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }

  .op-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .op-remaining {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .op-name {
    font-size: 13px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  @media (min-width: 641px) {
    .op-bar {
      position: sticky;
      top: 0;
      z-index: 20;
    }
  }

  @media (max-width: 640px) {
    .op-bar {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "brand logout"
        "chip chip";
      gap: 8px 12px;
      padding: 8px 16px;
    }

    .op-brand {
      grid-area: brand;
    }

    .op-actions {
      display: contents;
    }

    .op-chip {
      grid-area: chip;
      justify-self: start;
    }

    .op-logout {
      grid-area: logout;
    }

    .op-name {
      display: none;
    }
  }
</style>
