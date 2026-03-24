<script lang="ts">
  import { page } from "$app/stores";

  // --- State ---
  type TerminalState = "idle" | "loading" | "success" | "error";

  let nfcInput = $state("");
  let terminalState: TerminalState = $state("idle");
  let employeeName = $state("");
  let action = $state<"CLOCK_IN" | "CLOCK_OUT" | "">("");
  let timestamp = $state("");
  let errorMessage = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  // Real-time clock
  let now = $state(new Date());
  let clockDisplay = $derived(
    now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  );
  let dateDisplay = $derived(
    now.toLocaleDateString("de-DE", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    }),
  );

  // Terminal secret from URL
  let terminalSecret = $derived($page.url.searchParams.get("secret") ?? "");

  // Clock interval
  $effect(() => {
    const interval = setInterval(() => {
      now = new Date();
    }, 1000);
    return () => clearInterval(interval);
  });

  // Auto-focus: keep input focused at all times
  $effect(() => {
    if (inputEl) {
      inputEl.focus();
      const refocus = () => {
        setTimeout(() => inputEl?.focus(), 50);
      };
      inputEl.addEventListener("blur", refocus);
      return () => inputEl?.removeEventListener("blur", refocus);
    }
  });

  // Auto-reset after feedback
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (terminalState === "success" || terminalState === "error") {
      resetTimer = setTimeout(() => {
        terminalState = "idle";
        employeeName = "";
        action = "";
        timestamp = "";
        errorMessage = "";
      }, 5000);
      return () => clearTimeout(resetTimer);
    }
  });

  async function handleScan() {
    const cardId = nfcInput.trim();
    nfcInput = "";

    if (!cardId) return;

    terminalState = "loading";

    try {
      const res = await fetch("/api/v1/time-entries/nfc-punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nfcCardId: cardId,
          terminalSecret,
        }),
      });

      if (res.status === 404) {
        terminalState = "error";
        errorMessage = "Unbekannte Karte";
        return;
      }

      if (!res.ok) {
        terminalState = "error";
        errorMessage = "Fehler";
        return;
      }

      const data = await res.json();
      employeeName = data.employeeName ?? data.employee?.name ?? "Mitarbeiter";
      action = data.action;
      timestamp = new Date(data.timestamp ?? Date.now()).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      terminalState = "success";
    } catch {
      terminalState = "error";
      errorMessage = "Fehler";
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan();
    }
  }
</script>

<svelte:head>
  <title>Terminal – Clokr</title>
</svelte:head>

