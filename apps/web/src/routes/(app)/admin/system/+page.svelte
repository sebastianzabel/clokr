<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";

  // ── Tabs (Phase 58: tabbed config layout) ──────────────────────────────────
  const TABS = [
    { id: "allgemein", label: "Allgemein" },
    { id: "sicherheit", label: "Sicherheit" },
  ];
  let activeTab = $state<string>("allgemein");

  interface TenantConfig {
    tenantName?: string;
    federalState: string;
    timezone: string;
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

  interface SecurityConfig {
    twoFaEnabled: boolean;
    passwordMinLength: number;
    passwordRequireUpper: boolean;
    passwordRequireLower: boolean;
    passwordRequireDigit: boolean;
    passwordRequireSpecial: boolean;
    // Optional extended fields
    sessionTimeoutMinutes?: number;
    refreshTokenDays?: number;
    rememberMeEnabled?: boolean;
    rememberMeDays?: number;
    maxSessionsPerUser?: number;
    loginMaxAttempts?: number;
    loginLockoutMinutes?: number;
  }

  const STATES: { prisma: string; label: string }[] = [
    { prisma: "NIEDERSACHSEN", label: "Niedersachsen" },
    { prisma: "BADEN_WUERTTEMBERG", label: "Baden-Württemberg" },
    { prisma: "BAYERN", label: "Bayern" },
    { prisma: "BERLIN", label: "Berlin" },
    { prisma: "BRANDENBURG", label: "Brandenburg" },
    { prisma: "BREMEN", label: "Bremen" },
    { prisma: "HAMBURG", label: "Hamburg" },
    { prisma: "HESSEN", label: "Hessen" },
    { prisma: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
    { prisma: "NORDRHEIN_WESTFALEN", label: "Nordrhein-Westfalen" },
    { prisma: "RHEINLAND_PFALZ", label: "Rheinland-Pfalz" },
    { prisma: "SCHLESWIG_HOLSTEIN", label: "Schleswig-Holstein" },
    { prisma: "SAARLAND", label: "Saarland" },
    { prisma: "SACHSEN", label: "Sachsen" },
    { prisma: "SACHSEN_ANHALT", label: "Sachsen-Anhalt" },
    { prisma: "THUERINGEN", label: "Thüringen" },
  ];

  let loading = $state(true);
  let error = $state("");

  // Federal state + tenant name
  let gFederalState = $state("NIEDERSACHSEN");
  let gTenantName = $state("");
  // Issue #878: a section saves only the fields it edits. This flag only says that the settings
  // were loaded; it carries no copy of them, because sending a copy read at load time overwrote
  // changes saved in the meantime (another tab, another person) with the old values (N-09).
  let settingsLoaded = false;
  let stateSaving = $state(false);
  let stateSaved = $state(false);
  let stateError = $state("");

  // DATEV Lohnartennummern moved to /admin/export (Phase 58) — TenantConfig fields
  // datevNormalstundenNr / datevUrlaubNr / datevKrankNr / datevSonderurlaubNr live there.

  // The shift check mode against the opening hours moved to Regeln › Dienstplan › Einstellungen
  // (Issue #854, plan 854-10).

  // Timezone
  let gTimezone = $state("Europe/Berlin");
  const TIMEZONE_OPTIONS = [
    "Europe/Berlin",
    "Europe/Vienna",
    "Europe/Zurich",
    "Europe/Amsterdam",
    "Europe/Brussels",
    "Europe/Luxembourg",
    "Europe/Paris",
    "Europe/London",
    "Europe/Warsaw",
    "Europe/Prague",
    "Europe/Rome",
    "Europe/Madrid",
    "Europe/Stockholm",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Athens",
    "Europe/Istanbul",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "UTC",
  ];

  // 2FA
  let twoFaEnabled = $state(false);
  let twoFaSaving = $state(false);
  let twoFaError = $state("");

  // Session-Management
  let sessionTimeoutMinutes = $state(60);
  let refreshTokenDays = $state(7);
  let rememberMeEnabled = $state(true);
  let rememberMeDays = $state(30);
  let maxSessionsPerUser = $state(0);
  let loginMaxAttempts = $state(5);
  let loginLockoutMinutes = $state(15);
  let sessionSaving = $state(false);
  let sessionSaved = $state(false);
  let sessionError = $state("");

  // Password policy (BSI)
  let pwMinLength = $state(12);
  let pwRequireUpper = $state(true);
  let pwRequireLower = $state(true);
  let pwRequireDigit = $state(true);
  let pwRequireSpecial = $state(true);
  let pwSaving = $state(false);
  let pwSaved = $state(false);
  let pwError = $state("");

  // ── Unsaved-section tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ──────────────
  // One snapshot per button-gated group, taken at load and re-taken after each successful save.
  // Snapshot comparison rather than per-field oninput flags: it is three lines per section instead
  // of one per input, and undoing an edit by hand clears the marker again, which a per-field flag
  // cannot do. Instant-save controls are deliberately NOT in any snapshot — they are never "unsaved".
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let companySnapshot = $state("");
  let companyDirty = $derived(snap(gTenantName, gFederalState, gTimezone) !== companySnapshot);

  let sessionSnapshot = $state("");
  let sessionDirty = $derived(
    snap(
      sessionTimeoutMinutes,
      refreshTokenDays,
      rememberMeEnabled,
      rememberMeDays,
      maxSessionsPerUser,
      loginMaxAttempts,
      loginLockoutMinutes,
    ) !== sessionSnapshot,
  );

  let pwSnapshot = $state("");
  let pwDirty = $derived(
    snap(pwMinLength, pwRequireUpper, pwRequireLower, pwRequireDigit, pwRequireSpecial) !==
      pwSnapshot,
  );

  // Phase 109 (D-12) — one registry entry per PAGE, not per section: the guard only needs to know
  // whether anything is unsaved. The cleanup de-registers on unmount so a saved-and-left page cannot
  // leave a stale entry behind.
  let anyUnsaved = $derived(companyDirty || sessionDirty || pwDirty);

  // Gate the registration on "the baseline has been taken" (WR-01). Every snapshot starts as ""
  // and only gets its real value at the end of onMount's try, so every *Dirty flag reads true
  // until then. Registering that would arm the navigation guard on a page that has no form yet —
  // permanently so if the load throws, since the snapshot block is then never reached and the
  // page renders nothing but an error banner (no visible marker to explain the dialog).
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-system", snapshotsReady && anyUnsaved);
    return () => markUnsaved("admin-system", false);
  });

  onMount(async () => {
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gFederalState = cfg.federalState ?? "NIEDERSACHSEN";
      gTenantName = cfg.tenantName ?? "";
      gTimezone = cfg.timezone ?? "Europe/Berlin";
      settingsLoaded = true;

      try {
        const sec = await api.get<SecurityConfig>("/settings/security");
        twoFaEnabled = sec.twoFaEnabled;
        pwMinLength = sec.passwordMinLength;
        pwRequireUpper = sec.passwordRequireUpper;
        pwRequireLower = sec.passwordRequireLower;
        pwRequireDigit = sec.passwordRequireDigit;
        pwRequireSpecial = sec.passwordRequireSpecial;
        sessionTimeoutMinutes = sec.sessionTimeoutMinutes ?? 60;
        refreshTokenDays = sec.refreshTokenDays ?? 7;
        rememberMeEnabled = sec.rememberMeEnabled ?? true;
        rememberMeDays = sec.rememberMeDays ?? 30;
        maxSessionsPerUser = sec.maxSessionsPerUser ?? 0;
        loginMaxAttempts = sec.loginMaxAttempts ?? 5;
        loginLockoutMinutes = sec.loginLockoutMinutes ?? 15;
      } catch {
        /* ignorieren */
      }

      // Phase 109 — baseline for the unsaved markers. Must run after ALL state above is hydrated.
      companySnapshot = snap(gTenantName, gFederalState, gTimezone);
      sessionSnapshot = snap(
        sessionTimeoutMinutes,
        refreshTokenDays,
        rememberMeEnabled,
        rememberMeDays,
        maxSessionsPerUser,
        loginMaxAttempts,
        loginLockoutMinutes,
      );
      pwSnapshot = snap(
        pwMinLength,
        pwRequireUpper,
        pwRequireLower,
        pwRequireDigit,
        pwRequireSpecial,
      );
      snapshotsReady = true;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  });

  async function saveFederalState() {
    if (!settingsLoaded) return;
    stateSaving = true;
    stateError = "";
    stateSaved = false;
    try {
      await api.put("/settings/work", {
        tenantName: gTenantName,
        federalState: gFederalState,
        timezone: gTimezone,
      });
      stateSaved = true;
      companySnapshot = snap(gTenantName, gFederalState, gTimezone); // Phase 109 — section is clean again
      setTimeout(() => (stateSaved = false), 3000);
    } catch (e: unknown) {
      stateError = e instanceof Error ? e.message : "Fehler";
    } finally {
      stateSaving = false;
    }
  }

  // saveDatev moved to /admin/export (Phase 58).

  async function toggleTwoFa() {
    // bind:checked already applied the new value (WR-02: the toggle rolls back on a failed save). 2FA is the
    // most security-relevant toggle on the page; it must never claim a state the server rejected.
    const previous = !twoFaEnabled;
    twoFaSaving = true;
    twoFaError = "";
    try {
      await api.put("/settings/security", { twoFaEnabled });
      toasts.success("Einstellung gespeichert.");
    } catch (e: unknown) {
      twoFaEnabled = previous;
      twoFaError = e instanceof Error ? e.message : "Fehler";
    } finally {
      twoFaSaving = false;
    }
  }

  async function saveSessionConfig() {
    sessionSaving = true;
    sessionSaved = false;
    sessionError = "";
    try {
      await api.put("/settings/security", {
        sessionTimeoutMinutes,
        refreshTokenDays,
        rememberMeEnabled,
        rememberMeDays,
        maxSessionsPerUser,
        loginMaxAttempts,
        loginLockoutMinutes,
      });
      sessionSaved = true;
      sessionSnapshot = snap(
        // Phase 109 — section is clean again
        sessionTimeoutMinutes,
        refreshTokenDays,
        rememberMeEnabled,
        rememberMeDays,
        maxSessionsPerUser,
        loginMaxAttempts,
        loginLockoutMinutes,
      );
      setTimeout(() => (sessionSaved = false), 3000);
    } catch (e: unknown) {
      sessionError = e instanceof Error ? e.message : "Fehler";
    } finally {
      sessionSaving = false;
    }
  }

  async function savePasswordPolicy() {
    pwSaving = true;
    pwSaved = false;
    pwError = "";
    try {
      await api.put("/settings/security", {
        passwordMinLength: pwMinLength,
        passwordRequireUpper: pwRequireUpper,
        passwordRequireLower: pwRequireLower,
        passwordRequireDigit: pwRequireDigit,
        passwordRequireSpecial: pwRequireSpecial,
      });
      pwSaved = true;
      pwSnapshot = snap(
        pwMinLength,
        pwRequireUpper,
        pwRequireLower,
        pwRequireDigit,
        pwRequireSpecial,
      ); // Phase 109 — clean again
      setTimeout(() => (pwSaved = false), 3000);
    } catch (e: unknown) {
      pwError = e instanceof Error ? e.message : "Fehler";
    } finally {
      pwSaving = false;
    }
  }

  // WR-03: `el` removes this handler's dependency on Svelte flushing between the optimistic write
  // and the revert. The markup binds one-way (`checked={…}`), so the only thing that puts the DOM
  // checkbox back is a state transition Svelte actually observes — and `set_checked` early-returns
  // when the new value equals the LAST APPLIED one without ever reading `element.checked`. If both
  // writes land in one batch (a pre-flight throw, a cached response, a sync guard before the
  // await), Svelte sees `previous → previous`, applies nothing, and the browser's own flip stays on
  // screen. Writing `el.checked` directly is the one line that cannot be defeated that way.
