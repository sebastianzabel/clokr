<!--
  SessionSection - „Sitzungen“ of System › Allgemein (Issue #854, D-854-03): how long a session lasts, how
  many may run at once and when a failed sign-in locks the account. One SaveBar sends exactly the seven keys
  of the registry section `allgemein-sitzungen` to `PUT /settings/security` (#878). All seven are sent
  together, so the form is one group and never saves a single field (§3.2.1, D-07). While „Angemeldet
  bleiben“ is not allowed its duration is shown but disabled - it has no effect then.

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
    SESSION_BOUNDS,
    messageCount,
    sessionFrom,
    sessionMessages,
    sessionWire,
    type SecurityConfig,
    type SessionField,
    type SessionNumberField,
    type SessionValues,
  } from "$lib/settings/allgemein";

  interface Props {
    config: SecurityConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<SessionValues>(untrack(() => sessionFrom(config)));
  let values = $state<SessionValues>(untrack(() => sessionFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("allgemein-sitzungen").keys as readonly SessionField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(sessionMessages(values));
  const errorCount = $derived(messageCount(messages));

  $effect(() => {
    changes = changeCount;
  });

  const HELP: Record<SessionNumberField, string> = {
    sessionTimeoutMinutes:
      "0 schaltet den Timeout aus. Sonst wirst du nach Inaktivität abgemeldet.",
    refreshTokenDays: "So lange bleibt eine Anmeldung ohne „Angemeldet bleiben“ gültig.",
    rememberMeDays: "Längste Gültigkeit einer Sitzung mit „Angemeldet bleiben“.",
    maxSessionsPerUser:
      "0 bedeutet unbegrenzt. Bei Überschreitung wird die älteste Sitzung beendet.",
    loginMaxAttempts: "So viele falsche Anmeldungen, bis das Konto vorübergehend gesperrt wird.",
    loginLockoutMinutes:
      "Danach wird der Zähler zurückgesetzt. Ein Admin kann das Konto auch früher entsperren.",
  };
  const TEST_IDS: Record<SessionNumberField, string> = {
    sessionTimeoutMinutes: "admin-system-session-timeout",
    refreshTokenDays: "admin-system-session-refreshDays",
    rememberMeDays: "admin-system-session-rememberDays",
    maxSessionsPerUser: "admin-system-session-maxSessions",
    loginMaxAttempts: "admin-system-session-maxAttempts",
    loginLockoutMinutes: "admin-system-session-lockoutMinutes",
  };

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
          sessionWire(values) as Record<string, unknown>,
          settingsSection("allgemein-sitzungen").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Sitzungs-Einstellungen gespeichert.");
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

{#snippet numberField(name: SessionNumberField, disabled: boolean)}
  <FormField
    label={`${SESSION_BOUNDS[name].label} (${SESSION_BOUNDS[name].unit})`}
    help={HELP[name]}
    error={messages[name]}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={SESSION_BOUNDS[name].min}
        max={SESSION_BOUNDS[name].max}
        step="1"
        bind:value={values[name]}
        disabled={!canEdit || saving || disabled}
        data-testid={TEST_IDS[name]}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
{/snippet}

<SettingsGroup
  id="sitzungen"
  title="Sitzungen"
  description="Timeouts, Sitzungsdauer und Sperrzeiten bei Fehlversuchen."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Sitzungen speichern"
  onSave={save}
  onDiscard={discard}
>
  {@render numberField("sessionTimeoutMinutes", false)}
  {@render numberField("refreshTokenDays", false)}

  <ToggleField
    bind:checked={values.rememberMeEnabled}
    label="„Angemeldet bleiben“ erlauben"
    help="Personen können beim Anmelden über mehrere Sitzungen hinweg angemeldet bleiben."
    disabled={!canEdit || saving}
    testid="admin-system-session-rememberMeEnabled"
  />
  {@render numberField("rememberMeDays", !values.rememberMeEnabled)}

  {@render numberField("maxSessionsPerUser", false)}
  {@render numberField("loginMaxAttempts", false)}
  {@render numberField("loginLockoutMinutes", false)}
</SettingsGroup>
