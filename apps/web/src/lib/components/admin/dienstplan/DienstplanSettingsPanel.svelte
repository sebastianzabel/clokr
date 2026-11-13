<!--
  DienstplanSettingsPanel - „Einstellungen“ of Regeln › Dienstplan (Issue #854, D-854-03): the settings that
  govern the roster, moved here from the System and Urlaub pages. Every setting lives exactly once
  (lib/settings/settings-pages.ts). Each section keeps its own snapshot, shows its own SaveBar and sends only
  its own registry keys to `PUT /settings/work` (#878); a person sees a section only under the permission
  alternatives of the page it came from (D-854-05).

  Props:
    config  - the loaded `GET /settings/work` answer
    changes - bindable, the number of unsaved changes of all sections (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import {
    REMINDER_OFFSET_MAX,
    REMINDER_OFFSET_MIN,
    STORE_HOURS_MODES,
    availabilityFrom,
    availabilityWire,
    hoursModeFrom,
    hoursModeWire,
    shiftRemindersFrom,
    shiftRemindersWire,
    vocationalCleanupFrom,
    vocationalCleanupWire,
    type AvailabilityField,
    type AvailabilityValues,
    type DienstplanConfig,
    type HoursModeField,
    type HoursModeValues,
    type ShiftRemindersField,
    type ShiftRemindersValues,
    type VocationalCleanupField,
    type VocationalCleanupValues,
  } from "$lib/settings/dienstplan";

  interface Props {
    config: DienstplanConfig;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, changes = $bindable(0) }: Props = $props();

  const user = $derived($authStore.user);
  const show = $derived({
    hours: mayOpenSection(user, settingsSection("dienstplan-oeffnungszeiten")),
    availability: mayOpenSection(user, settingsSection("dienstplan-verfuegbarkeit")),
    vocational: mayOpenSection(user, settingsSection("dienstplan-berufsschule")),
    reminders: mayOpenSection(user, settingsSection("dienstplan-erinnerungen")),
  });

  // ── Schichten und Öffnungszeiten ─────────────────────────────────────────────────────────────
  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let hoursSnapshot = $state<HoursModeValues>(untrack(() => hoursModeFrom(config)));
  let hours = $state<HoursModeValues>(untrack(() => hoursModeFrom(config)));
  let hoursSaving = $state(false);
  const hoursChanges = $derived(
    countChanges(
      hoursSnapshot,
      hours,
      settingsSection("dienstplan-oeffnungszeiten").keys as readonly HoursModeField[],
    ),
  );

  async function saveHours() {
    hoursSaving = true;
    try {
      // Minimal payload on purpose: only the mode (a tenant policy, #563 / #878).
      await api.put(
        "/settings/work",
        pickSection(
          hoursModeWire(hours) as Record<string, unknown>,
          settingsSection("dienstplan-oeffnungszeiten").keys,
        ),
      );
      hoursSnapshot = $state.snapshot(hours);
      toasts.success("Prüfmodus gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      hoursSaving = false;
    }
  }

  function discardHours() {
    hours = $state.snapshot(hoursSnapshot);
  }

  // ── Verfügbarkeiten ──────────────────────────────────────────────────────────────────────────
  let availabilitySnapshot = $state<AvailabilityValues>(untrack(() => availabilityFrom(config)));
  let availability = $state<AvailabilityValues>(untrack(() => availabilityFrom(config)));
  let availabilitySaving = $state(false);
  const availabilityChanges = $derived(
    countChanges(
      availabilitySnapshot,
      availability,
      settingsSection("dienstplan-verfuegbarkeit").keys as readonly AvailabilityField[],
    ),
  );

  async function saveAvailability() {
    availabilitySaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          availabilityWire(availability) as Record<string, unknown>,
          settingsSection("dienstplan-verfuegbarkeit").keys,
        ),
      );
      availabilitySnapshot = $state.snapshot(availability);
      // Propagate to Sidebar and BottomTabBar at once, without a reload.
      tenantFeatures.applyLocal(availability.availabilityEnabled);
      toasts.success("Verfügbarkeiten gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      availabilitySaving = false;
    }
  }

  function discardAvailability() {
    availability = $state.snapshot(availabilitySnapshot);
  }

  // ── Berufsschule und Schichten ───────────────────────────────────────────────────────────────
  // The backend reads TenantConfig.vocationalSchoolAutoCleanupShifts in shift-cleanup.ts; the key was missing
  // in the API schema until plan 854-04, so before that no save of this switch persisted (D-854-20).
  let vocationalSnapshot = $state<VocationalCleanupValues>(
    untrack(() => vocationalCleanupFrom(config)),
  );
  let vocational = $state<VocationalCleanupValues>(untrack(() => vocationalCleanupFrom(config)));
  let vocationalSaving = $state(false);
  const vocationalChanges = $derived(
    countChanges(
      vocationalSnapshot,
      vocational,
      settingsSection("dienstplan-berufsschule").keys as readonly VocationalCleanupField[],
    ),
  );

  async function saveVocational() {
    vocationalSaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          vocationalCleanupWire(vocational) as Record<string, unknown>,
          settingsSection("dienstplan-berufsschule").keys,
        ),
      );
      vocationalSnapshot = $state.snapshot(vocational);
      toasts.success("Berufsschul-Bereinigung gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      vocationalSaving = false;
    }
  }

  function discardVocational() {
    vocational = $state.snapshot(vocationalSnapshot);
  }

  // ── Schicht-Erinnerungen ─────────────────────────────────────────────────────────────────────
  let remindersSnapshot = $state<ShiftRemindersValues>(untrack(() => shiftRemindersFrom(config)));
  let reminders = $state<ShiftRemindersValues>(untrack(() => shiftRemindersFrom(config)));
  let remindersSaving = $state(false);
  const remindersChanges = $derived(
    countChanges(
      remindersSnapshot,
      reminders,
      settingsSection("dienstplan-erinnerungen").keys as readonly ShiftRemindersField[],
    ),
  );

  async function saveReminders() {
    remindersSaving = true;
    try {
      // The offset is clamped and an empty evening time falls back to 20:00 on the way out: the API fields
      // are .optional(), not .nullable() (Issue #609).
      const wire = shiftRemindersWire(reminders);
      await api.put(
        "/settings/work",
        pickSection(
          wire as Record<string, unknown>,
          settingsSection("dienstplan-erinnerungen").keys,
        ),
      );
      // Show what was stored.
      reminders.reminderOffsetMinutes = wire.reminderOffsetMinutes as number;
      reminders.reminderDayCloseTime = wire.reminderDayCloseTime as string;
      remindersSnapshot = $state.snapshot(reminders);
      toasts.success("Schicht-Erinnerungen gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      remindersSaving = false;
    }
  }

  function discardReminders() {
    reminders = $state.snapshot(remindersSnapshot);
  }

  $effect(() => {
    changes = hoursChanges + availabilityChanges + vocationalChanges + remindersChanges;
  });
</script>

{#if show.hours}
  <SettingsGroup
    title="Schichten und Öffnungszeiten"
    description="Wie streng Schichten an die Öffnungszeiten des jeweiligen Salons gebunden werden. Die Öffnungszeiten selbst pflegst du je Salon unter Verwalten › Salons."
    changes={hoursChanges}
    errors={0}
    saving={hoursSaving}
    saveLabel="Prüfmodus speichern"
    onSave={saveHours}
    onDiscard={discardHours}
  >
    <fieldset class="mode-set" disabled={hoursSaving}>
      <legend class="mode-legend">Schicht-Zeiten an Öffnungszeiten binden</legend>
      {#each STORE_HOURS_MODES as mode (mode.value)}
        <label class="mode-option">
          <input
            type="radio"
            name="shiftStoreHoursMode"
            value={mode.value}
            bind:group={hours.shiftStoreHoursMode}
            data-testid={`dienstplan-oeffnungszeiten-${mode.value}`}
          />
          <span>
            <strong>{mode.label}</strong>
            <span class="mode-help">{mode.help}</span>
          </span>
        </label>
      {/each}
    </fieldset>
  </SettingsGroup>
{/if}

{#if show.availability}
  <SettingsGroup
    title="Verfügbarkeiten"
    description="Ob Mitarbeitende ihre Verfügbarkeit selbst pflegen und der Dienstplan sie berücksichtigt."
    changes={availabilityChanges}
    errors={0}
    saving={availabilitySaving}
    saveLabel="Verfügbarkeiten speichern"
    onSave={saveAvailability}
    onDiscard={discardAvailability}
  >
    <ToggleField
      bind:checked={availability.availabilityEnabled}
      label="Verfügbarkeits-System aktivieren"
      help={availability.availabilityEnabled
        ? "Mitarbeitende pflegen ihre Verfügbarkeit selbst, die Navigation zeigt „Verfügbarkeit“. Automatisches Erzeugen und „Woche kopieren“ respektieren „Nicht verfügbar“; Vorgesetzte können das nach einer Bestätigung überschreiben (mit Audit-Eintrag)."
        : "Ausgeschaltet: „Verfügbarkeit“ ist in der Navigation ausgeblendet, das Erzeugen von Schichten ignoriert Verfügbarkeits-Markierungen. Bereits angelegte Verfügbarkeiten bleiben gespeichert."}
      disabled={availabilitySaving}
      testid="dienstplan-verfuegbarkeit-enabled"
    />
  </SettingsGroup>
{/if}

{#if show.vocational}
  <SettingsGroup
    title="Berufsschule und Schichten"
    description="Was mit geplanten Schichten passiert, wenn auf denselben Tag ein Berufsschultag fällt."
    changes={vocationalChanges}
    errors={0}
    saving={vocationalSaving}
    saveLabel="Einstellung speichern"
    onSave={saveVocational}
    onDiscard={discardVocational}
  >
    <ToggleField
      bind:checked={vocational.vocationalSchoolAutoCleanupShifts}
      label="Schichten auf Berufsschultagen automatisch entfernen"
      help={vocational.vocationalSchoolAutoCleanupShifts
        ? "Aktiv: Legt der Generator neue Berufsschultage an, werden künftige Schichten auf diesen Tagen automatisch entfernt (wiederherstellbar). Schichten in der Vergangenheit werden nur als Konflikt markiert."
        : "Ausgeschaltet: Schichten auf neuen Berufsschultagen werden nur als Konflikt markiert. Du bereinigst sie von Hand."}
      disabled={vocationalSaving}
      testid="dienstplan-berufsschule-cleanup"
    />
    <p class="form-hint">
      Entfernte Schichten findest du unter <a href="/team/dienstplan/konflikte"
        >Team › Dienstplan › Konflikte</a
      >.
    </p>
  </SettingsGroup>
{/if}

{#if show.reminders}
  <SettingsGroup
    title="Schicht-Erinnerungen"
    description="Erinnerungen an Personen mit einer geplanten Schicht."
    changes={remindersChanges}
    errors={0}
    saving={remindersSaving}
    saveLabel="Erinnerungen speichern"
    onSave={saveReminders}
    onDiscard={discardReminders}
  >
    <ToggleField
      bind:checked={reminders.reminderShiftStartEnabled}
      label="Bei Schichtbeginn erinnern, wenn noch nicht eingestempelt"
      disabled={remindersSaving}
      testid="dienstplan-erinnerungen-start"
    />
    <ToggleField
      bind:checked={reminders.reminderShiftEndEnabled}
      label="Bei Schichtende erinnern, wenn noch eingestempelt"
      disabled={remindersSaving}
      testid="dienstplan-erinnerungen-end"
    />
    <ToggleField
      bind:checked={reminders.reminderDayCloseEnabled}
      label="Abends erinnern, wenn an einem Schichttag keine Zeit erfasst ist"
      disabled={remindersSaving}
      testid="dienstplan-erinnerungen-dayclose"
    />
    <FormField
      label="Erinnern nach (Minuten)"
      help={`Gilt für den Schichtbeginn und das Schichtende (${REMINDER_OFFSET_MIN} bis ${REMINDER_OFFSET_MAX} Minuten).`}
    >
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="number"
          min={REMINDER_OFFSET_MIN}
          max={REMINDER_OFFSET_MAX}
          step="1"
          bind:value={reminders.reminderOffsetMinutes}
          disabled={remindersSaving}
          data-testid="dienstplan-erinnerungen-offset"
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <FormField
      label="Uhrzeit der Abend-Erinnerung"
      help="Schichten, die nach dieser Uhrzeit enden, bekommen an diesem Tag keine Abend-Erinnerung. Wähle eine Uhrzeit nach eurem spätesten Schichtende."
    >
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="time"
          bind:value={reminders.reminderDayCloseTime}
          disabled={remindersSaving}
          data-testid="dienstplan-erinnerungen-dayclose-time"
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <p class="form-hint">
      Erinnert werden nur Personen mit einer geplanten Schicht. Clokr stempelt nie selbst – die
      Person bestätigt das Stempeln in der App.
    </p>
  </SettingsGroup>
{/if}

<style>
  .mode-set {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .mode-legend {
    padding: 0;
    margin-bottom: var(--s-2);
    font-weight: 600;
    font-size: var(--fs-base);
    color: var(--text);
  }

  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    cursor: pointer;
    font-size: var(--fs-base);
    color: var(--text);
    transition: border-color 0.12s var(--ease);
  }

  .mode-option:hover {
    border-color: var(--brand);
  }

  .mode-option input {
    margin-top: 0.2rem;
    flex-shrink: 0;
  }

  .mode-help {
    display: block;
    margin-top: var(--s-1);
    color: var(--text-2);
  }
</style>