</script>

<!-- Phase 73-05 (D-05): data-testid surface for admin-system flows.
     `display: contents` keeps SectionStack's layout intact while giving E2E
     specs a stable page-root selector + the active tab as data-attribute. -->
<div data-testid="admin-system-page" data-active-tab={activeTab} style="display: contents;">
  <SectionStack
    eyebrow="Verwalten"
    title={pageLabel("/admin/system")}
    sub="Einstellungen des Unternehmens, Sicherheit und Benachrichtigungen"
    tabs={TABS}
    bind:activeTab
    animate
  >
    {#snippet tabContent(currentTab)}
      {#if loading}
        <div class="sys-loading-placeholder"></div>
      {:else if error}
        <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
      {:else if currentTab === "allgemein"}
        <!-- ── Erscheinungsbild ─────────────────────────────────────────────── -->
        <Section title="Erscheinungsbild" sub={pageLabel("/admin/themes")}>
          <p class="sys-note">
            Theme und Hell/Dunkel wählt jede Person selbst auf der Seite
            <a href="/admin/themes">{pageLabel("/admin/themes")}</a>.
          </p>
        </Section>

        <!-- ── Unternehmen & Region ─────────────────────────────────────────── -->
        <Section
          title="Unternehmen & Region"
          sub="Firmenname, Bundesland & Zeitzone"
          dirty={companyDirty}
        >
          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveFederalState}
              disabled={stateSaving}
              data-testid="admin-system-region-save"
            >
              {#if stateSaving}<Spinner />{/if}
              Speichern
            </button>
            {#if stateSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
          {#if stateError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{stateError}</span>
            </div>
          {/if}
          <div class="form-group" style="margin-bottom: 1rem;">
            <label class="form-label" for="g-tenant-name">Firmenname</label>
            <input
              id="g-tenant-name"
              type="text"
              bind:value={gTenantName}
              class="form-input"
              placeholder="Name des Unternehmens"
              data-testid="admin-system-region-tenantName"
            />
            <p class="form-hint text-muted">Wird in PDF-Exporten als Überschrift verwendet.</p>
          </div>
          <div class="inline-fields">
            <div class="form-group">
              <label class="form-label" for="g-federal-state">Bundesland</label>
              <select
                id="g-federal-state"
                bind:value={gFederalState}
                class="form-input federal-state-select"
                data-testid="admin-system-region-federalState"
              >
                {#each STATES as s (s.prisma)}
                  <option value={s.prisma}>{s.label}</option>
                {/each}
              </select>
              <p class="form-hint text-muted">
                Vorgabe für neu angelegte Salons. Feiertage richten sich nach dem Bundesland des
                jeweiligen Salons (Admin → Salons).
              </p>
            </div>
            <div class="form-group">
              <label class="form-label" for="g-timezone">Zeitzone</label>
              <select id="g-timezone" bind:value={gTimezone} class="form-input">
                {#each TIMEZONE_OPTIONS as tz (tz)}
                  <option value={tz}>{tz}</option>
                {/each}
              </select>
              <p class="form-hint text-muted">Zuordnung von Zeitstempeln zu Tagen.</p>
            </div>
          </div>
        </Section>
      {:else if currentTab === "sicherheit"}
        <!-- ── Sicherheit / 2FA ─────────────────────────────────────────────── -->
        <Section title="Sicherheit" sub="Zwei-Faktor-Authentifizierung">
          {#if twoFaError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{twoFaError}</span>
            </div>
          {/if}
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">2-Faktor-Authentifizierung (E-Mail OTP)</span>
              <p class="form-hint text-muted">
                Nach dem Login wird ein 6-stelliger Code per E-Mail gesendet.
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="2-Faktor-Authentifizierung aktivieren"
                bind:checked={twoFaEnabled}
                onchange={toggleTwoFa}
                disabled={twoFaSaving}
                data-testid="admin-system-sicherheit-twoFaEnabled"
              />
              <span class="switch-slider"></span>
            </label>
          </div>
        </Section>

        <!-- ── Session-Management ───────────────────────────────────────────── -->
        <Section title="Session-Management" sub="Timeouts & Sperrzeiten" dirty={sessionDirty}>
          {#if sessionError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{sessionError}</span>
            </div>
          {/if}

          <div class="opt-stack">
            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="session-timeout">Inaktivitäts-Timeout</label>
                <p class="opt-hint">0 = deaktiviert. Benutzer wird nach Inaktivität ausgeloggt.</p>
              </div>
              <div class="opt-control">
                <input
                  id="session-timeout"
                  type="number"
                  min="0"
                  max="480"
                  bind:value={sessionTimeoutMinutes}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Min.</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="refresh-days">Session-Dauer</label>
                <p class="opt-hint">Wie lange ein Login ohne „Angemeldet bleiben" gültig ist.</p>
              </div>
              <div class="opt-control">
                <input
                  id="refresh-days"
                  type="number"
                  min="1"
                  max="90"
                  bind:value={refreshTokenDays}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Tage</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">„Angemeldet bleiben" erlauben</span>
                <p class="opt-hint">
                  Benutzer können beim Login angemeldet bleiben über mehrere Sitzungen hinweg.
                </p>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="„Angemeldet bleiben&quot; erlauben"
                  bind:checked={rememberMeEnabled}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            {#if rememberMeEnabled}
              <div class="opt-row opt-row--nested">
                <div class="opt-info">
                  <label class="opt-label" for="remember-days">„Angemeldet bleiben" Dauer</label>
                  <p class="opt-hint">Maximale Geltungsdauer der „Angemeldet bleiben"-Sitzung.</p>
                </div>
                <div class="opt-control">
                  <input
                    id="remember-days"
                    type="number"
                    min="1"
                    max="365"
                    bind:value={rememberMeDays}
                    class="form-input opt-input-num"
                  />
                  <span class="opt-unit">Tage</span>
                </div>
              </div>
            {/if}

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="max-sessions">Max. gleichzeitige Sessions</label>
                <p class="opt-hint">
                  0 = unbegrenzt. Älteste Session wird bei Überschreitung beendet.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="max-sessions"
                  type="number"
                  min="0"
                  max="20"
                  bind:value={maxSessionsPerUser}
                  class="form-input opt-input-num"
                />
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="login-max-attempts"
                  >Max. Fehlversuche bis Sperre</label
                >
                <p class="opt-hint">
                  Anzahl falscher Login-Versuche bis das Konto temporär gesperrt wird.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="login-max-attempts"
                  type="number"
                  min="1"
                  max="20"
                  bind:value={loginMaxAttempts}
                  class="form-input opt-input-num"
                />
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="login-lockout-min">Sperrzeit nach Fehlversuchen</label
                >
                <p class="opt-hint">
                  Nach Ablauf wird der Zähler zurückgesetzt. Admin kann manuell entsperren.
                </p>
              </div>
              <div class="opt-control">
                <input
                  id="login-lockout-min"
                  type="number"
                  min="1"
                  max="1440"
                  bind:value={loginLockoutMinutes}
                  class="form-input opt-input-num"
                />
                <span class="opt-unit">Min.</span>
              </div>
            </div>
          </div>

          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={saveSessionConfig}
              disabled={sessionSaving}
              data-testid="admin-system-session-save"
            >
              {sessionSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if sessionSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
        </Section>

        <!-- ── Passwort-Richtlinie ──────────────────────────────────────────── -->
        <Section title="Passwort-Richtlinie" sub="BSI-konforme Komplexitätsregeln" dirty={pwDirty}>
          {#if pwError}
            <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
              <span>⚠</span><span>{pwError}</span>
            </div>
          {/if}

          <div class="opt-stack">
            <div class="opt-row">
              <div class="opt-info">
                <label class="opt-label" for="pw-min-length">Mindestlänge</label>
                <p class="opt-hint">BSI empfiehlt mindestens 12 Zeichen.</p>
              </div>
              <div class="opt-control">
                <input
                  id="pw-min-length"
                  type="number"
                  min="8"
                  max="128"
                  bind:value={pwMinLength}
                  class="form-input opt-input-num"
                  data-testid="admin-system-password-minLength"
                />
                <span class="opt-unit">Zeichen</span>
              </div>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Großbuchstabe erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Großbuchstabe erforderlich"
                  bind:checked={pwRequireUpper}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Kleinbuchstabe erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Kleinbuchstabe erforderlich"
                  bind:checked={pwRequireLower}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Ziffer erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Ziffer erforderlich"
                  bind:checked={pwRequireDigit}
                />
                <span class="switch-slider"></span>
              </label>
            </div>

            <div class="opt-row">
              <div class="opt-info">
                <span class="opt-label">Sonderzeichen erforderlich</span>
              </div>
              <label class="switch opt-control-switch">
                <input
                  type="checkbox"
                  aria-label="Sonderzeichen erforderlich"
                  bind:checked={pwRequireSpecial}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
          </div>

          {#snippet footer()}
            <button
              class="btn btn-primary"
              onclick={savePasswordPolicy}
              disabled={pwSaving}
              data-testid="admin-system-password-save"
            >
              {pwSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if pwSaved}
              <span class="saved-hint">✓ Gespeichert</span>
            {/if}
          {/snippet}
        </Section>
      {/if}
    {/snippet}
  </SectionStack>
</div>

<style>
  /* Loading placeholder while settings are fetching */
  .sys-loading-placeholder {
    height: 220px;
  }

  .settings-actions--end {
    justify-content: flex-end;
  }

  .sys-note {
    font-size: 0.875rem;
    color: var(--text-2);
    line-height: 1.55;
    margin: 0;
  }
  .sys-note a {
    color: var(--brand);
    text-decoration: underline;
  }
  .sys-note a:hover {
    color: var(--brand-hover);
  }

  .inline-fields {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .inline-fields .form-group {
    min-width: 200px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }
  .toggle-info {
    flex: 1;
  }
  .toggle-row-label {
    font-size: 1rem;
    font-weight: 500;
    color: var(--text);
  }

  .switch {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 26px;
    flex-shrink: 0;
  }
  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: var(--line);
    border-radius: 26px;
    transition: background-color 0.2s;
  }
  .switch-slider::before {
    content: "";
    position: absolute;
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: var(--card);
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: var(--shadow);
  }
  .switch input:checked + .switch-slider {
    background-color: var(--brand);
  }
  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }

  .form-hint {
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }

  .saved-hint {
    color: var(--ok);
    font-weight: 500;
    font-size: 0.9375rem;
  }

  .federal-state-select {
    min-width: 220px;
  }

  /* ── Option stack — one option per row, label/hint left, control right.
     Used by Sicherheit / Session-Management / Passwort-Richtlinie to avoid
     the chaotic mix of 2-column form-grids and stacked toggle-rows. ───── */
  .opt-stack {
    display: flex;
    flex-direction: column;
  }
  .opt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--line);
  }
  .opt-row:last-child {
    border-bottom: none;
  }
  .opt-row--nested {
    padding-left: 1.25rem;
    border-left: 2px solid var(--brand-soft);
    margin-left: 0.25rem;
  }
  .opt-info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .opt-label {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.4;
  }
  .opt-hint {
    font-size: 0.8125rem;
    color: var(--text-2);
    margin: 0;
  }
  .opt-control {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .opt-control-switch {
    flex-shrink: 0;
  }
  .opt-input-num {
    width: 96px;
    text-align: right;
  }
  .opt-unit {
    font-size: 0.8125rem;
    color: var(--text-2);
    min-width: 36px;
  }

  @media (max-width: 640px) {
    .opt-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
    .opt-control {
      justify-content: flex-end;
    }
  }

  @media (max-width: 640px) {
    .inline-fields {
      flex-direction: column;
      gap: 1rem;
    }
  }
</style>
