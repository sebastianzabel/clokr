<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { theme, themes } from "$stores/theme";

  interface TenantConfig {
    federalState: string;
    defaultWeeklyHours: number;
    defaultMondayHours: number;
    defaultTuesdayHours: number;
    defaultWednesdayHours: number;
    defaultThursdayHours: number;
    defaultFridayHours: number;
    defaultSaturdayHours: number;
    defaultSundayHours: number;
    overtimeThreshold: number;
    allowOvertimePayout: boolean;
    defaultVacationDays: number;
    carryOverDeadlineDay: number;
    carryOverDeadlineMonth: number;
  }

  const STATES: { prisma: string; label: string }[] = [
    { prisma: "NIEDERSACHSEN",          label: "Niedersachsen" },
    { prisma: "BADEN_WUERTTEMBERG",     label: "Baden-Württemberg" },
    { prisma: "BAYERN",                 label: "Bayern" },
    { prisma: "BERLIN",                 label: "Berlin" },
    { prisma: "BRANDENBURG",            label: "Brandenburg" },
    { prisma: "BREMEN",                 label: "Bremen" },
    { prisma: "HAMBURG",                label: "Hamburg" },
    { prisma: "HESSEN",                 label: "Hessen" },
    { prisma: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
    { prisma: "NORDRHEIN_WESTFALEN",    label: "Nordrhein-Westfalen" },
    { prisma: "RHEINLAND_PFALZ",        label: "Rheinland-Pfalz" },
    { prisma: "SCHLESWIG_HOLSTEIN",     label: "Schleswig-Holstein" },
    { prisma: "SAARLAND",               label: "Saarland" },
    { prisma: "SACHSEN",                label: "Sachsen" },
    { prisma: "SACHSEN_ANHALT",         label: "Sachsen-Anhalt" },
    { prisma: "THUERINGEN",             label: "Thüringen" },
  ];

  let loading = $state(true);
  let error = $state("");

  // Federal state
  let gFederalState = $state("NIEDERSACHSEN");
  let _gOtherFields: Omit<TenantConfig, "federalState"> | null = null;
  let stateSaving = $state(false);
  let stateSaved = $state(false);
  let stateError = $state("");

  // SMTP
  let smtpHost = $state("");
  let smtpPort = $state(587);
  let smtpUser = $state("");
  let smtpPassword = $state("");
  let smtpFromEmail = $state("");
  let smtpFromName = $state("");
  let smtpSecure = $state(false);
  let smtpPasswordSet = $state(false);
  let smtpSaving = $state(false);
  let smtpSaved = $state(false);
  let smtpError = $state("");
  let smtpTestEmail = $state("");
  let smtpTesting = $state(false);
  let smtpTestResult = $state("");
  let smtpTestError = $state("");

  // 2FA
  let twoFaEnabled = $state(false);
  let twoFaSaving = $state(false);
  let twoFaError = $state("");

  onMount(async () => {
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gFederalState = cfg.federalState ?? "NIEDERSACHSEN";
      _gOtherFields = {
        defaultWeeklyHours:    cfg.defaultWeeklyHours,
        defaultMondayHours:    cfg.defaultMondayHours,
        defaultTuesdayHours:   cfg.defaultTuesdayHours,
        defaultWednesdayHours: cfg.defaultWednesdayHours,
        defaultThursdayHours:  cfg.defaultThursdayHours,
        defaultFridayHours:    cfg.defaultFridayHours,
        defaultSaturdayHours:  cfg.defaultSaturdayHours,
        defaultSundayHours:    cfg.defaultSundayHours,
        overtimeThreshold:     cfg.overtimeThreshold,
        allowOvertimePayout:   cfg.allowOvertimePayout,
        defaultVacationDays:   cfg.defaultVacationDays,
        carryOverDeadlineDay:  cfg.carryOverDeadlineDay,
        carryOverDeadlineMonth: cfg.carryOverDeadlineMonth,
      };

      try {
        const smtp = await api.get<{ smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpPasswordSet: boolean; smtpFromEmail: string | null; smtpFromName: string | null; smtpSecure: boolean }>("/settings/smtp");
        smtpHost        = smtp.smtpHost      ?? "";
        smtpPort        = smtp.smtpPort      ?? 587;
        smtpUser        = smtp.smtpUser      ?? "";
        smtpPasswordSet = smtp.smtpPasswordSet;
        smtpFromEmail   = smtp.smtpFromEmail ?? "";
        smtpFromName    = smtp.smtpFromName  ?? "";
        smtpSecure      = smtp.smtpSecure    ?? false;
      } catch { /* ignorieren */ }

      try {
        const sec = await api.get<{ twoFaEnabled: boolean }>("/settings/security");
        twoFaEnabled = sec.twoFaEnabled;
      } catch { /* ignorieren */ }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  });

  async function saveFederalState() {
    if (!_gOtherFields) return;
    stateSaving = true; stateError = ""; stateSaved = false;
    try {
      await api.put("/settings/work", { ..._gOtherFields, federalState: gFederalState });
      stateSaved = true;
      setTimeout(() => (stateSaved = false), 3000);
    } catch (e: unknown) {
      stateError = e instanceof Error ? e.message : "Fehler";
    } finally {
      stateSaving = false;
    }
  }

  async function saveSmtp() {
    smtpSaving = true; smtpError = ""; smtpSaved = false;
    try {
      const body: Record<string, unknown> = { smtpHost, smtpPort, smtpUser, smtpFromEmail, smtpFromName, smtpSecure };
      if (smtpPassword) body.smtpPassword = smtpPassword;
      await api.put("/settings/smtp", body);
      smtpPassword = "";
      smtpPasswordSet = true;
      smtpSaved = true;
      setTimeout(() => (smtpSaved = false), 3000);
    } catch (e: unknown) {
      smtpError = e instanceof Error ? e.message : "Fehler";
    } finally {
      smtpSaving = false;
    }
  }

  async function testSmtp() {
    smtpTesting = true; smtpTestResult = ""; smtpTestError = "";
    try {
      await api.post("/settings/smtp/test", { email: smtpTestEmail });
      smtpTestResult = "Testmail erfolgreich gesendet.";
    } catch (e: unknown) {
      smtpTestError = e instanceof Error ? e.message : "SMTP-Fehler";
    } finally {
      smtpTesting = false;
    }
  }

  async function toggleTwoFa() {
    twoFaSaving = true; twoFaError = "";
    try {
      await api.put("/settings/security", { twoFaEnabled: !twoFaEnabled });
      twoFaEnabled = !twoFaEnabled;
    } catch (e: unknown) {
      twoFaError = e instanceof Error ? e.message : "Fehler";
    } finally {
      twoFaSaving = false;
    }
  }
</script>

<svelte:head>
  <title>System – Clokr</title>
</svelte:head>

{#if loading}
  <div class="card card-body" style="height:220px;"></div>
{:else if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{:else}

  <!-- ── Erscheinungsbild ──────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2>Erscheinungsbild</h2>
    <p class="text-muted">Farbschema der Anwendung</p>
  </div>

  <div class="card card-body settings-card">
    <div class="form-group" style="max-width:320px;">
      <label class="form-label" for="theme-select">Theme</label>
      <select id="theme-select" class="form-input" value={$theme} onchange={(e) => theme.set(e.currentTarget.value as typeof $theme)}>
        {#each themes as t}
          <option value={t.id}>{t.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- ── Bundesland ────────────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2>Feiertage</h2>
    <p class="text-muted">Bundesland für gesetzliche Feiertage</p>
  </div>

  <div class="card card-body settings-card">
    {#if stateError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem;"><span>⚠</span><span>{stateError}</span></div>
    {/if}
    <div class="form-group" style="max-width:320px;">
      <label class="form-label" for="g-federal-state">Bundesland</label>
      <select id="g-federal-state" bind:value={gFederalState} class="form-input federal-state-select">
        {#each STATES as s}
          <option value={s.prisma}>{s.label}</option>
        {/each}
      </select>
      <p class="form-hint text-muted">Bestimmt welche gesetzlichen Feiertage gelten.</p>
    </div>
    <div class="settings-actions">
      <button class="btn btn-primary" onclick={saveFederalState} disabled={stateSaving}>
        {stateSaving ? "Speichern…" : "Speichern"}
      </button>
      {#if stateSaved}
        <span class="saved-hint">✓ Gespeichert</span>
      {/if}
    </div>
  </div>

  <!-- ── E-Mail / SMTP ─────────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2>E-Mail / SMTP</h2>
    <p class="text-muted">Für Einladungsmails und 2FA-Codes</p>
  </div>

  <div class="card card-body settings-card">
    {#if smtpError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem;"><span>⚠</span><span>{smtpError}</span></div>
    {/if}
    {#if smtpSaved}
      <div class="alert alert-success" role="alert" style="margin-bottom:1rem;"><span>✓</span><span>SMTP-Einstellungen gespeichert.</span></div>
    {/if}

    <div class="smtp-grid">
      <div class="form-group">
        <label class="form-label" for="smtp-host">SMTP-Host</label>
        <input id="smtp-host" type="text" bind:value={smtpHost} class="form-input" placeholder="smtp.example.com" />
      </div>
      <div class="form-group">
        <label class="form-label" for="smtp-port">Port</label>
        <input id="smtp-port" type="number" bind:value={smtpPort} class="form-input" placeholder="587" min="1" max="65535" />
      </div>
      <div class="form-group">
        <label class="form-label" for="smtp-user">Benutzername</label>
        <input id="smtp-user" type="text" bind:value={smtpUser} class="form-input" placeholder="user@example.com" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label" for="smtp-pass">
          Passwort
          {#if smtpPasswordSet}<span class="badge-saved">gespeichert</span>{/if}
        </label>
        <input id="smtp-pass" type="password" bind:value={smtpPassword} class="form-input" placeholder="Unverändert lassen" autocomplete="new-password" />
      </div>
      <div class="form-group">
        <label class="form-label" for="smtp-from-email">Von E-Mail</label>
        <input id="smtp-from-email" type="email" bind:value={smtpFromEmail} class="form-input" placeholder="noreply@salon.de" />
      </div>
      <div class="form-group">
        <label class="form-label" for="smtp-from-name">Von Name</label>
        <input id="smtp-from-name" type="text" bind:value={smtpFromName} class="form-input" placeholder="Clokr" />
      </div>
      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={smtpSecure} class="toggle-cb" />
          <span>TLS/SSL (Port 465)</span>
        </label>
      </div>
    </div>

    <div class="settings-actions">
      <button class="btn btn-primary" onclick={saveSmtp} disabled={smtpSaving}>
        {smtpSaving ? "Speichern…" : "SMTP speichern"}
      </button>
    </div>

    <hr class="section-divider" />

    <h3 class="modal-section-heading">Testmail senden</h3>
    <div class="smtp-test-row">
      <input type="email" bind:value={smtpTestEmail} class="form-input" placeholder="test@example.com" style="max-width:280px;" />
      <button class="btn btn-ghost" onclick={testSmtp} disabled={smtpTesting || !smtpTestEmail}>
        {smtpTesting ? "Senden…" : "Testmail senden"}
      </button>
    </div>
    {#if smtpTestResult}
      <p class="text-success" style="margin-top:0.5rem;font-size:0.875rem;">✓ {smtpTestResult}</p>
    {/if}
    {#if smtpTestError}
      <p class="text-danger" style="margin-top:0.5rem;font-size:0.875rem;">⚠ {smtpTestError}</p>
    {/if}
  </div>

  <!-- ── Sicherheit / 2FA ──────────────────────────────────────────────────── -->
  <div class="section-label">
    <h2>Sicherheit</h2>
    <p class="text-muted">Zwei-Faktor-Authentifizierung für alle Benutzer</p>
  </div>

  <div class="card card-body settings-card">
    {#if twoFaError}
      <div class="alert alert-error" role="alert" style="margin-bottom:1rem;"><span>⚠</span><span>{twoFaError}</span></div>
    {/if}
    <label class="toggle-label">
      <input type="checkbox" checked={twoFaEnabled} onchange={toggleTwoFa} disabled={twoFaSaving} class="toggle-cb" />
      <span>
        <strong>2-Faktor-Authentifizierung (E-Mail OTP)</strong><br>
        <span class="text-muted" style="font-size:0.875rem;">Nach dem Login wird ein 6-stelliger Code per E-Mail gesendet. Gilt für alle Benutzer.</span>
      </span>
    </label>
  </div>

{/if}

<style>
  .settings-card { margin-bottom: 2rem; }

  .section-label   { margin: 2rem 0 0.875rem; }
  .section-label h2 { font-size: 1rem; font-weight: 600; }
  .section-label p  { font-size: 0.875rem; margin-top: 0.125rem; }

  .form-hint { font-size: 0.8125rem; margin-top: 0.25rem; }

  .smtp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .form-group--full { grid-column: 1 / -1; }

  .settings-actions { display: flex; gap: 0.75rem; margin-top: 0.5rem; align-items: center; }

  .section-divider { border: none; border-top: 1px solid var(--color-border); margin: 1.5rem 0; }

  .smtp-test-row { display: flex; gap: 0.75rem; align-items: center; margin-top: 0.75rem; flex-wrap: wrap; }

  .badge-saved {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    background: #dcfce7;
    color: #166534;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-left: 0.5rem;
    vertical-align: middle;
  }

  .text-success { color: #166534; }
  .text-danger  { color: #991b1b; }

  .alert-success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
    margin-top: 0.375rem;
  }

  .toggle-cb {
    width: 16px;
    height: 16px;
    accent-color: var(--color-brand);
  }

  .saved-hint { color: var(--color-green, #16a34a); font-weight: 500; font-size: 0.9375rem; }

  .federal-state-select { min-width: 220px; }

  .modal-section-heading {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.5rem;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }
  .alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
</style>
