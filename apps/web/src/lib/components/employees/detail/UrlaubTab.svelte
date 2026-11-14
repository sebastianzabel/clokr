<!--
  UrlaubTab - the „Urlaub“ tab of the employee detail (Issue #854, plan 854-20): the per-person
  vacation entitlement of one year as one settings group with its own SaveBar
  (`PUT /settings/vacation/:employeeId`), and the entitlement figures as a KpiStrip.

  The figures come from the server: the balance (Verfügbar, Genommen, Genehmigt, Resturlaub) is the
  Resturlaub facade's answer (#451, Issue #940), labelled like the Urlaubsübersicht; the regular entitlement (classification-aware base value from
  resolveVacationBaseDays(), Issue #482, scaled to the contract workdays, hire-year pro-rata applied)
  and the statutory minimum (Issue #435, D-14). The client computes no entitlement. The carry-over
  reason and note are sent change-only against what the server last confirmed (#445 D-16), so an
  unrelated save never removes a legally protected carry-over deadline (T-451-26).

  The baseline is read once on purpose: it is the section's own snapshot afterwards, and a reload of
  the `entitlement` prop must not discard what was typed.

  Props:
    employeeId   the person
    year         the vacation year of the entitlement
    entitlement  the server's answer, or null when it could not be read
    canEdit      leave-entitlement:update (fields read-only without it; the API enforces it)
    changes      bindable, the number of unsaved changes (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { formatDays } from "$lib/leave/review-facts"; // #853-19: day figures with a decimal comma
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import Note from "$components/ui/Note.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import {
    VACATION_KEYS,
    reasonHint,
    vacationBody,
    vacationErrors,
    vacationValuesOf,
    type VacationEntitlement,
    type VacationValues,
  } from "$lib/employees/urlaub-form";
  import { CARRY_OVER_REASON_OPTIONS, carryOverReasonLabel } from "$lib/leave/carry-over-reason";
  import { countChanges, sectionErrors } from "$lib/settings/section-state";
  import { fmtDateDe } from "$lib/reports/period-format";
  import { formatDayCount } from "$lib/leave/leave-days-label";

  interface Props {
    employeeId: string;
    year: number;
    entitlement: VacationEntitlement | null;
    canEdit: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the page reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { employeeId, year, entitlement, canEdit, changes = $bindable() }: Props = $props();

  let snapshot = $state<VacationValues>(untrack(() => vacationValuesOf(entitlement)));
  let values = $state<VacationValues>(untrack(() => vacationValuesOf(entitlement)));
  // The pair last confirmed by the server: carryOverReasonPatch diffs against THIS, never against a
  // hardcoded default, so an unrelated save never sends an unintended null.
  let loadedReason = $state<string | null>(untrack(() => entitlement?.carryOverReason ?? null));
  let loadedNote = $state<string | null>(untrack(() => entitlement?.carryOverNote ?? null));
  let saving = $state(false);

  // The server's own figures; a missing answer reads as 0 and the form is not offered then.
  const suggestion = $derived(entitlement?.regularDays ?? 0);
  const minimum = $derived(entitlement?.statutoryMinimumDays ?? 0);
  const balance = $derived(entitlement?.balance ?? null);

  const changeCount = $derived(countChanges(snapshot, values, VACATION_KEYS));
  $effect(() => {
    changes = changeCount;
  });

  const liveErrors = $derived(vacationErrors(values));
  // An invalid value can only exist after an edit, so the messages show once the group has one.
  const shown = $derived(changeCount > 0 ? liveErrors : {});
  const hint = $derived(reasonHint(values));
  const belowMinimum = $derived(values.totalDays !== null && values.totalDays < minimum);

  const kpis = $derived([
    {
      label: `Regulärer Anspruch ${year}`,
      value: suggestion,
      unit: "Tage",
      explanation:
        "Basiswert der Person bzw. Unternehmensstandard, umgerechnet auf die Vertragstage, im Eintrittsjahr ggf. anteilig.",
    },
    {
      label: "Gesetzlicher Mindesturlaub",
      value: minimum,
      unit: "Tage",
    },
    ...(balance
      ? [
          // Issue #940: the facade's figures under the Urlaubsübersicht's own column names.
          {
            label: "Verfügbar",
            value: balance.availableDays,
            format: formatDays,
            unit: "Tage",
            explanation: `Anspruch + wirksamer Übertrag (${formatDays(balance.carriedOverEffectiveDays)})`,
          },
          {
            label: "Genommen",
            value: balance.takenDays,
            format: formatDays,
            unit: "Tage",
            explanation: `bis ${fmtDateDe(balance.splitAsOf)}`,
          },
          {
            label: "Genehmigt",
            value: balance.approvedUpcomingDays,
            format: formatDays,
            unit: "Tage",
            explanation: "noch nicht genommen",
          },
          {
            label: "Resturlaub",
            value: balance.remainingDays,
            format: formatDays,
            unit: "Tage",
            explanation: "Verfügbar − Genommen − Genehmigt",
          },
        ]
      : []),
  ]);

  // The select's „Kein Grund“ option carries "" (a native select cannot bind an option to null).
  function setReason(value: string) {
    values.carryOverReason = value === "" ? null : value;
  }

  async function saveVacation() {
    if (Object.values(liveErrors).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      await api.put(
        `/settings/vacation/${employeeId}`,
        vacationBody(year, suggestion, values, { reason: loadedReason, note: loadedNote }),
      );
      loadedReason = values.carryOverReason;
      loadedNote = values.carryOverNote.trim() === "" ? null : values.carryOverNote.trim();
      snapshot = { ...values };
      toasts.success("Urlaubsanspruch gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = { ...snapshot };
  }
</script>

{#if !entitlement}
  <div role="alert">
    <Note tone="info">Der Urlaubsanspruch dieser Person konnte nicht geladen werden.</Note>
  </div>
{:else}
  <div class="urlaub-tab detail-form">
    <KpiStrip items={kpis} ariaLabel="Urlaubsanspruch {year}" />
    {#if balance && balance.carryOverKeptWithoutNoticeDays > 0 && entitlement.carryOverDeadline}
      <div data-testid="urlaub-carry-kept">
        <Note tone="info">
          Der Übertrag ({formatDayCount(balance.carryOverKeptWithoutNoticeDays)}) zählt weiter,
          obwohl die Frist am {fmtDateDe(String(entitlement.carryOverDeadline).slice(0, 10))} abgelaufen
          ist: Ohne dokumentierten Hinweis auf den drohenden Verfall verfällt Urlaub nicht (EuGH C-684/16).
        </Note>
      </div>
    {/if}

    <SettingsGroup
      title="Urlaubsanspruch {year}"
      description="Jahresurlaub, Übertrag und Verfalldatum. Jede Änderung wird protokolliert."
      changes={canEdit ? changeCount : 0}
      errors={sectionErrors(shown)}
      {saving}
      saveLabel="Urlaubsanspruch speichern"
      onSave={saveVacation}
      onDiscard={discard}
    >
      <div class="urlaub-pair">
        <FormField
          label="Urlaubstage gesamt"
          help={`Leer lassen für den automatischen Wert (${suggestion.toLocaleString("de-DE", { maximumFractionDigits: 2 })}).`}
          error={shown.totalDays}
        >
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="0"
              max="365"
              step="0.01"
              bind:value={values.totalDays}
              placeholder={String(suggestion)}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>

        <FormField label="Resturlaub Vorjahr" required error={shown.carriedOverDays}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="0"
              max="365"
              step="0.5"
              bind:value={values.carriedOverDays}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>
      {#if belowMinimum}
        <Note tone="bad">
          Unter dem gesetzlichen Mindesturlaub – das Speichern wird abgelehnt, sofern sich der Wert
          ändert.
        </Note>
      {/if}

      <div class="urlaub-pair">
        <FormField label="Resturlaub verfällt am" help="Leer lassen für die globale Einstellung.">
          {#snippet field({ id, describedBy, invalid })}
            <DatePicker
              bind:value={values.carryOverDeadline}
              label="Resturlaub verfällt am"
              {id}
              {describedBy}
              {invalid}
              disabled={!canEdit}
            />
          {/snippet}
        </FormField>

        <FormField label="Übertragsgrund">
          {#snippet field({ id, describedBy })}
            <select
              {id}
              class="form-input"
              bind:value={() => values.carryOverReason ?? "", setReason}
              disabled={!canEdit}
              aria-describedby={describedBy}
            >
              <option value="">Kein Grund</option>
              {#each CARRY_OVER_REASON_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
              {#if values.carryOverReason !== null && !CARRY_OVER_REASON_OPTIONS.some((o) => o.value === values.carryOverReason)}
                <!-- Issue #451 (D-09): a legacy stored value (e.g. OPERATIONAL) is shown, read-only,
                   instead of being silently replaced by „Kein Grund“. -->
                <option value={values.carryOverReason} disabled selected
                  >{carryOverReasonLabel(values.carryOverReason)}</option
                >
              {/if}
            </select>
          {/snippet}
        </FormField>
      </div>

      <FormField
        label="Notiz zum Übertrag"
        help={hint && !shown.note ? hint : undefined}
        error={shown.note}
      >
        {#snippet field({ id, describedBy, invalid })}
          <textarea
            {id}
            class="form-input"
            rows="2"
            maxlength="500"
            bind:value={values.carryOverNote}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          ></textarea>
        {/snippet}
      </FormField>
    </SettingsGroup>
  </div>
{/if}

<style>
  /* Two fields side by side (the prototype's form row), one column on a phone; the group is the
     container (.detail-form). */
  .urlaub-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--s-4);
  }

  @container (min-width: 520px) {
    .urlaub-pair {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
