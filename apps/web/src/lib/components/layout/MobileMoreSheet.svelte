<script lang="ts">
  import { focusTrap } from "$lib/utils/focus-trap";

  type NavItem = { href: string; label: string; icon: string };

  interface Props {
    /** Two-way bindable open state. Parent holds the flag. */
    open: boolean;
    /** Persona-filtered overflow nav items. */
    items: NavItem[];
    /** Used to mark the active item with brand-soft highlight. */
    currentPath: string;
  }

  let { open = $bindable(), items, currentPath }: Props = $props();

  let scrimEl: HTMLDivElement | undefined = $state();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      open = false;
    }
  }

  function onScrimClick(e: MouseEvent) {
    // Only close when the click landed on the scrim itself, never a child.
    if (e.target === e.currentTarget) open = false;
  }

  function onItemClick() {
    // Navigation occurs through <a href> — close the sheet so the page
    // transition happens against a clean shell.
    open = false;
  }

  function isActive(href: string, path: string): boolean {
    if (href === "/dashboard") return path === "/dashboard";
    return path === href || path.startsWith(href + "/");
  }

  // Lock body scroll + mark sibling content inert while open.
  // Same pattern as Modal.svelte — see that file for the rationale on why
  // we exclude the scrim's containing element by reference rather than by
  // class name (SvelteKit's display:contents wrapper).
  $effect(() => {
    if (!open || !scrimEl) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const toRestore: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child.contains(scrimEl)) continue;
      if (child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      toRestore.push(child);
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const el of toRestore) el.removeAttribute("inert");
    };
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#snippet sheetIcon(name: string)}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if name === "dashboard"}
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    {:else if name === "clock"}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    {:else if name === "calendar"}
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    {:else if name === "calendar-check"}
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
      <path d="M9 15l2.5 2.5L16 13" />
    {:else if name === "umbrella"}
      <path d="M12 3v18M3 12a9 9 0 0 1 18 0H3z" />
      <path d="M9 12a3 3 0 0 1 6 0" />
      <path d="M12 21a2 2 0 0 1-2-2" />
    {:else if name === "inbox"}
      <path d="M3 13l3-9h12l3 9" />
      <path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    {:else if name === "users"}
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.8" />
      <path d="M16 20a5 5 0 0 1 5.5-5" />
    {:else if name === "grid"}
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    {:else if name === "chart"}
      <path d="M4 20V8M10 20V4M16 20v-7M22 20H2" />
    {:else if name === "shield"}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    {:else if name === "download"}
      <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
      <path d="M4 19h16" />
    {:else if name === "upload"}
      <path d="M12 21V9m0 0l-4 4m4-4l4 4" />
      <path d="M4 5h16" />
    {:else if name === "lock"}
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    {:else if name === "palette"}
      <path d="M12 3a9 9 0 0 0 0 18c1 0 2-.8 2-2a2 2 0 0 1 2-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-10z" />
      <circle cx="7.5" cy="10.5" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="16.5" cy="10.5" r="1" />
    {:else if name === "star"}
      <path d="M12 2.5l3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.9 5.9 21.3l1.2-6.8L2.2 9.7l6.8-1z" />
    {:else if name === "wifi"}
      <path d="M3 9a15 15 0 0 1 18 0" />
      <path d="M6 12.5a10 10 0 0 1 12 0" />
      <path d="M9 16a5 5 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
    {:else if name === "settings"}
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />
    {/if}
  </svg>
{/snippet}

{#if open}
  <div class="mehr-scrim" role="presentation" onclick={onScrimClick} bind:this={scrimEl}>
    <div
      class="mehr-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Weitere Navigation"
      use:focusTrap
    >
      <header class="mehr-sheet-hd">
        <span class="mehr-sheet-grabber" aria-hidden="true"></span>
        <h3 class="mehr-sheet-title">Mehr</h3>
        <button
          type="button"
          class="mehr-sheet-close"
          aria-label="Schließen"
          onclick={() => (open = false)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>
      <div class="mehr-sheet-body">
        <nav class="mehr-sheet-nav" aria-label="Weitere Navigation">
          {#each items as item (item.href)}
            {@const active = isActive(item.href, currentPath)}
            <a
              href={item.href}
              class="mehr-item"
              class:mehr-item-active={active}
              aria-current={active ? "page" : undefined}
              onclick={onItemClick}
            >
              <span class="mehr-item-icon" aria-hidden="true">{@render sheetIcon(item.icon)}</span>
              <span class="mehr-item-label" translate="no">{item.label}</span>
            </a>
          {/each}
        </nav>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Mobile More Sheet (UI-15) ────────────────────────────────
     Bottom-sheet variant of the Modal pattern: focus-trap + ESC + scrim-click
     close, body-scroll lock, inert siblings. Slides up from the bottom edge. */
  .mehr-scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 500;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: mehr-fade 180ms var(--ease-out);
  }

  .mehr-sheet {
    width: 100%;
    max-height: 80vh;
    background: var(--bg-card);
    border-top-left-radius: var(--r-lg);
    border-top-right-radius: var(--r-lg);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: mehr-slide-up 240ms var(--ease-out);
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .mehr-sheet-hd {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px 16px 12px;
    border-bottom: 1px solid var(--border);
  }

  .mehr-sheet-grabber {
    position: absolute;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--border-strong, var(--border));
  }

  .mehr-sheet-title {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 18px;
    font-weight: 400;
    color: var(--text);
  }

  .mehr-sheet-close {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .mehr-sheet-close:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }

  .mehr-sheet-close:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }

  .mehr-sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
  }

  .mehr-sheet-nav {
    display: flex;
    flex-direction: column;
  }

  .mehr-item {
    display: flex;
    align-items: center;
    gap: 14px;
    /* WCAG 2.5.5 — 48px ≥ 44 minimum for comfort. */
    min-height: 48px;
    padding: 10px 18px;
    color: var(--text);
    text-decoration: none;
    font-family: var(--font-sans);
    font-size: 14.5px;
    font-weight: 500;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .mehr-item:hover,
  .mehr-item:focus-visible {
    background: var(--bg-subtle);
  }

  .mehr-item:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: -2px;
  }

  .mehr-item-active {
    background: var(--brand-soft);
    color: var(--brand);
  }

  .mehr-item-icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .mehr-item-active .mehr-item-icon {
    color: var(--brand);
  }

  /* Semantic hook for the visible label — typography is inherited from
     .mehr-item; this selector exists so lint:ui-classes can match it. */
  .mehr-item-label {
    flex: 1;
    min-width: 0;
  }

  @keyframes mehr-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes mehr-slide-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
</style>
