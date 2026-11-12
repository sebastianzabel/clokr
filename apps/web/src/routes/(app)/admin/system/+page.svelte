<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, moduleBooked, showSalonOptions } from "$stores/salon-context";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import TerminalSalonCell from "$lib/components/admin/TerminalSalonCell.svelte";
  import { saveTerminalSalon } from "$lib/admin/terminal-salon-save";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import { tenantFeatures } from "$stores/tenant-features";
  import { markUnsaved } from "$stores/unsaved";

  // ── Tabs (Phase 58: tabbed config layout) ──────────────────────────────────
  const TABS = [
    { id: "allgemein", label: "Allgemein" },
    { id: "sicherheit", label: "Sicherheit" },
    { id: "integration", label: "Integration" },
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
    // Phase 47.3 / 49.4 — Verfügbarkeits-System Feature-Toggle
    availabilityEnabled?: boolean;
    // Check mode of shifts against the opening hours of their salon (the hours live on the salon)
    shiftStoreHoursMode?: "STRICT" | "DAY_ONLY" | "OFF";
    // Phase 67.2 — Auto-Cleanup für Berufsschultag-Schichten (Plan 04 backend hook,
    // Plan 05 surfaces toggle here). Wenn true (Default): künftige Shifts auf neuen
    // BS-Tagen werden vom Generator weich-gelöscht; in der Vergangenheit nur markiert.
    vocationalSchoolAutoCleanupShifts?: boolean;
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

  // ── Shift check mode against opening hours (a tenant policy; the hours live on the salon, #563) ──
  let shiftStoreHoursMode: "STRICT" | "DAY_ONLY" | "OFF" = $state("DAY_ONLY");
  let shiftHoursModeSaving = $state(false);
  let shiftHoursModeMsg = $state("");

  // Minimal payload on purpose: only the changed field (Issue #878, N-09 — every section of this
  // page does the same).
  async function saveShiftHoursMode() {
    shiftHoursModeSaving = true;
    shiftHoursModeMsg = "";
    try {
      await api.put("/settings/work", { shiftStoreHoursMode });
      shiftHoursModeMsg = "Gespeichert.";
      shiftHoursModeSnapshot = snap(shiftStoreHoursMode); // Phase 109 — section is clean again
      toasts.success("Prüfmodus gespeichert.");
    } catch (e: unknown) {
      shiftHoursModeMsg = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
      toasts.error(shiftHoursModeMsg);
    } finally {
      shiftHoursModeSaving = false;
      setTimeout(() => (shiftHoursModeMsg = ""), 2500);
    }
  }

  // Phase 47.3 / 49.4 — Verfügbarkeits-System Feature-Toggle
  let availabilityEnabled = $state(true);
  let availabilitySaving = $state(false);

  // Phase 67.2 (Plan 05) — Auto-Cleanup für Berufsschultag-Schichten Toggle
  let vocationalSchoolAutoCleanupShifts = $state(true);
  let vsAutoCleanupSaving = $state(false);

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

  // NFC Terminals
  interface TerminalKey {
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    // Issue #541: the salon the terminal is bound to (null = salon from the weekly pattern)
    salonId: string | null;
    salonName: string | null;
    salonActive: boolean | null;
  }

  let terminalKeys: TerminalKey[] = $state([]);
  let tkPage = $state(1);
  let tkPageSize = $state(10);
  let pagedTerminalKeys = $derived(
    terminalKeys.slice((tkPage - 1) * tkPageSize, tkPage * tkPageSize),
  );
  let terminalLoading = $state(false);
  let newKeyName = $state("");
  let newKeySalonId = $state("");
  let newKeyRaw = $state(""); // shown once after creation
  let showNewKey = $state(false);

  // API Keys
  interface ApiKeyEntry {
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }
  let apiKeys: ApiKeyEntry[] = $state([]);
  let akPage = $state(1);
  let akPageSize = $state(10);
  let pagedApiKeys = $derived(apiKeys.slice((akPage - 1) * akPageSize, akPage * akPageSize));
  let newApiKeyName = $state("");
  let newApiKeyScopes = $state<string[]>(["read:employees", "read:time-entries"]);
  let newApiKeyRaw = $state("");
  let showNewApiKey = $state(false);
  let apiKeyLoading = $state(false);

  const API_SCOPES = [
    { scope: "read:employees", label: "Mitarbeiter lesen" },
    { scope: "read:time-entries", label: "Zeiteinträge lesen" },
    { scope: "write:time-entries", label: "Zeiteinträge schreiben" },
    { scope: "read:leave", label: "Abwesenheiten lesen" },
    { scope: "write:leave", label: "Abwesenheiten schreiben" },
    { scope: "read:reports", label: "Berichte lesen" },
    { scope: "read:overtime", label: "Überstunden lesen" },
    { scope: "admin", label: "Voller Zugriff" },
  ];

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

  let shiftHoursModeSnapshot = $state("");
  let shiftHoursModeDirty = $derived(snap(shiftStoreHoursMode) !== shiftHoursModeSnapshot);

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
  let anyUnsaved = $derived(companyDirty || shiftHoursModeDirty || sessionDirty || pwDirty);

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

  // Phase 566 (D-12): display only — the server answers 409 for an unbooked module either way.
  // `=== false` only: an unknown state never hides the create row.
  const hardwareBooked = $derived(moduleBooked($salonContext, "HARDWARE_CLOCK"));
  const integrationsBooked = $derived(moduleBooked($salonContext, "INTEGRATIONS"));

  // Issue #541 (D-08, D-11): the terminal salon choice follows the #64 rule (showSalonOptions is
  // its one place); the column also shows whenever a key is bound, so a binding stays visible
  // and removable.
  const salonOptionsShown = $derived(showSalonOptions($salonContext));
  const showTerminalSalonColumn = $derived(
    salonOptionsShown || terminalKeys.some((k) => k.salonId !== null),
  );

  onMount(async () => {
    // Forced, so a freshly booked module shows without waiting for the navigation throttle.
    void salonContext.load($authStore.user?.id ?? null, { force: true });
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gFederalState = cfg.federalState ?? "NIEDERSACHSEN";
      gTenantName = cfg.tenantName ?? "";
      gTimezone = cfg.timezone ?? "Europe/Berlin";
      settingsLoaded = true;
      // Phase 47.3 — Verfügbarkeits-System Feature-Toggle (default on)
      availabilityEnabled = cfg.availabilityEnabled ?? true;

      // Phase 67.2 (Plan 05) — load tenant-wide BS-Shift-Auto-Cleanup toggle
      vocationalSchoolAutoCleanupShifts = cfg.vocationalSchoolAutoCleanupShifts ?? true;
      shiftStoreHoursMode = cfg.shiftStoreHoursMode ?? "DAY_ONLY";

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

      try {
        const res = await api.get<{ keys: TerminalKey[] }>("/terminals");
        terminalKeys = res.keys;
      } catch (err) {
        console.error("Failed to load terminal keys:", err);
      }

      try {
        apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
      } catch {
        /* ignore */
      }

      // Phase 109 — baseline for the unsaved markers. Must run after ALL state above is hydrated.
      companySnapshot = snap(gTenantName, gFederalState, gTimezone);
      shiftHoursModeSnapshot = snap(shiftStoreHoursMode);
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

  // Phase 47.3 / 49.4 — Tenant Feature-Toggle: Verfügbarkeits-System
  async function saveAvailabilityEnabled() {
    // bind:checked has already written the new value into the state, so the DOM and the state agree and an
    // explicit revert actually lands (WR-02); the toggle must never outlive a failed save.
    const previous = !availabilityEnabled;
    if (!settingsLoaded) {
      availabilityEnabled = previous;
      toasts.error("Einstellungen sind noch nicht geladen.");
      return;
    }
    availabilitySaving = true;
    try {
      await api.put("/settings/work", {
        availabilityEnabled,
      });
      tenantFeatures.applyLocal(availabilityEnabled); // propagate to Sidebar + BottomTabBar
      toasts.success("Einstellung gespeichert.");
    } catch (e: unknown) {
      availabilityEnabled = previous;
      toasts.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
    } finally {
      availabilitySaving = false;
    }
  }

  // Phase 67.2 (Plan 05) — Tenant Feature-Toggle: BS-Shift-Auto-Cleanup.
  // Mirrors saveAvailabilityEnabled exactly; the backend reads
  // TenantConfig.vocationalSchoolAutoCleanupShifts in shift-cleanup.ts.
  async function saveVocationalSchoolAutoCleanupShifts() {
    // bind:checked already applied the new value — see saveAvailabilityEnabled (WR-02).
    const previous = !vocationalSchoolAutoCleanupShifts;
    if (!settingsLoaded) {
      vocationalSchoolAutoCleanupShifts = previous;
      toasts.error("Einstellungen sind noch nicht geladen.");
      return;
    }
    vsAutoCleanupSaving = true;
    try {
      await api.put("/settings/work", {
        vocationalSchoolAutoCleanupShifts,
      });
      toasts.success("Einstellung gespeichert.");
    } catch (e: unknown) {
      vocationalSchoolAutoCleanupShifts = previous;
      toasts.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
    } finally {
      vsAutoCleanupSaving = false;
    }
  }

  async function toggleTwoFa() {
    // bind:checked already applied the new value — see saveAvailabilityEnabled (WR-02). 2FA is the
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
  async function createApiKey() {
    if (!newApiKeyName.trim() || newApiKeyScopes.length === 0) return;
    apiKeyLoading = true;
    try {
      const res = await api.post<ApiKeyEntry & { rawKey: string }>("/api-keys", {
        name: newApiKeyName.trim(),
        scopes: newApiKeyScopes,
      });
      newApiKeyRaw = res.rawKey;
      showNewApiKey = true;
      newApiKeyName = "";
      apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "API-Schlüssel konnte nicht erstellt werden.");
    } finally {
      apiKeyLoading = false;
    }
  }

  async function revokeApiKey(id: string) {
    try {
      await api.delete(`/api-keys/${id}`);
      apiKeys = await api.get<ApiKeyEntry[]>("/api-keys");
    } catch (e: unknown) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "API-Schlüssel konnte nicht widerrufen werden. Versuche es noch einmal.",
      );
    }
  }

  function toggleScope(scope: string) {
    if (newApiKeyScopes.includes(scope)) {
      newApiKeyScopes = newApiKeyScopes.filter((s) => s !== scope);
    } else {
      newApiKeyScopes = [...newApiKeyScopes, scope];
    }
  }

  async function createTerminalKey() {
    if (!newKeyName.trim()) return;
    terminalLoading = true;
    try {
      const res = await api.post<{ rawKey: string }>("/terminals", {
        name: newKeyName.trim(),
        ...(newKeySalonId !== "" && { salonId: newKeySalonId }),
      });
      newKeyRaw = res.rawKey;
      showNewKey = true;
      newKeyName = "";
      newKeySalonId = "";
      // Refresh list
      const list = await api.get<{ keys: TerminalKey[] }>("/terminals");
      terminalKeys = list.keys;
    } catch (err) {
      console.error("Failed to create terminal key:", err);
      toasts.error(
        err instanceof ApiError ? err.message : "Terminal-Schlüssel konnte nicht erstellt werden.",
      );
    } finally {
      terminalLoading = false;
    }
  }

  // Issue #541 (D-03, D-08): instant save of the salon select. The optimistic update and the
  // revert-before-toast rollback live in `$lib/admin/terminal-salon-save` (unit-tested).
  function setTerminalSalon(id: string, salonId: string | null): Promise<boolean> {
    return saveTerminalSalon<TerminalKey>({
      id,
      salonId,
      getRows: () => terminalKeys,
      setRows: (rows) => (terminalKeys = rows),
      salons: $salonContext.salons,
      patch: (keyId, salon) => api.patch<TerminalKey>(`/terminals/${keyId}`, { salonId: salon }),
      onSaved: () => toasts.success("Salon-Bindung gespeichert."),
      onFailed: (err) => {
        console.error("Failed to set terminal salon:", err);
        toasts.error(
          err instanceof ApiError ? err.message : "Salon-Bindung konnte nicht gespeichert werden.",
        );
      },
    });
  }

  async function revokeTerminalKey(id: string) {
    try {
      await api.delete(`/terminals/${id}`);
      const list = await api.get<{ keys: TerminalKey[] }>("/terminals");
      terminalKeys = list.keys;
    } catch (err) {
      console.error("Failed to revoke terminal key:", err);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }
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

        <!-- ── Shift check mode against opening hours ────────────────────── -->
        <Section
          title="Schichtprüfung gegen Öffnungszeiten"
          sub="Wie streng Schichten an die Öffnungszeiten des jeweiligen Salons gebunden werden."
          dirty={shiftHoursModeDirty}
        >
          {#snippet footer()}
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onclick={saveShiftHoursMode}
              disabled={shiftHoursModeSaving}
            >
              {shiftHoursModeSaving ? "Speichern …" : "Prüfmodus speichern"}
            </button>
            {#if shiftHoursModeMsg}
              <span class="cfg-muted cfg-msg">{shiftHoursModeMsg}</span>
            {/if}
          {/snippet}

          <p class="form-hint">
            Die Öffnungszeiten selbst pflegst du je Salon unter Administration › Salons.
          </p>

          <div class="cfg-section-title">Schicht-Zeiten an Öffnungszeiten binden</div>
          <div class="cfg-mode-options">
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="DAY_ONLY"
                checked={shiftStoreHoursMode === "DAY_ONLY"}
                onchange={() => (shiftStoreHoursMode = "DAY_ONLY")}
              />
              <span>
                <strong>Nur geschlossene Tage blockieren</strong> (Standard) — Schichten dürfen vor Öffnung
                beginnen / nach Schließung enden (Vor- &amp; Nachbereitung). An geschlossenen Tagen ist
                keine Schicht möglich.
              </span>
            </label>
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="STRICT"
                checked={shiftStoreHoursMode === "STRICT"}
                onchange={() => (shiftStoreHoursMode = "STRICT")}
              />
              <span>
                <strong>Strikt</strong> — Schichten müssen vollständig in den Öffnungszeiten liegen.
              </span>
            </label>
            <label class="cfg-mode-option">
              <input
                type="radio"
                name="shiftStoreHoursMode"
                value="OFF"
                checked={shiftStoreHoursMode === "OFF"}
                onchange={() => (shiftStoreHoursMode = "OFF")}
              />
              <span>
                <strong>Deaktiviert</strong> — keine Bindung an Öffnungszeiten.
              </span>
            </label>
          </div>
        </Section>

        <!-- ── Features (Phase 47.3 / 49.4) ─────────────────────────────────── -->
        <Section title="Features" sub="Funktionen für das ganze Unternehmen ein- und ausschalten">
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label">Verfügbarkeits-System aktiviert</span>
              <p class="form-hint text-muted">
                {#if availabilityEnabled}
                  Mitarbeiter pflegen ihre Verfügbarkeit selbst (Sidebar &amp; BottomTab zeigen
                  „Verfügbarkeit"). Auto-Generierung &amp; Woche-Kopieren respektieren „Nicht
                  verfügbar"; Manager können bei UNAVAILABLE per ConfirmDialog überschreiben (mit
                  Audit-Eintrag).
                {:else}
                  Deaktiviert. „Verfügbarkeit"-Navigation ist ausgeblendet, Resolver &amp; Auto-Gen
                  ignorieren EmployeeAvailability-Markierungen. Bereits angelegte
                  Verfügbarkeits-Daten bleiben in der DB erhalten.
                {/if}
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="Verfügbarkeits-System aktivieren"
                bind:checked={availabilityEnabled}
                onchange={saveAvailabilityEnabled}
                disabled={availabilitySaving}
              />
              <span class="switch-slider"></span>
            </label>
          </div>

          <!-- Phase 67.2 (Plan 05) — Tenant-weiter Toggle für BS-Shift-Auto-Cleanup.
             Default ON: Generator entfernt künftige Shifts auf neuen BS-Tagen automatisch
             (Vergangenheit wird nur markiert). OFF: Shifts werden ausschließlich als
             Konflikt markiert, kein Auto-Soft-Delete. -->
          <div class="toggle-row">
            <div class="toggle-info">
              <span class="toggle-row-label"
                >Schichten auf Berufsschultagen automatisch entfernen</span
              >
              <p class="form-hint text-muted">
                {#if vocationalSchoolAutoCleanupShifts}
                  Aktiv: Wenn der Generator neue Berufsschultage anlegt, werden zukünftige Schichten
                  auf diesen Tagen automatisch entfernt (Soft-Delete, wiederherstellbar unter <a
                    href="/shifts/conflicts">/shifts/conflicts</a
                  >). Schichten in der Vergangenheit werden nur als Konflikt markiert.
                {:else}
                  Deaktiviert: Schichten auf neuen Berufsschultagen werden ausschließlich als
                  Konflikt markiert. Manuelle Bereinigung erforderlich.
                {/if}
              </p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                aria-label="BS-Shift-Auto-Cleanup aktivieren"
                bind:checked={vocationalSchoolAutoCleanupShifts}
                onchange={saveVocationalSchoolAutoCleanupShifts}
                disabled={vsAutoCleanupSaving}
              />
              <span class="switch-slider"></span>
            </label>
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
      {:else if currentTab === "integration"}
        <!-- ── NFC-Terminals ────────────────────────────────────────────────── -->
        <Section title="NFC-Terminals" sub="API-Schlüssel für stationäre Geräte">
          {#if showNewKey}
            <div class="alert alert-success" style="margin-bottom: 1rem;">
              <div>
                <strong>Neuer Schlüssel erstellt!</strong>
                <p style="margin: 0.5rem 0;">
                  Kopier den Schlüssel jetzt — er wird nicht erneut angezeigt:
                </p>
                <div class="key-display">
                  <code class="key-code">{newKeyRaw}</code>
                  <button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(newKeyRaw)}
                    >Kopieren</button
                  >
                </div>
                <button
                  class="btn btn-ghost btn-sm"
                  style="margin-top: 0.5rem;"
                  onclick={() => {
                    showNewKey = false;
                    newKeyRaw = "";
                  }}>Schließen</button
                >
              </div>
            </div>
          {/if}

          {#if hardwareBooked === false}
            <ModuleHint module="HARDWARE_CLOCK" subject="NFC-Terminals" />
          {:else}
            <div class="inline-create">
              <input
                type="text"
                class="form-input"
                bind:value={newKeyName}
                placeholder="Terminal-Name (z.B. Kasse 1)"
              />
              {#if salonOptionsShown}
                <select
                  class="form-input"
                  bind:value={newKeySalonId}
                  aria-label="Salon des neuen Terminals"
                >
                  <option value="">Kein Salon – Salon aus dem Wochenmuster</option>
                  {#each $salonContext.salons as salon (salon.id)}
                    <option value={salon.id}>{salon.name}</option>
                  {/each}
                </select>
              {/if}
              <button
                class="btn btn-primary"
                onclick={createTerminalKey}
                disabled={terminalLoading || !newKeyName.trim()}
              >
                Schlüssel erstellen
              </button>
            </div>
          {/if}

          {#if terminalKeys.length > 0}
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {#if showTerminalSalonColumn}
                      <th>Salon</th>
                    {/if}
                    <th>Schlüssel</th>
                    <th>Zuletzt verwendet</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each pagedTerminalKeys as key (key.id)}
                    <tr class:row-revoked={key.revokedAt}>
                      <td>{key.name}</td>
                      {#if showTerminalSalonColumn}
                        <td>
                          <TerminalSalonCell
                            terminal={key}
                            salons={$salonContext.salons}
                            showOptions={salonOptionsShown}
                            onchange={(salonId) => setTerminalSalon(key.id, salonId)}
                          />
                        </td>
                      {/if}
                      <td><code class="inline-code">{key.keyPrefix}</code></td>
                      <td
                        >{key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleString("de-DE")
                          : "Nie"}</td
                      >
                      <td>
                        {#if key.revokedAt}
                          <span class="badge badge-red">Widerrufen</span>
                        {:else}
                          <span class="badge badge-green">Aktiv</span>
                        {/if}
                      </td>
                      <td>
                        {#if !key.revokedAt}
                          <button
                            class="btn btn-sm btn-ghost btn-danger-ghost"
                            onclick={() => revokeTerminalKey(key.id)}>Widerrufen</button
                          >
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <Pagination
                total={terminalKeys.length}
                bind:page={tkPage}
                bind:pageSize={tkPageSize}
              />
            </div>
          {:else}
            <p class="text-muted">Keine Terminal-Schlüssel vorhanden.</p>
          {/if}
        </Section>

        <!-- ── API Keys ─────────────────────────────────────────────────────── -->
        <Section title="API Keys" sub="Schlüssel für externe Integrationen">
          {#if showNewApiKey}
            <div class="alert alert-success" style="margin-bottom: 1rem;">
              <div>
                <strong>API Key erstellt!</strong>
                <p style="margin: 0.5rem 0;">
                  Kopier den Schlüssel jetzt — er wird nicht erneut angezeigt:
                </p>
                <div class="key-display">
                  <code class="key-code">{newApiKeyRaw}</code>
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => navigator.clipboard.writeText(newApiKeyRaw)}>Kopieren</button
                  >
                </div>
                <button
                  class="btn btn-ghost btn-sm"
                  style="margin-top: 0.5rem;"
                  onclick={() => {
                    showNewApiKey = false;
                    newApiKeyRaw = "";
                  }}>Schließen</button
                >
              </div>
            </div>
          {/if}

          {#if integrationsBooked === false}
            <ModuleHint module="INTEGRATIONS" subject="API-Schlüssel" />
          {:else}
            <div class="api-key-create">
              <div class="inline-create">
                <input
                  type="text"
                  class="form-input"
                  bind:value={newApiKeyName}
                  placeholder="Name (z.B. DATEV Export)"
                />
                <button
                  class="btn btn-primary"
                  onclick={createApiKey}
                  disabled={apiKeyLoading || !newApiKeyName.trim() || newApiKeyScopes.length === 0}
                >
                  Key erstellen
                </button>
              </div>
              <div class="scope-chips">
                {#each API_SCOPES as s (s.scope)}
                  <button
                    class="btn btn-sm"
                    class:btn-primary={newApiKeyScopes.includes(s.scope)}
                    class:btn-ghost={!newApiKeyScopes.includes(s.scope)}
                    onclick={() => toggleScope(s.scope)}>{s.label}</button
                  >
                {/each}
              </div>
            </div>
          {/if}

          {#if apiKeys.length > 0}
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr
                    ><th>Name</th><th>Prefix</th><th>Scopes</th><th>Letzter Zugriff</th><th
                    ></th></tr
                  >
                </thead>
                <tbody>
                  {#each pagedApiKeys as key (key.id)}
                    <tr class:row-revoked={!!key.revokedAt}>
                      <td>{key.name}</td>
                      <td><code class="inline-code">{key.keyPrefix}…</code></td>
                      <td class="scope-cell">{key.scopes.join(", ")}</td>
                      <td>
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleDateString("de-DE")
                          : "Nie"}
                      </td>
                      <td>
                        {#if !key.revokedAt}
                          <button
                            class="btn btn-sm btn-ghost btn-danger-ghost"
                            onclick={() => revokeApiKey(key.id)}>Widerrufen</button
                          >
                        {:else}
                          <span class="text-muted revoked-label">Widerrufen</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <Pagination total={apiKeys.length} bind:page={akPage} bind:pageSize={akPageSize} />
            </div>
          {:else}
            <p class="text-muted">Keine API Keys vorhanden.</p>
          {/if}
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

  .row-revoked {
    opacity: 0.5;
  }

  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
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

  /* ── Schichtprüfung gegen Öffnungszeiten (Phase 58) ──────── */
  .cfg-muted {
    color: var(--text-2);
    font-size: 13.5px;
  }
  .cfg-section-title {
    margin: 24px 0 8px;
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--text);
  }
  .cfg-mode-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .cfg-mode-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text);
    transition: border-color 0.12s var(--ease);
  }
  .cfg-mode-option:hover {
    border-color: var(--brand);
  }
  .cfg-mode-option input {
    margin-top: 2px;
  }
  .cfg-mode-option strong {
    color: var(--text);
  }

  /* Inline create row (NFC/API key creation) */
  .inline-create {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .inline-create .form-input {
    flex: 1;
  }

  /* Key display (after creation, shown once) */
  .key-display {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .key-code {
    flex: 1;
    padding: 0.5rem;
    background: var(--sunk);
    border-radius: var(--r-control);
    word-break: break-all;
    font-size: 0.8125rem;
    font-family: var(--font-code);
    color: var(--text);
  }
  .inline-code {
    font-family: var(--font-code);
    font-size: 0.8125rem;
    color: var(--text);
  }

  /* API key scope chips */
  .api-key-create {
    margin-bottom: 1rem;
  }
  .scope-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .scope-cell {
    font-size: 0.75rem;
  }
  .revoked-label {
    font-size: 0.75rem;
  }

  /* Danger ghost button: ghost styling with --bad color */
  .btn-danger-ghost {
    color: var(--bad);
  }

  @media (max-width: 640px) {
    .inline-fields {
      flex-direction: column;
      gap: 1rem;
    }

    .inline-create {
      flex-direction: column;
    }
  }
</style>
