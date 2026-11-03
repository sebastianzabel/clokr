<!--
  Issue #609 (D-02, D-10): the "Erinnerungen" section of the profile page.

  One switch per occasion the tenant enabled (checked = the person did not opt out); none enabled,
  or a profile without an employee (400), shows nothing. Each switch saves at once with a toast
  and rolls back on failure (docs/ADMIN_STRUCTURE.md §3.2.1: an atomic value is an instant save,
  there is no section button). The component only presents the server's answer and sends the
  person's own opt-outs - Clokr never stamps by itself, the reminder leads to a confirmation.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError } from "$api/client";
  import {
    getMyReminders,
    updateMyReminders,
    type MyReminderOptOuts,
    type MyReminders,
  } from "$lib/api/reminders";
  import { toasts } from "$stores/toast";
  import Card from "$components/ui/Card.svelte";

  let data = $state<MyReminders | null>(null);
  // One save at a time: a second click while the PATCH runs would race the rollback.
  let saving = $state(false);

  interface Row {
    key: keyof MyReminderOptOuts;
    label: string;
    enabled: boolean;
  }

  const rows = $derived<Row[]>(
    data === null
      ? []
      : ([
          {
            key: "shiftStartOff",
            label: "Bei Schichtbeginn erinnern",
            enabled: data.tenant.shiftStartEnabled,
          },
          {
            key: "shiftEndOff",
            label: "Bei Schichtende erinnern",
            enabled: data.tenant.shiftEndEnabled,
          },
          {
            key: "dayCloseOff",
            label: "Abends erinnern, wenn deine Zeit fehlt",
            enabled: data.tenant.dayCloseEnabled,
          },
        ].filter((row) => row.enabled) as Row[]),
  );

  /** The hint names only the parts of the occasions the tenant enabled. */
  const hint = $derived.by(() => {
    if (data === null) return "";
    const { shiftStartEnabled, shiftEndEnabled, dayCloseEnabled, offsetMinutes, dayCloseTime } =
      data.tenant;
    const parts: string[] = [];
    if (shiftStartEnabled || shiftEndEnabled) {
      const anchor =
        shiftStartEnabled && shiftEndEnabled
          ? "Schichtbeginn bzw. Schichtende"
          : shiftStartEnabled
            ? "Schichtbeginn"
            : "Schichtende";
      parts.push(`${offsetMinutes} Minuten nach ${anchor}`);
    }
    if (dayCloseEnabled) {
      parts.push(`um ${dayCloseTime}, wenn an einem Schichttag noch keine Zeit erfasst ist`);
    }
    return `Wir erinnern dich ${parts.join(" und ")}. Gestempelt wird nur, wenn du es in der App bestätigst.`;
  });

  onMount(async () => {
    try {
      data = await getMyReminders();
    } catch (error) {
      // 400 = no employee profile (API key, user without an employee): nothing to offer, no noise.
      if (error instanceof ApiError && error.status === 400) return;
      toasts.error("Deine Erinnerungs-Einstellungen konnten nicht geladen werden.");
    }
  });

  async function toggle(key: keyof MyReminderOptOuts, checked: boolean) {
    if (saving || data === null) return;
    const previous = data.own[key];
    const nextOff = !checked;
    // Optimistic: the switch already shows the new state, a failure puts the old one back.
    data = { ...data, own: { ...data.own, [key]: nextOff } };
    saving = true;
    try {
      data = await updateMyReminders({ [key]: nextOff });
      toasts.success("Gespeichert");
    } catch (error) {
      if (data !== null) data = { ...data, own: { ...data.own, [key]: previous } };
      toasts.error(error instanceof Error ? error.message : "Fehler beim Speichern");
    } finally {
      saving = false;
    }
  }
</script>

{#if data !== null && rows.length > 0}
  <Card class="settings-card reminder-card">
    <h3 class="section-title">Erinnerungen</h3>

    {#each rows as row (row.key)}
      {@const id = `reminder-${row.key}`}
      <div class="reminder-toggle-row">
        <label class="reminder-toggle-label" for={id}>{row.label}</label>
        <input
          type="checkbox"
          {id}
          class="reminder-toggle-input"
          role="switch"
          checked={!(data?.own[row.key] ?? false)}
          disabled={saving}
          onchange={(event) => toggle(row.key, event.currentTarget.checked)}
        />
      </div>
    {/each}

    <p class="form-hint">{hint}</p>
  </Card>
{/if}

<style>
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  :global(.reminder-card) {
    margin-bottom: 1.5rem;
  }
  .reminder-toggle-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-height: 44px;
  }
  .reminder-toggle-label {
    flex: 1;
    font-size: 0.9375rem;
    cursor: pointer;
  }
  .reminder-toggle-input {
    appearance: none;
    -webkit-appearance: none;
    width: 2.75rem;
    height: 1.5rem;
    border-radius: 9999px;
    background: var(--border);
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .reminder-toggle-input::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bg-card);
    transition: transform 0.2s;
  }
  .reminder-toggle-input:checked {
    background: var(--brand);
  }
  .reminder-toggle-input:checked::after {
    transform: translateX(1.25rem);
  }
  .reminder-toggle-input:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .reminder-toggle-input:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .form-hint {
    margin-top: 0.5rem;
  }
</style>
