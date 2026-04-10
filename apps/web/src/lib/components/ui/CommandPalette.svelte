<script lang="ts">
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { focusTrap } from "$lib/utils/focus-trap";

  interface Action {
    id: string;
    label: string;
    description: string;
    icon: string;
    href: string;
    group: string;
    adminOnly?: boolean;
  }

  interface ActionGroup {
    name: string;
    items: Action[];
  }

  const allActions: Action[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      description: "Zur Startseite",
      icon: "home",
      href: "/dashboard",
      group: "Navigation",
    },
    {
      id: "time-entries",
      label: "Zeiteinträge",
      description: "Arbeitszeiten verwalten",
      icon: "clock",
      href: "/time-entries",
      group: "Navigation",
    },
    {
      id: "leave",
      label: "Abwesenheiten",
      description: "Urlaub & Krankmeldungen",
      icon: "calendar",
      href: "/leave",
      group: "Navigation",
    },
    {
      id: "reports",
      label: "Berichte",
      description: "Auswertungen & Exporte",
      icon: "chart",
      href: "/reports",
      group: "Navigation",
    },
    {
      id: "admin",
      label: "Admin",
      description: "Verwaltung",
      icon: "settings",
      href: "/admin",
      group: "Navigation",
      adminOnly: true,
    },
    {
      id: "admin-shifts",
      label: "Schichtplan",
      description: "Schichten verwalten",
      icon: "calendar",
      href: "/admin/shifts",
      group: "Admin",
      adminOnly: true,
    },
    {
      id: "admin-vacation",
      label: "Urlaub & Zeiten",
      description: "Arbeitszeiten konfigurieren",
      icon: "settings",
      href: "/admin/vacation",
      group: "Admin",
      adminOnly: true,
    },
  ];

  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef: HTMLInputElement | undefined = $state();

  let isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));

  let filtered = $derived(
    allActions
      .filter((a) => !a.adminOnly || isManager)
      .filter((a) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q);
      }),
  );

  let grouped = $derived(
    filtered.reduce<ActionGroup[]>((groups, action) => {
      const existing = groups.find((g) => g.name === action.group);
      if (existing) {
        existing.items.push(action);
      } else {
        groups.push({ name: action.group, items: [action] });
      }
      return groups;
    }, []),
  );

  // Build a flat index map: for each action in the grouped list, calculate its flat index
  function getFlatIndex(groupIndex: number, itemIndex: number): number {
    let idx = 0;
    for (let g = 0; g < groupIndex; g++) {
      idx += grouped[g].items.length;
    }
    return idx + itemIndex;
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      open = !open;
      query = "";
      selectedIndex = 0;
    }
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filtered.length;
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        select(filtered[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function scrollActiveIntoView() {
    requestAnimationFrame(() => {
      const active = document.querySelector(".cmd-item--active");
      active?.scrollIntoView({ block: "nearest" });
    });
  }

  function select(action: Action) {
    close();
    if (action.href) goto(action.href);
  }

  function close() {
    open = false;
    query = "";
    selectedIndex = 0;
  }

  // Reset selection when query changes
  $effect(() => {
    // Access query to track it
    query;
    selectedIndex = 0;
  });

  // Focus input when opening
  $effect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef?.focus();
      });
    }
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="cmd-backdrop" onclick={close} onkeydown={() => {}}></div>

  <div class="cmd-palette" use:focusTrap role="dialog" aria-label="Schnellsuche" aria-modal="true">
    <div class="cmd-search">
      <svg
        class="cmd-search-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        bind:this={inputRef}
        type="text"
        bind:value={query}
        placeholder="Suchen oder navigieren..."
        class="cmd-input"
        onkeydown={handleInputKeydown}
        aria-label="Suche"
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="cmd-kbd">ESC</kbd>
    </div>

    <div class="cmd-results">
      {#each grouped as group, gi (group.name)}
        <div class="cmd-group-label">{group.name}</div>
        {#each group.items as action, ii (action.id)}
          {@const flatIdx = getFlatIndex(gi, ii)}
          <button
            class="cmd-item"
            class:cmd-item--active={flatIdx === selectedIndex}
            onclick={() => select(action)}
            onmouseenter={() => {
              selectedIndex = flatIdx;
            }}
          >
            <span class="cmd-item-icon">
              {#if action.icon === "home"}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              {:else if action.icon === "clock"}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              {:else if action.icon === "calendar"}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                  <line x1="16" x2="16" y1="2" y2="6" />
                  <line x1="8" x2="8" y1="2" y2="6" />
                  <line x1="3" x2="21" y1="10" y2="10" />
                </svg>
              {:else if action.icon === "chart"}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M3 3v18h18" />
                  <path d="M18 17V9" />
                  <path d="M13 17V5" />
                  <path d="M8 17v-3" />
                </svg>
              {:else if action.icon === "settings"}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                  />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              {/if}
            </span>
            <div class="cmd-item-text">
              <span class="cmd-item-label">{action.label}</span>
              <span class="cmd-item-desc">{action.description}</span>
            </div>
            <svg
              class="cmd-item-arrow"
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        {/each}
      {/each}

      {#if filtered.length === 0}
        <p class="cmd-empty">Keine Ergebnisse für &bdquo;{query}&ldquo;</p>
      {/if}
    </div>

    <div class="cmd-footer">
      <span class="cmd-hint">
        <kbd class="cmd-kbd-sm">&uarr;</kbd>
        <kbd class="cmd-kbd-sm">&darr;</kbd>
        Navigieren
      </span>
      <span class="cmd-hint">
        <kbd class="cmd-kbd-sm">&crarr;</kbd>
        Öffnen
      </span>
      <span class="cmd-hint">
        <kbd class="cmd-kbd-sm">ESC</kbd>
        Schließen
      </span>
    </div>
  </div>
{/if}

<style>
  /* ── Backdrop ────────────────────────────────────────────────────── */
  .cmd-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9000;
    animation: cmd-fade-in 0.15s ease-out;
  }

  /* ── Palette ─────────────────────────────────────────────────────── */
  .cmd-palette {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translateX(-50%);
    width: 90vw;
    max-width: 560px;
    max-height: 420px;
    z-index: 9001;
    display: flex;
    flex-direction: column;
    background: var(--glass-bg-strong, var(--color-surface));
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow:
      var(--shadow-lg),
      0 0 0 1px rgba(0, 0, 0, 0.03);
    overflow: hidden;
    animation: cmd-scale-in 0.15s var(--ease-out);
  }

  /* ── Search ──────────────────────────────────────────────────────── */
  .cmd-search {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
  }

  .cmd-search-icon {
    flex-shrink: 0;
    color: var(--color-text-muted);
  }

  .cmd-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: 1.0625rem;
    font-family: var(--font-sans);
    color: var(--color-text);
    caret-color: var(--color-brand);
    min-width: 0;
  }

  .cmd-input::placeholder {
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .cmd-kbd {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem 0.4rem;
    font-size: 0.6875rem;
    font-family: var(--font-sans);
    font-weight: 600;
    color: var(--color-text-muted);
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    line-height: 1.4;
  }

  /* ── Results ─────────────────────────────────────────────────────── */
  .cmd-results {
    flex: 1;
    overflow-y: auto;
    padding: 0.375rem 0;
  }

  .cmd-group-label {
    padding: 0.5rem 1rem 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .cmd-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 1rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    color: var(--color-text);
    transition:
      background-color 0.08s,
      color 0.08s;
    position: relative;
  }

  .cmd-item:hover,
  .cmd-item--active {
    background-color: var(--color-brand-tint);
    color: var(--color-brand);
  }

  .cmd-item--active .cmd-item-desc {
    color: var(--color-brand-light);
  }

  .cmd-item--active .cmd-item-icon {
    color: var(--color-brand);
  }

  .cmd-item--active .cmd-item-arrow {
    opacity: 1;
    color: var(--color-brand);
  }

  .cmd-item-icon {
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
    transition: color 0.08s;
  }

  .cmd-item-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
  }

  .cmd-item-label {
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.3;
  }

  .cmd-item-desc {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    line-height: 1.3;
    transition: color 0.08s;
  }

  .cmd-item-arrow {
    flex-shrink: 0;
    opacity: 0;
    color: var(--color-text-muted);
    transition: opacity 0.1s;
  }

  .cmd-item:hover .cmd-item-arrow {
    opacity: 0.5;
  }

  /* ── Empty state ─────────────────────────────────────────────────── */
  .cmd-empty {
    padding: 2rem 1rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  /* ── Footer ──────────────────────────────────────────────────────── */
  .cmd-footer {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
  }

  .cmd-hint {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  .cmd-kbd-sm {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.125rem;
    padding: 0 0.25rem;
    font-size: 0.625rem;
    font-family: var(--font-sans);
    font-weight: 600;
    color: var(--color-text-muted);
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    line-height: 1;
  }

  /* ── Animations ──────────────────────────────────────────────────── */
  @keyframes cmd-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes cmd-scale-in {
    from {
      opacity: 0;
      transform: translateX(-50%) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) scale(1);
    }
  }

  /* ── Mobile ──────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .cmd-palette {
      top: 10%;
      width: 94vw;
      max-height: 70vh;
    }

    .cmd-footer {
      display: none;
    }
  }
</style>
