<!--
  PersonTab - the „Person“ tab of the employee detail (Issue #854, plan 854-20): the former
  „Stammdaten“ tab as four groups on the blocks.

    Persönliche Daten        firstName, lastName, employeeNumber, birthDate, nfcCardId
    Personalstruktur         classification, coverageWeight, requiresSupervision
    Austritt und Urlaubsbasis exitDate, annualVacationDays
    Zeiterfassungs-Pflicht   the § 18 ArbZG exemption (confirm dialog, instant write)

  Each of the first three groups owns its snapshot and its SaveBar and sends exactly its own keys in
  one `PATCH /employees/:id` (D-854-04, #878). The page sums `changes` into ONE `markUnsaved` call
  and takes the saved values over through `onSaved`. The baseline is read once on purpose: a reload
  of the `employee` prop after another tab saved must not discard what was typed here.

  The server decides every rule (statutory vacation minimum, unique employee number, pro-rata
  warning); the checks here only save a round trip. Presentation only: the fields follow
  employee:update, the API refuses anything else on its own.

  Props:
    employee                          the stored record
    canEdit                           employee:update (fields read-only without it)
    tenantDefaultVacationDays         Unternehmensstandard for the placeholder
    tenantDefaultApprenticeVacationDays  Azubi-Standard for the placeholder
    changes                           bindable, number of unsaved changes of the three groups
    onSaved                           called with the keys a PATCH wrote
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    CLASSIFICATION_LABELS,
    CLASSIFICATION_OPTIONS,
    isOverridden,
  } from "$lib/employee-classification";
  import {
    EMPLOYMENT_KEYS,
    IDENTITY_KEYS,
    STRUCTURE_KEYS,
    employmentErrors,
    employmentPatch,
    identityErrors,
    identityPatch,
    personValuesOf,
    structureDefaultsFor,
    structureErrors,
    structurePatch,
    type PersonEmployee,
    type PersonValues,
  } from "$lib/employees/person-form";
  import { countChanges, pickSection, sectionErrors } from "$lib/settings/section-state";
  import {
    MISSING_BIRTH_DATE_HINT,
    statutoryMinimumFiveDayWeek,
  } from "$lib/statutory-minimum-vacation";
  import { vacationBaseDefaultPlaceholder } from "$lib/vacation-base-default";

  interface Props {
    employee: PersonEmployee;
    canEdit: boolean;
    tenantDefaultVacationDays: number;
    tenantDefaultApprenticeVacationDays: number;
    changes?: number;
    onSaved?: (written: Partial<PersonEmployee>) => void;
  }

  let {
    employee,
    canEdit,
    tenantDefaultVacationDays,
    tenantDefaultApprenticeVacationDays,
    // `changes` is write-only here: the page reads it through `bind:changes`.
    // eslint-disable-next-line no-useless-assignment
    changes = $bindable(),
    onSaved,
  }: Props = $props();

  let snapshot = $state<PersonValues>(untrack(() => personValuesOf(employee)));
  let values = $state<PersonValues>(untrack(() => personValuesOf(employee)));

  let savingIdentity = $state(false);
  let savingStructure = $state(false);
  let savingEmployment = $state(false);

  const identityChanges = $derived(countChanges(snapshot, values, IDENTITY_KEYS));
  const structureChanges = $derived(countChanges(snapshot, values, STRUCTURE_KEYS));
  const employmentChanges = $derived(countChanges(snapshot, values, EMPLOYMENT_KEYS));
  $effect(() => {
    changes = identityChanges + structureChanges + employmentChanges;
  });

  // An invalid value can only exist after an edit, so the messages show once the group has one.
  const identityLive = $derived(identityErrors(values));
  const structureLive = $derived(structureErrors(values));
  const employmentLive = $derived(employmentErrors(values));
  const identityShown = $derived(identityChanges > 0 ? identityLive : {});
  const structureShown = $derived(structureChanges > 0 ? structureLive : {});
  const employmentShown = $derived(employmentChanges > 0 ? employmentLive : {});

  const coverageOverridden = $derived(
    isOverridden(values.classification, "coverageWeight", values.coverageWeight ?? Number.NaN),
  );
  const supervisionOverridden = $derived(
    isOverridden(values.classification, "requiresSupervision", values.requiresSupervision),
  );

  // Issue #435 (D-12): an AZUBI without a birth date on file cannot be checked against the legal minimum.
  const azubiMissingBirthDate = $derived(values.classification === "AZUBI" && !values.birthDate);
  // Issue #435 (D-13): below the statutory minimum of the CURRENT year (display only, the server guards).
  const vacationMinimum = $derived(
    statutoryMinimumFiveDayWeek(values.birthDate, new Date().getFullYear()),
  );
  const belowMinimum = $derived(
    values.annualVacationDays !== null && values.annualVacationDays < vacationMinimum.days,
  );

  function onClassificationChange() {
    const defaults = structureDefaultsFor(values.classification);
    values.coverageWeight = defaults.coverageWeight;
    values.requiresSupervision = defaults.requiresSupervision;
  }

  function resetCoverage() {
    values.coverageWeight = structureDefaultsFor(values.classification).coverageWeight;
  }

  function resetSupervision() {
    values.requiresSupervision = structureDefaultsFor(values.classification).requiresSupervision;
  }

  /** Takes the keys a PATCH wrote as the new baseline and tells the page. */
  function adopt(
    keys: readonly (keyof PersonValues)[],
    written: PersonValues,
    onWire: Partial<PersonEmployee>,
  ) {
    const next = pickSection(written, keys);
    snapshot = { ...snapshot, ...next };
    values = { ...values, ...next };
    onSaved?.(onWire);
  }

  async function patchEmployee(body: object) {
    return api.patch<{ proRataWarning?: { message: string } }>(`/employees/${employee.id}`, body);
  }

  async function saveIdentity() {
    if (Object.values(identityLive).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingIdentity = true;
    try {
      const body = identityPatch(values);
      await patchEmployee(body);
      adopt(
        IDENTITY_KEYS,
        {
          ...values,
          firstName: body.firstName,
          lastName: body.lastName,
          employeeNumber: body.employeeNumber,
          nfcCardId: body.nfcCardId ?? "",
        },
        body,
      );
      toasts.success("Persönliche Daten gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      savingIdentity = false;
    }
  }

  async function saveStructure() {
    if (Object.values(structureLive).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingStructure = true;
    try {
      const body = structurePatch(values);
      await patchEmployee(body);
      adopt(STRUCTURE_KEYS, values, body);
      toasts.success("Personalstruktur gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      savingStructure = false;
    }
  }

  async function saveEmployment() {
    if (Object.values(employmentLive).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingEmployment = true;
    try {
      const body = employmentPatch(values);
      const res = await patchEmployee(body);
      adopt(EMPLOYMENT_KEYS, values, body);
      toasts.success("Austritt und Urlaubsbasis gespeichert.");
      if (res.proRataWarning) toasts.warning(res.proRataWarning.message, 8000);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      savingEmployment = false;
    }
  }

  function discardIdentity() {
    values = { ...values, ...pickSection(snapshot, IDENTITY_KEYS) };
  }

  function discardStructure() {
    values = { ...values, ...pickSection(snapshot, STRUCTURE_KEYS) };
  }

  function discardEmployment() {
    values = { ...values, ...pickSection(snapshot, EMPLOYMENT_KEYS) };
  }

  // ── § 18 ArbZG exemption (Phase 76.7, UI-V19-04a) ──────────────────────────────────────────
  // The toggle only STAGES the change and opens the ConfirmDialog; the PATCH fires from
  // `confirmExemptToggle()`. Cancelling (or a refused PATCH) reverts the checkbox to the last
  // server-confirmed value.
  let exempt = $state(untrack(() => employee.isTimeTrackingExempt === true));
  let confirmedExempt = $state(untrack(() => employee.isTimeTrackingExempt === true));
  let intendedExempt = $state(false);
  let exemptConfirmOpen = $state(false);

  function onExemptToggleChange() {
    if (exempt === confirmedExempt) return;
    intendedExempt = exempt;
    exemptConfirmOpen = true;
  }

  async function confirmExemptToggle() {
    try {
      await api.patch(`/employees/${employee.id}`, { isTimeTrackingExempt: intendedExempt });
      confirmedExempt = intendedExempt;
      exempt = intendedExempt;
      onSaved?.({ isTimeTrackingExempt: intendedExempt });
      toasts.success("Befreiung aktualisiert.");
    } catch (err) {
      exempt = confirmedExempt;
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    }
  }

  function cancelExemptToggle() {
    exempt = confirmedExempt;
    intendedExempt = confirmedExempt;
  }

  // OFF -> ON exempts the person, ON -> OFF subjects them to time tracking again.
  const exemptDialogDescription = $derived(
    `Du bist dabei, die Zeiterfassungs-Pflicht für ${employee.firstName} ${employee.lastName} zu ${
      intendedExempt ? "befreien" : "unterstellen"
    }. Diese Änderung wird im Audit-Log protokolliert. Hinweis: Urlaubsanspruch nach BUrlG bleibt unverändert.`,
  );
</script>

<div class="person-tab detail-form">
  <SettingsGroup
    title="Persönliche Daten"
    description="Name, Mitarbeiter-Nr., Geburtsdatum und NFC-Karte."
    changes={canEdit ? identityChanges : 0}
    errors={sectionErrors(identityShown)}
    saving={savingIdentity}
    saveLabel="Persönliche Daten speichern"
    onSave={saveIdentity}
    onDiscard={discardIdentity}
  >
    <div class="pt-grid">
      <FormField label="Vorname" required error={identityShown.firstName}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.firstName}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <FormField label="Nachname" required error={identityShown.lastName}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.lastName}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <FormField label="Mitarbeiter-Nr." required error={identityShown.employeeNumber}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.employeeNumber}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <FormField
        label="NFC-Karten-ID"
        help="Optional. Ermöglicht das Stempeln per NFC-Karte."
        error={identityShown.nfcCardId}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="text"
            bind:value={values.nfcCardId}
            placeholder="z. B. NFC-A1B2C3D4"
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Geburtsdatum"
        help="Optional. Für Personen unter 18 Jahren gelten bei den Pausen die Regeln nach § 11 JArbSchG: mehr als 4,5 Stunden 30 Min, mehr als 6 Stunden 60 Min."
      >
        {#snippet field({ id, describedBy, invalid })}
          <DatePicker
            bind:value={values.birthDate}
            label="Geburtsdatum"
            {id}
            {describedBy}
            {invalid}
            disabled={!canEdit}
          />
        {/snippet}
      </FormField>
    </div>
    {#if azubiMissingBirthDate}
      <Note tone="warn">{MISSING_BIRTH_DATE_HINT}</Note>
    {/if}
  </SettingsGroup>

  <SettingsGroup
    title="Personalstruktur"
    description="Die Personalkategorie bringt Standardwerte für Schicht-Gewicht und Aufsichtspflicht mit; du kannst beide einzeln überschreiben."
    changes={canEdit ? structureChanges : 0}
    errors={sectionErrors(structureShown)}
    saving={savingStructure}
    saveLabel="Personalstruktur speichern"
    onSave={saveStructure}
    onDiscard={discardStructure}
  >
    <div class="pt-grid">
      <FormField label="Personalkategorie">
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input"
            bind:value={values.classification}
            onchange={onClassificationChange}
            disabled={!canEdit}
            aria-describedby={describedBy}
          >
            {#each CLASSIFICATION_OPTIONS as option (option)}
              <option value={option}>{CLASSIFICATION_LABELS[option]}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>

      <div class="person-override">
        <FormField label="Schicht-Gewicht" error={structureShown.coverageWeight}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="0"
              max="9.99"
              step="0.05"
              bind:value={values.coverageWeight}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        {#if coverageOverridden && canEdit}
          <div class="person-override-row">
            <Chip tone="warn">Manuell überschrieben</Chip>
            <button type="button" class="btn btn-ghost btn-sm" onclick={resetCoverage}>
              Auf Standard zurück
            </button>
          </div>
        {/if}
      </div>
    </div>

    <div class="person-override">
      <ToggleField
        bind:checked={values.requiresSupervision}
        label="Aufsichtspflichtig"
        disabled={!canEdit}
      />
      {#if supervisionOverridden && canEdit}
        <div class="person-override-row">
          <Chip tone="warn">Manuell überschrieben</Chip>
          <button type="button" class="btn btn-ghost btn-sm" onclick={resetSupervision}>
            Auf Standard zurück
          </button>
        </div>
      {/if}
    </div>
  </SettingsGroup>

  <SettingsGroup
    title="Austritt und Urlaubsbasis"
    description="Das Austrittsdatum beendet das Beschäftigungsverhältnis. Die Urlaubsbasis gilt für künftige Urlaubsjahre."
    changes={canEdit ? employmentChanges : 0}
    errors={sectionErrors(employmentShown)}
    saving={savingEmployment}
    saveLabel="Austritt und Urlaubsbasis speichern"
    onSave={saveEmployment}
    onDiscard={discardEmployment}
  >
    <div class="pt-grid">
      <FormField
        label="Austrittsdatum"
        help="Optional. Bei gesetztem Datum wird der Jahresurlaub anteilig berechnet (§ 5 Abs. 2 BUrlG). Die Person bleibt mit allen Daten sichtbar, der Zugang zur App bleibt aktiv, bis er gesondert gesperrt wird."
      >
        {#snippet field({ id, describedBy, invalid })}
          <DatePicker
            bind:value={values.exitDate}
            label="Austrittsdatum"
            {id}
            {describedBy}
            {invalid}
            disabled={!canEdit}
          />
        {/snippet}
      </FormField>

      <FormField
        label="Urlaubstage pro Jahr (5-Tage-Woche)"
        help="Leer = Azubi-Standard für Auszubildende, sonst Unternehmensstandard (beides unter Regeln › Abwesenheiten). Gilt für künftige Urlaubsjahre; bestehende Ansprüche änderst du im Tab Urlaub (mit Protokoll)."
        error={employmentShown.annualVacationDays}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="0.5"
            max="365"
            step="0.01"
            bind:value={values.annualVacationDays}
            placeholder={vacationBaseDefaultPlaceholder(
              values.classification,
              tenantDefaultVacationDays,
              tenantDefaultApprenticeVacationDays,
            )}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    {#if belowMinimum}
      <Note tone="bad">
        Unter dem gesetzlichen Mindesturlaub von {vacationMinimum.days.toLocaleString("de-DE", {
          maximumFractionDigits: 2,
        })} Tagen ({vacationMinimum.law}) – das Speichern wird abgelehnt, sofern sich der Wert
        ändert.
      </Note>
    {/if}
  </SettingsGroup>

  {#if canEdit}
    <section class="settings-group" aria-labelledby="person-exempt-title">
      <h2 class="settings-group-title" id="person-exempt-title">Zeiterfassungs-Pflicht</h2>
      <p class="settings-group-desc">
        Inhaber, Geschäftsführer und leitende Angestellte sind nach § 18 ArbZG von der
        Arbeitszeiterfassung befreit. Der Urlaubsanspruch nach BUrlG bleibt bestehen. Die Änderung
        gilt sofort, nachdem du sie bestätigt hast.
      </p>
      <ToggleField
        bind:checked={exempt}
        label="Keine Zeiterfassungs-Pflicht (§ 18 ArbZG)"
        testid="exemption-toggle"
        onchange={onExemptToggleChange}
      />
    </section>

    <ConfirmDialog
      bind:open={exemptConfirmOpen}
      title="§ 18 ArbZG — Zeiterfassungs-Befreiung"
      description={exemptDialogDescription}
      confirmLabel="Bestätigen"
      onConfirm={confirmExemptToggle}
      onCancel={cancelExemptToggle}
    />
  {/if}
</div>

<style>
  /* The prototype's form rows: two fields side by side once the group is wide enough, one column on
     a phone. The group is the container, so the rule follows its width, not the viewport's. */
  .pt-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--s-4);
  }

  @container (min-width: 520px) {
    .pt-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .person-override {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }

  .person-override-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
  }
</style>
