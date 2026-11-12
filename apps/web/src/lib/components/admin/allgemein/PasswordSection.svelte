<!--
  PasswordSection - „Passwort-Richtlinie“ of System › Allgemein (Issue #854, D-854-03): the minimum length
  and the four character classes a password needs. One SaveBar sends exactly the five keys of the registry
  section `allgemein-passwort` to `PUT /settings/security` (#878). The policy is security-relevant, so it
  never saves on a change of a single field (§3.2.1, D-07).

  Props:
    config  - the loaded `GET /settings/security` answer
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
    PASSWORD_MIN_LENGTH_MAX,
    PASSWORD_MIN_LENGTH_MIN,
    messageCount,
    passwordFrom,
    passwordMessages,
    passwordWire,
    type PasswordField,
    type PasswordValues,
    type SecurityConfig,
  } from "$lib/settings/allgemein";

  interface Props {
    config: SecurityConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<PasswordValues>(untrack(() => passwordFrom(config)));
  let values = $state<PasswordValues>(untrack(() => passwordFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("allgemein-passwort").keys as readonly PasswordField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(passwordMessages(values));
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
      await api.put(
        "/settings/security",
        pickSection(
          passwordWire(values) as Record<string, unknown>,
          settingsSection("allgemein-passwort").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Passwort-Richtlinie gespeichert.");
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
  id="passwort"
  title="Passwort-Richtlinie"
  description="Welche Passwörter Clokr akzeptiert (Empfehlung des BSI)."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Richtlinie speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Mindestlänge (Zeichen)"
    help="Das BSI empfiehlt mindestens 12 Zeichen."
    error={messages.passwordMinLength}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={PASSWORD_MIN_LENGTH_MIN}
        max={PASSWORD_MIN_LENGTH_MAX}
        step="1"
        bind:value={values.passwordMinLength}
        disabled={!canEdit || saving}
        data-testid="admin-system-password-minLength"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <ToggleField
    bind:checked={values.passwordRequireUpper}
    label="Großbuchstabe erforderlich"
    disabled={!canEdit || saving}
    testid="admin-system-password-requireUpper"
  />
  <ToggleField
    bind:checked={values.passwordRequireLower}
    label="Kleinbuchstabe erforderlich"
    disabled={!canEdit || saving}
    testid="admin-system-password-requireLower"
  />
  <ToggleField
    bind:checked={values.passwordRequireDigit}
    label="Ziffer erforderlich"
    disabled={!canEdit || saving}
    testid="admin-system-password-requireDigit"
  />
  <ToggleField
    bind:checked={values.passwordRequireSpecial}
    label="Sonderzeichen erforderlich"
    disabled={!canEdit || saving}
    testid="admin-system-password-requireSpecial"
  />
</SettingsGroup>
