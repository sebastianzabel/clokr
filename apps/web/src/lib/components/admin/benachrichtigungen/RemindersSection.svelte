<!--
  RemindersSection - „Erinnerungen“ of Regeln › Benachrichtigungen & E-Mail (Issue #854, D-854-03): when
  Clokr reminds about a forgotten clock-out, missing entries, pending leave requests and upcoming absences.
  Moved from the Urlaub page; one SaveBar sends exactly the six keys of the registry section
  `benachrichtigungen-erinnerungen` to `PUT /settings/work` (#878). The shift reminders are not here: they
  belong to the roster settings.

  Props:
    config  - the loaded `GET /settings/work` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    CLOCK_OUT_HOURS_MAX,
    CLOCK_OUT_HOURS_MIN,
    MISSING_DAYS_MAX,
    MISSING_DAYS_MIN,
    PENDING_LEAVE_HOURS_MAX,
    PENDING_LEAVE_HOURS_MIN,
    UPCOMING_ABSENCE_DAYS_MAX,
    UPCOMING_ABSENCE_DAYS_MIN,
    messageCount,
    remindersFrom,
    remindersMessages,
    remindersWire,
    type ReminderConfig,
    type ReminderField,
    type ReminderValues,
  } from "$lib/settings/benachrichtigungen";

  interface Props {
    config: ReminderConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<ReminderValues>(untrack(() => remindersFrom(config)));
  let values = $state<ReminderValues>(untrack(() => remindersFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("benachrichtigungen-erinnerungen").keys as readonly ReminderField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(remindersMessages(values));
  const errorCount = $derived(messageCount(messages));

  $effect(() => {
    changes = changeCount;
  });

  async function save() {
    if (errorCount > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      const wire = remindersWire(values);
      await api.put(
        "/settings/work",
        pickSection(
          wire as Record<string, unknown>,
          settingsSection("benachrichtigungen-erinnerungen").keys,
        ),
      );
      // Show what was stored (whole numbers, defaults for an emptied threshold of a switched-off reminder).
      values.clockOutReminderHours = wire.clockOutReminderHours as number;
      values.missingEntriesDays = wire.missingEntriesDays as number;
      values.reminderPendingLeaveHours = wire.reminderPendingLeaveHours as number;
      values.reminderUpcomingAbsenceDays = wire.reminderUpcomingAbsenceDays as number;
      snapshot = $state.snapshot(values);
      toasts.success("Erinnerungen gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = $state.snapshot(snapshot);
  }
</script>

<SettingsGroup
  title="Erinnerungen"
  description="Wann Clokr Mitarbeitende und Vorgesetzte an offene Punkte erinnert."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Erinnerungen speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Erinnerung bei offener Stempelung nach (Stunden)"
    help="Mitarbeitende werden erinnert, wenn sie länger als diese Zeit eingestempelt sind."
    error={messages.clockOutReminderHours}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={CLOCK_OUT_HOURS_MIN}
        max={CLOCK_OUT_HOURS_MAX}
        step="1"
        bind:value={values.clockOutReminderHours}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-erinnerungen-clockout"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField
    label="Erinnerung bei fehlenden Einträgen nach (Tagen)"
    help="Mitarbeitende und Vorgesetzte werden benachrichtigt, wenn keine Zeiteinträge erfasst wurden."
    error={messages.missingEntriesDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={MISSING_DAYS_MIN}
        max={MISSING_DAYS_MAX}
        step="1"
        bind:value={values.missingEntriesDays}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-erinnerungen-missing"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <ToggleField
    bind:checked={values.reminderPendingLeaveEnabled}
    label="Offene Urlaubsanträge: Vorgesetzte erinnern"
    disabled={!canEdit || saving}
    testid="benachrichtigungen-erinnerungen-pending-enabled"
  />
  {#if values.reminderPendingLeaveEnabled}
    <FormField
      label="Erinnern nach (Stunden)"
      help="So lange darf ein Antrag offen sein, bevor Clokr erinnert."
      error={messages.reminderPendingLeaveHours}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="number"
          min={PENDING_LEAVE_HOURS_MIN}
          max={PENDING_LEAVE_HOURS_MAX}
          step="1"
          bind:value={values.reminderPendingLeaveHours}
          disabled={!canEdit || saving}
          data-testid="benachrichtigungen-erinnerungen-pending-hours"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
  {/if}

  <ToggleField
    bind:checked={values.reminderUpcomingAbsenceEnabled}
    label="Bevorstehende Abwesenheiten: Mitarbeitende erinnern"
    disabled={!canEdit || saving}
    testid="benachrichtigungen-erinnerungen-upcoming-enabled"
  />
  {#if values.reminderUpcomingAbsenceEnabled}
    <FormField
      label="Erinnern vorher (Tage)"
      help="So viele Tage vor Beginn einer genehmigten Abwesenheit erinnert Clokr."
      error={messages.reminderUpcomingAbsenceDays}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="number"
          min={UPCOMING_ABSENCE_DAYS_MIN}
          max={UPCOMING_ABSENCE_DAYS_MAX}
          step="1"
          bind:value={values.reminderUpcomingAbsenceDays}
          disabled={!canEdit || saving}
          data-testid="benachrichtigungen-erinnerungen-upcoming-days"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
  {/if}
</SettingsGroup>
