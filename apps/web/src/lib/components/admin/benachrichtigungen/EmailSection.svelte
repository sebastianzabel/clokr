<!--
  EmailSection - „E-Mail-Benachrichtigungen“ of Regeln › Benachrichtigungen & E-Mail (Issue #854, D-854-03):
  the master switch and the seven notification types that are sent by e-mail in addition to the in-app
  notice. Moved from the System page; one SaveBar sends exactly the eight keys of the registry section
  `benachrichtigungen-email` to `PUT /settings/security` (#878). While the master switch is off the seven
  types are shown but disabled - they have no effect then.

  Props:
    config  - the loaded `GET /settings/security` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
    mailWarning - Issue #847: e-mail notifications are on but no mail server can deliver (the page decides it
              through `mailWithoutDelivery()`, the one rule)
    onSaved - called after a successful save with the stored master switch, for that same warning
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Note from "$components/ui/Note.svelte";
  import { MAIL_WITHOUT_DELIVERY_TEXT } from "$lib/admin/setup-checks";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    EMAIL_TYPE_FIELDS,
    EMAIL_TYPE_LABELS,
    emailFrom,
    emailWire,
    type EmailField,
    type EmailValues,
    type SecurityEmailConfig,
  } from "$lib/settings/benachrichtigungen";

  interface Props {
    config: SecurityEmailConfig;
    canEdit?: boolean;
    changes?: number;
    mailWarning?: boolean;
    onSaved?: (emailNotificationsEnabled: boolean) => void;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  let {
    config,
    canEdit = true,
    // eslint-disable-next-line no-useless-assignment
    changes = $bindable(0),
    mailWarning = false,
    onSaved,
  }: Props = $props();

  let snapshot = $state<EmailValues>(untrack(() => emailFrom(config)));
  let values = $state<EmailValues>(untrack(() => emailFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("benachrichtigungen-email").keys as readonly EmailField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));

  $effect(() => {
    changes = changeCount;
  });

  async function save() {
    saving = true;
    try {
      await api.put(
        "/settings/security",
        pickSection(
          emailWire(values) as Record<string, unknown>,
          settingsSection("benachrichtigungen-email").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("E-Mail-Benachrichtigungen gespeichert.");
      onSaved?.(values.emailNotificationsEnabled);
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
  title="E-Mail-Benachrichtigungen"
  description="Welche Ereignisse zusätzlich zur Benachrichtigung in Clokr per E-Mail gemeldet werden."
  changes={changeCount}
  errors={0}
  {saving}
  saveLabel="Benachrichtigungen speichern"
  onSave={save}
  onDiscard={discard}
>
  <ToggleField
    bind:checked={values.emailNotificationsEnabled}
    label="E-Mail-Benachrichtigungen aktivieren"
    help="Clokr schickt zusätzlich eine E-Mail. Dafür muss der E-Mail-Server eingerichtet sein."
    disabled={!canEdit || saving}
    testid="benachrichtigungen-email-emailNotificationsEnabled"
  />
  {#if mailWarning}
    <div data-testid="mail-warning">
      <Note tone="bad">{MAIL_WITHOUT_DELIVERY_TEXT}</Note>
    </div>
  {/if}

  {#each EMAIL_TYPE_FIELDS as field (field)}
    <ToggleField
      bind:checked={values[field]}
      label={EMAIL_TYPE_LABELS[field]}
      disabled={!canEdit || saving || !values.emailNotificationsEnabled}
      testid={`benachrichtigungen-email-${field}`}
    />
  {/each}
</SettingsGroup>
