<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { format } from "date-fns";
  import { de } from "date-fns/locale";

  let clockedIn = $state(false);
  let activeEntryId: string | null = null;
  let loading = false;
  let clockLoading = $state(false);
  let breakMinutes = $state(0);
  let overtimeBalance = $state(0);
  let recentEntries: { id: string; endTime: string | null; startTime: string }[] = $state([]);
  let currentTime = $state(new Date());
  let clockStart: Date | null = $state(null);

  let timer: ReturnType<typeof setInterval>;

  onMount(async () => {
    await loadData();
    timer = setInterval(() => { currentTime = new Date(); }, 1000);
  });

  onDestroy(() => {
    clearInterval(timer);
  });

  async function loadData() {
    loading = true;
    try {
      const today = format(new Date(), "yyyy-MM-dd");
      const entries = await api.get<{ id: string; endTime: string | null; startTime: string }[]>(
        `/time-entries?from=${today}&to=${today}`
      );
      recentEntries = entries;

      const openEntry = entries.find((e) => !e.endTime);
      if (openEntry) {
        clockedIn = true;
        activeEntryId = openEntry.id;
        clockStart = new Date(openEntry.startTime);
      } else {
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
      }

      if ($authStore.user?.role !== "ADMIN") {
        const employeeId = $authStore.user?.employeeId;
        if (employeeId) {
          try {
            const account = await api.get<{ balanceHours: string }>(`/overtime/${employeeId}`);
            overtimeBalance = parseFloat(account.balanceHours);
          } catch {
            // overtime not available
          }
        }
      }
    } finally {
      loading = false;
    }
  }

  async function handleClock() {
    clockLoading = true;
    try {
      if (!clockedIn) {
        const res = await api.post<{ entry: { id: string } }>("/time-entries/clock-in", {
          source: "MOBILE",
        });
        activeEntryId = res.entry.id;
        clockedIn = true;
        clockStart = new Date();
      } else if (activeEntryId) {
        await api.post(`/time-entries/${activeEntryId}/clock-out`, { breakMinutes });
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
        breakMinutes = 0;
      }
      await loadData();
    } finally {
      clockLoading = false;
    }
  }

  function formatElapsed(start: Date | null, now: Date): string {
    if (!start) return "–";
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function greeting(): string {
    const h = new Date().getHours();
    if (h < 12) return "Guten Morgen";
    if (h < 18) return "Guten Tag";
    return "Guten Abend";
  }

  let userName = $derived($authStore.user?.email.split("@")[0] ?? "");
  let capitalizedName = $derived(userName.charAt(0).toUpperCase() + userName.slice(1));
  let overtimeClass =
    $derived(overtimeBalance >= 60 ? "text-red" :
    overtimeBalance >= 40 ? "text-yellow" :
    "text-green");

  const quickLinks = [
    { href: "/time-entries", icon: "🕐", label: "Zeiteinträge", desc: "Alle Einträge anzeigen" },
    { href: "/leave", icon: "🌴", label: "Urlaub", desc: "Antrag stellen" },
    { href: "/overtime", icon: "⏱️", label: "Überstunden", desc: "Konto einsehen" },
    { href: "/reports", icon: "📊", label: "Berichte", desc: "Auswertungen" },
  ];
</script>

<svelte:head>
  <title>Dashboard – Clokr</title>
</svelte:head>

<div class="dashboard">
  <!-- Page Header -->
  <div class="page-header">
    <h1>{greeting()}, {capitalizedName}!</h1>
    <p>{format(new Date(), "EEEE, d. MMMM yyyy", { locale: de })}</p>
  </div>

  <!-- Clock-in Card -->
  <div class="clock-card card card-body">
    <div class="clock-status">
      <span class="clock-dot" class:clock-dot--active={clockedIn}></span>
      <span class="clock-status-text">
        {clockedIn ? "Eingestempelt" : "Ausgestempelt"}
      </span>
    </div>

    <div class="clock-time font-mono">
      {format(currentTime, "HH:mm:ss")}
    </div>

    {#if clockedIn && clockStart}
      <p class="clock-elapsed text-muted">
        Eingestempelt seit {format(clockStart, "HH:mm")} Uhr
        · Elapsed: <span class="font-mono">{formatElapsed(clockStart, currentTime)}</span>
      </p>
    {/if}

    {#if clockedIn}
      <div class="clock-break">
        <label class="form-label" for="break-input">Pause (Minuten)</label>
        <input
          id="break-input"
          type="number"
          bind:value={breakMinutes}
          min="0"
          max="480"
          class="form-input clock-break-input"
        />
      </div>
    {/if}

    <button
      onclick={handleClock}
      disabled={clockLoading}
      class="btn clock-btn"
      class:clock-btn--in={!clockedIn}
      class:clock-btn--out={clockedIn}
    >
      {#if clockLoading}
        <span class="btn-spinner"></span>
      {/if}
      {clockedIn ? "Ausstempeln" : "Einstempeln"}
    </button>
  </div>

  <!-- Stats Row -->
  <div class="stats-grid">
    <div class="stat-card">
      <p class="stat-label">Heute</p>
      <p class="stat-value">
        {#if clockedIn && clockStart}
          <span class="font-mono" style="font-size: 1.5rem;">
            {formatElapsed(clockStart, currentTime)}
          </span>
        {:else if recentEntries.length > 0}
          <span>✓ Erfasst</span>
        {:else}
          –
        {/if}
      </p>
      <p class="stat-sub">
        {recentEntries.length > 0 ? `${recentEntries.length} Eintrag/Einträge` : "Noch keine Einträge"}
      </p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Diese Woche</p>
      <p class="stat-value">–</p>
      <p class="stat-sub">Nicht verfügbar</p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Überstunden</p>
      <p class="stat-value {overtimeClass}">
        {overtimeBalance >= 0 ? "+" : ""}{overtimeBalance.toFixed(1)}h
      </p>
      <p class="stat-sub">
        {overtimeBalance >= 60 ? "Kritisch" : overtimeBalance >= 40 ? "Erhöht" : "Normal"}
      </p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Resturlaub</p>
      <p class="stat-value">–</p>
      <p class="stat-sub">Nicht verfügbar</p>
    </div>
  </div>

  <!-- Quick Links -->
  <div class="quick-links-header">
    <h2>Schnellzugriff</h2>
  </div>
  <div class="quick-links">
    {#each quickLinks as link}
      <a href={link.href} class="quick-link card">
        <span class="quick-link-icon">{link.icon}</span>
        <div>
          <p class="quick-link-label">{link.label}</p>
          <p class="quick-link-desc text-muted">{link.desc}</p>
        </div>
      </a>
    {/each}
  </div>
</div>

<style>
  .dashboard {
    max-width: 900px;
  }

  /* Clock Card */
  .clock-card {
    text-align: center;
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .clock-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .clock-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background-color: var(--gray-300);
    flex-shrink: 0;
  }

  .clock-dot--active {
    background-color: var(--color-green);
    box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.2);
  }

  .clock-status-text {
    font-weight: 500;
  }

  .clock-time {
    font-size: 3.5rem;
    font-weight: 700;
    color: var(--color-text-heading);
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .clock-elapsed {
    font-size: 0.875rem;
  }

  .clock-break {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .clock-break-input {
    width: 5rem;
    text-align: center;
  }

  .clock-btn {
    padding: 0.75rem 2.5rem;
    font-size: 1rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 160px;
    justify-content: center;
  }

  .clock-btn--in {
    background-color: var(--color-green);
    color: #fff;
    border-color: var(--color-green);
  }

  .clock-btn--in:hover:not(:disabled) {
    background-color: #15803d;
    border-color: #15803d;
    color: #fff;
  }

  .clock-btn--out {
    background-color: var(--color-red);
    color: #fff;
    border-color: var(--color-red);
  }

  .clock-btn--out:hover:not(:disabled) {
    background-color: #b91c1c;
    border-color: #b91c1c;
    color: #fff;
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Stats */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  /* Quick Links */
  .quick-links-header {
    margin-bottom: 0.875rem;
  }

  .quick-links-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .quick-links {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }

  .quick-link {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 1.125rem 1.25rem;
    text-decoration: none;
    color: var(--color-text);
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .quick-link:hover {
    border-color: var(--color-brand-light);
    box-shadow: var(--shadow-md);
    color: var(--color-text);
  }

  .quick-link-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
  }

  .quick-link-label {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.125rem;
  }

  .quick-link-desc {
    font-size: 0.8125rem;
  }

  @media (max-width: 900px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .quick-links {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 480px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .quick-links {
      grid-template-columns: repeat(2, 1fr);
    }
    .clock-time {
      font-size: 2.5rem;
    }
  }
</style>
