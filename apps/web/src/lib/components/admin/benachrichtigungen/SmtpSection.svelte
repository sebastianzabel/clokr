<!--
  SmtpSection - „E-Mail-Server“ of Regeln › Benachrichtigungen & E-Mail (Issue #854, D-854-03): the outgoing
  mail server and its test mail. Moved from the System page (Kommunikation); one SaveBar sends exactly the
  seven keys of the registry section `benachrichtigungen-smtp` to `PUT /settings/smtp` (#878).

  The password is WRITE-ONLY (T-854-22): the field is always empty, the page only knows whether one is stored
  ("gespeichert"), and it is sent only when typed - an empty field never overwrites the stored one.

  The test mail is an action of its own, not a field of the form: `POST /settings/smtp/test` sends through
  the STORED server settings, so unsaved edits are not tested (the help line says so).

  Props:
    config  - the loaded `GET /settings/smtp` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
    mailWarning - Issue #847: e-mail notifications are on but no mail server can deliver (the page decides it
              through `mailWithoutDelivery()`, the one rule)
    onSaved - called after a successful save, so the page re-reads whether mail can be delivered now
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import { MAIL_WITHOUT_DELIVERY_TEXT } from "$lib/admin/setup-checks";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    messageCount,
    smtpFrom,
    smtpMessages,
    smtpWire,
    type SmtpConfig,
    type SmtpField,
    type SmtpValues,
  } from "$lib/settings/benachrichtigungen";

  interface Props {
    config: SmtpConfig;
    canEdit?: boolean;
    changes?: number;
    mailWarning?: boolean;
    onSaved?: () => void;
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

  let snapshot = $state<SmtpValues>(untrack(() => smtpFrom(config)));
  let values = $state<SmtpValues>(untrack(() => smtpFrom(config)));
  let passwordSet = $state(untrack(() => config.smtpPasswordSet ?? false));
  let saving = $state(false);

  let testEmail = $state("");
  let testing = $state(false);

  const keys = settingsSection("benachrichtigungen-smtp").keys as readonly SmtpField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(smtpMessages(values));
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
      const typedPassword = values.smtpPassword !== "";
      await api.put(
        "/settings/smtp",
        pickSection(
          smtpWire(values) as Record<string, unknown>,
          settingsSection("benachrichtigungen-smtp").keys,
        ),
      );
      // The typed password is gone from the form the moment it is stored; only its presence is kept.
      values.smtpPassword = "";
      if (typedPassword) passwordSet = true;
      snapshot = $state.snapshot(values);
      toasts.success("E-Mail-Server gespeichert.");
      onSaved?.();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = $state.snapshot(snapshot);
  }

  async function sendTest() {
    testing = true;
    try {
      await api.post("/settings/smtp/test", { email: testEmail.trim() });
      toasts.success("Test-E-Mail wurde gesendet.");
    } catch (err) {
      toasts.error(
        err instanceof Error ? err.message : "Die Test-E-Mail konnte nicht gesendet werden.",
      );
    } finally {
      testing = false;
    }
  }
</script>

<SettingsGroup
  id="mailserver"
  title="E-Mail-Server"
  description="Über diesen Server verschickt Clokr E-Mails, zum Beispiel Einladungen und Benachrichtigungen."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Server speichern"
  onSave={save}
  onDiscard={discard}
>
  {#if mailWarning}
    <div data-testid="mail-warning-smtp">
      <Note tone="bad">{MAIL_WITHOUT_DELIVERY_TEXT}</Note>
    </div>
  {/if}

  <FormField label="Server" error={messages.smtpHost}>
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        placeholder="smtp.example.com"
        autocomplete="off"
        bind:value={values.smtpHost}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-host"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField label="Port" error={messages.smtpPort}>
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min="1"
        max="65535"
        step="1"
        placeholder="587"
        bind:value={values.smtpPort}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-port"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <ToggleField
    bind:checked={values.smtpSecure}
    label="Verschlüsselte Verbindung (TLS/SSL)"
    help="Schalte das für den Port 465 ein. Für Port 587 bleibt es aus."
    disabled={!canEdit || saving}
    testid="benachrichtigungen-smtp-secure"
  />

  <FormField label="Benutzername" error={messages.smtpUser}>
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        placeholder="user@example.com"
        autocomplete="off"
        bind:value={values.smtpUser}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-user"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField
    label={passwordSet ? "Passwort (gespeichert)" : "Passwort"}
    help={passwordSet
      ? "Lass das Feld leer, um das gespeicherte Passwort zu behalten. Bei Gmail und Outlook brauchst du ein App-Passwort."
      : "Bei Gmail und Outlook brauchst du ein App-Passwort."}
  >
    {#snippet field({ id, describedBy })}
      <input
        {id}
        class="form-input"
        type="password"
        placeholder={passwordSet ? "Unverändert lassen" : ""}
        autocomplete="new-password"
        bind:value={values.smtpPassword}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-password"
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField label="Absenderadresse" error={messages.smtpFromEmail}>
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="email"
        placeholder="noreply@example.com"
        bind:value={values.smtpFromEmail}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-from-email"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField label="Absendername" error={messages.smtpFromName}>
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        placeholder="Clokr"
        bind:value={values.smtpFromName}
        disabled={!canEdit || saving}
        data-testid="benachrichtigungen-smtp-from-name"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField
    label="Test-E-Mail senden an"
    help="Der Test nutzt die gespeicherten Einstellungen. Speichere Änderungen zuerst."
  >
    {#snippet field({ id, describedBy })}
      <div class="smtp-test">
        <input
          {id}
          class="form-input"
          type="email"
          placeholder="test@example.com"
          bind:value={testEmail}
          disabled={!canEdit || testing}
          data-testid="benachrichtigungen-smtp-test-email"
          aria-describedby={describedBy}
        />
        <button
          type="button"
          class="btn btn-secondary"
          disabled={!canEdit || testing || testEmail.trim() === ""}
          onclick={sendTest}
          data-testid="benachrichtigungen-smtp-test"
        >
          Test-E-Mail senden
        </button>
      </div>
    {/snippet}
  </FormField>
</SettingsGroup>

<style>
  .smtp-test {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
  }

  .smtp-test input {
    flex: 1 1 14rem;
    min-width: 0;
  }
</style>