<!-- Force dark theme on this page -->
<div class="terminal-page" data-theme="nacht">
  <!-- Hidden NFC input -->
  <input
    bind:this={inputEl}
    bind:value={nfcInput}
    onkeydown={onKeydown}
    class="nfc-input"
    type="text"
    autocomplete="off"
    aria-label="NFC Kartenleser"
  />

  <div class="terminal-content">
    <!-- Logo -->
    <div class="terminal-logo">
      <img src="/clokr-logo.png" alt="Clokr" class="terminal-logo-img" />
    </div>

    <!-- Clock -->
    <div class="terminal-clock">
      <div class="clock-time">{clockDisplay}</div>
      <div class="clock-date">{dateDisplay}</div>
    </div>

    <!-- Feedback area -->
    <div class="terminal-feedback">
      {#if terminalState === "idle"}
        <div class="feedback-card feedback-idle">
          <div class="feedback-icon">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
              <path d="M2 10h2" />
              <path d="M20 10h2" />
            </svg>
          </div>
          <p class="feedback-prompt">Karte an Leser halten</p>
        </div>
      {:else if terminalState === "loading"}
        <div class="feedback-card feedback-loading">
          <div class="feedback-spinner"></div>
        </div>
      {:else if terminalState === "success"}
        <div
          class="feedback-card feedback-success"
          class:clock-in={action === "CLOCK_IN"}
          class:clock-out={action === "CLOCK_OUT"}
        >
          <p class="feedback-name">{employeeName}</p>
          <p
            class="feedback-action"
            class:action-in={action === "CLOCK_IN"}
            class:action-out={action === "CLOCK_OUT"}
          >
            {action === "CLOCK_IN" ? "Eingestempelt" : "Ausgestempelt"}
          </p>
          <p class="feedback-timestamp">{timestamp}</p>
        </div>
      {:else if terminalState === "error"}
        <div class="feedback-card feedback-error">
          <div class="feedback-error-icon">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <p class="feedback-error-text">{errorMessage}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* ─── Page layout ───────────────────────────────────────────────────── */
  .terminal-page {
    min-height: 100vh;
    width: 100vw;
    background: #0c0c14;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "DM Sans", system-ui, sans-serif;
    color: #e8e8f4;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }

  .terminal-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2.5rem;
    width: 100%;
    max-width: 600px;
    padding: 2rem;
  }

  /* ─── Hidden NFC input ──────────────────────────────────────────────── */
  .nfc-input {
    position: absolute;
    top: -9999px;
    left: -9999px;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  /* ─── Logo ──────────────────────────────────────────────────────────── */
  .terminal-logo {
    text-align: center;
  }

  .terminal-logo-img {
    max-width: 200px;
    height: auto;
    filter: brightness(0.95);
  }

  /* ─── Clock ─────────────────────────────────────────────────────────── */
  .terminal-clock {
    text-align: center;
  }

  .clock-time {
    font-size: 6rem;
    font-weight: 300;
    letter-spacing: 0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: #ffffff;
    text-shadow: 0 0 40px rgba(157, 133, 242, 0.3);
  }

  .clock-date {
    font-size: 1.25rem;
    color: #7a7a95;
    margin-top: 0.5rem;
    font-weight: 400;
    letter-spacing: 0.02em;
  }

  /* ─── Feedback card ─────────────────────────────────────────────────── */
  .terminal-feedback {
    width: 100%;
    min-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .feedback-card {
    width: 100%;
    padding: 2.5rem 2rem;
    border-radius: 22px;
    text-align: center;
    background: rgba(30, 30, 42, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.3),
      0 2px 8px rgba(0, 0, 0, 0.15);
    animation: fadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  /* Idle state */
  .feedback-idle {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .feedback-icon {
    color: #7a7a95;
    animation: pulse 2.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.05);
    }
  }

  .feedback-prompt {
    font-size: 1.75rem;
    font-weight: 500;
    color: #9a9ab2;
    letter-spacing: 0.01em;
  }

  /* Loading state */
  .feedback-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 160px;
  }

  .feedback-spinner {
    width: 48px;
    height: 48px;
    border: 3px solid rgba(157, 133, 242, 0.2);
    border-top-color: #9d85f2;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Success state */
  .feedback-success {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .feedback-success.clock-in {
    border-color: rgba(52, 211, 153, 0.25);
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.3),
      0 0 60px rgba(52, 211, 153, 0.08);
  }

  .feedback-success.clock-out {
    border-color: rgba(248, 113, 113, 0.25);
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.3),
      0 0 60px rgba(248, 113, 113, 0.08);
  }

  .feedback-name {
    font-size: 2.5rem;
    font-weight: 600;
    color: #e8e8f4;
    line-height: 1.2;
  }

  .feedback-action {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .feedback-action.action-in {
    color: #34d399;
  }

  .feedback-action.action-out {
    color: #f87171;
  }

  .feedback-timestamp {
    font-size: 1.25rem;
    color: #7a7a95;
    font-variant-numeric: tabular-nums;
    margin-top: 0.25rem;
  }

  /* Error state */
  .feedback-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
    border-color: rgba(248, 113, 113, 0.2);
  }

  .feedback-error-icon {
    color: #f87171;
  }

  .feedback-error-text {
    font-size: 2rem;
    font-weight: 600;
    color: #f87171;
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 640px) {
    .clock-time {
      font-size: 3.5rem;
    }

    .clock-date {
      font-size: 1rem;
    }

    .feedback-name {
      font-size: 1.75rem;
    }

    .feedback-action {
      font-size: 1.25rem;
    }

    .feedback-prompt {
      font-size: 1.25rem;
    }
  }
</style>
