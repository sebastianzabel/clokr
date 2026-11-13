<!--
  UrlaubPanel - the „Urlaub“ tab of Verwalten › Regeln › Abwesenheiten (Issue #854, D-854-03): the overview
  figures and the four settings sections of the former Urlaubsverwaltung that concern vacation, sick leave and
  the two year-end days. Every setting lives exactly once (lib/settings/settings-pages.ts). Each section keeps
  its own snapshot, shows its own SaveBar and sends only its own registry keys to `PUT /settings/work` (#878,
  D-854-04); there is no page-wide save.

  Props:
    config  - the loaded `GET /settings/work` answer
    changes - bindable, the number of unsaved changes of all four sections (the page sums it into markUnsaved)
    onSaved - called with the saved values after every successful save, so the overview figures follow
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    ADVANCE_MONTHS_MAX,
    APPRENTICE_DAYS_MIN,
    HOLIDAY_RULES,
    HOLIDAY_YEAR_MAX,
    HOLIDAY_YEAR_MIN,
    KARENZ_DAYS_MAX,
    LEAD_TIME_MAX,
    VACATION_DAYS_MAX,
    VACATION_DAYS_MIN,
    anspruchFrom,
    anspruchMessages,
    anspruchWire,
    antraegeFrom,
    antraegeMessages,
    antraegeWire,
    carryOverLabel,
    feiertageFrom,
    feiertageMessages,
    feiertageWire,
    holidayRulesSummary,
    krankheitFrom,
    krankheitMessages,
    krankheitWire,
    messageCount,
    partTimeDays,
    uebertragFrom,
    type AbwesenheitenConfig,
    type AnspruchField,
    type AnspruchValues,
    type AntraegeField,
    type AntraegeValues,
    type FeiertageField,
    type FeiertageValues,
    type KrankheitField,
    type KrankheitValues,
  } from "$lib/settings/abwesenheiten";

  interface Props {
    config: AbwesenheitenConfig;
    changes?: number;
    onSaved?: (saved: Partial<AbwesenheitenConfig>) => void;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, changes = $bindable(0), onSaved }: Props = $props();

  // ── Urlaubsanspruch ──────────────────────────────────────────────────────────────────────────
  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let anspruchSnapshot = $state<AnspruchValues>(untrack(() => anspruchFrom(config)));
  let anspruch = $state<AnspruchValues>(untrack(() => anspruchFrom(config)));
  let anspruchSaving = $state(false);
  const anspruchChanges = $derived(
    countChanges(
      anspruchSnapshot,
      anspruch,
      settingsSection("abwesenheiten-anspruch").keys as readonly AnspruchField[],
    ),
  );
  const anspruchMsg = $derived(anspruchMessages(anspruch));

  async function saveAnspruch() {
    if (messageCount(anspruchMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    anspruchSaving = true;
    try {
      const wire = anspruchWire(anspruch) as Record<string, unknown>;
      await api.put(
        "/settings/work",
        pickSection(wire, settingsSection("abwesenheiten-anspruch").keys),
      );
      anspruchSnapshot = $state.snapshot(anspruch);
      onSaved?.(
        pickSection(
          wire,
          settingsSection("abwesenheiten-anspruch").keys,
        ) as Partial<AbwesenheitenConfig>,
      );
      toasts.success("Urlaubsanspruch gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      anspruchSaving = false;
    }
  }

  function discardAnspruch() {
    anspruch = $state.snapshot(anspruchSnapshot);
  }

  // ── Urlaubsanträge ───────────────────────────────────────────────────────────────────────────
  let antraegeSnapshot = $state<AntraegeValues>(untrack(() => antraegeFrom(config)));
  let antraege = $state<AntraegeValues>(untrack(() => antraegeFrom(config)));
  let antraegeSaving = $state(false);
  const antraegeChanges = $derived(
    countChanges(
      antraegeSnapshot,
      antraege,
      settingsSection("abwesenheiten-antraege").keys as readonly AntraegeField[],
    ),
  );
  const antraegeMsg = $derived(antraegeMessages(antraege));

  async function saveAntraege() {
    if (messageCount(antraegeMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    antraegeSaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          antraegeWire(antraege) as Record<string, unknown>,
          settingsSection("abwesenheiten-antraege").keys,
        ),
      );
      antraegeSnapshot = $state.snapshot(antraege);
      toasts.success("Urlaubsanträge gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      antraegeSaving = false;
    }
  }

  function discardAntraege() {
    antraege = $state.snapshot(antraegeSnapshot);
  }

  // ── Krankmeldung ─────────────────────────────────────────────────────────────────────────────
  let krankheitSnapshot = $state<KrankheitValues>(untrack(() => krankheitFrom(config)));
  let krankheit = $state<KrankheitValues>(untrack(() => krankheitFrom(config)));
  let krankheitSaving = $state(false);
  const krankheitChanges = $derived(
    countChanges(
      krankheitSnapshot,
      krankheit,
      settingsSection("abwesenheiten-krankheit").keys as readonly KrankheitField[],
    ),
  );
  const krankheitMsg = $derived(krankheitMessages(krankheit));

  async function saveKrankheit() {
    if (messageCount(krankheitMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    krankheitSaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          krankheitWire(krankheit) as Record<string, unknown>,
          settingsSection("abwesenheiten-krankheit").keys,
        ),
      );
      krankheitSnapshot = $state.snapshot(krankheit);
      toasts.success("Krankmeldung gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      krankheitSaving = false;
    }
  }

  function discardKrankheit() {
    krankheit = $state.snapshot(krankheitSnapshot);
  }

  // ── Heiligabend und Silvester ────────────────────────────────────────────────────────────────
  let feiertageSnapshot = $state<FeiertageValues>(untrack(() => feiertageFrom(config)));
  let feiertage = $state<FeiertageValues>(untrack(() => feiertageFrom(config)));
  let feiertageSaving = $state(false);
  const feiertageChanges = $derived(
    countChanges(
      feiertageSnapshot,
      feiertage,
      settingsSection("abwesenheiten-feiertage").keys as readonly FeiertageField[],
    ),
  );
  const feiertageMsg = $derived(feiertageMessages(feiertage));

  async function saveFeiertage() {
    if (messageCount(feiertageMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    feiertageSaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          feiertageWire(feiertage) as Record<string, unknown>,
          settingsSection("abwesenheiten-feiertage").keys,
        ),
      );
      feiertageSnapshot = $state.snapshot(feiertage);
      toasts.success("Feiertagsregeln gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      feiertageSaving = false;
    }
  }

  function discardFeiertage() {
    feiertage = $state.snapshot(feiertageSnapshot);
  }

  $effect(() => {
    changes = anspruchChanges + antraegeChanges + krankheitChanges + feiertageChanges;
  });

  // The overview follows what is stored (the saved snapshot), not what is being typed. The carry-over
  // deadline is read from the parent's merged config because its section lives on the Übertrag tab.
  const kpiItems = $derived([
    {
      label: "Jahresurlaub (Standard)",
      value: String(anspruchSnapshot.defaultVacationDays ?? ""),
      unit: "Tage",
      explanation: "Basis einer 5-Tage-Woche",
      testId: "abwesenheiten-kpi-days",
    },
    {
      label: "Resturlaub verfällt am",
      value: carryOverLabel(
        uebertragFrom(config).carryOverDeadlineDay,
        uebertragFrom(config).carryOverDeadlineMonth,
      ),
      explanation: "des Folgejahres",
      testId: "abwesenheiten-kpi-carryover",
    },
  ]);
</script>

<KpiStrip items={kpiItems} ariaLabel="Eckdaten der Urlaubsregeln" />

<p class="vac-pointer">
  Individuelle Urlaubs- und Arbeitszeiteinstellungen einer Person legst du in ihrem
  <a href="/verwalten/personen">Profil unter Verwalten › Personen</a> fest.
</p>

<SettingsGroup
  title="Urlaubsanspruch"
  description="Jahresurlaub und gesetzlicher Mindesturlaub (BUrlG)."
  changes={anspruchChanges}
  errors={messageCount(anspruchMsg)}
  saving={anspruchSaving}
  saveLabel="Urlaubsanspruch speichern"
  onSave={saveAnspruch}
  onDiscard={discardAnspruch}
>
  <FormField
    label="Jahresurlaub (Basis 5-Tage-Woche)"
    help={`Teilzeit anteilig (4-Tage-Woche → ${partTimeDays(anspruch.defaultVacationDays)} Tage).`}
    error={anspruchMsg.defaultVacationDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min={VACATION_DAYS_MIN}
        max={VACATION_DAYS_MAX}
        step="0.5"
        bind:value={anspruch.defaultVacationDays}
        disabled={anspruchSaving}
        data-testid="abwesenheiten-anspruch-days"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
  <FormField
    label="Urlaubstage Azubis (Basis 5-Tage-Woche)"
    help="Gilt für Auszubildende ohne eigenen Wert und wird beim Anlegen vorgeschlagen. Wirkt auf künftig angelegte Urlaubsjahre; bestehende Ansprüche bleiben unverändert. Mindestens 20 Tage (§ 3 BUrlG); Jugendliche erhalten automatisch den höheren Mindesturlaub nach § 19 JArbSchG."
    error={anspruchMsg.defaultApprenticeVacationDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min={APPRENTICE_DAYS_MIN}
        max={VACATION_DAYS_MAX}
        step="0.5"
        bind:value={anspruch.defaultApprenticeVacationDays}
        disabled={anspruchSaving}
        data-testid="abwesenheiten-anspruch-apprentice-days"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
  <ToggleField
    bind:checked={anspruch.autoCalcPartTimeVacation}
    label="Teilzeit-Urlaub automatisch anteilig berechnen"
    help="Pro-rata-Berechnung nach BUrlG anhand der Arbeitstage pro Woche."
    disabled={anspruchSaving}
    testid="abwesenheiten-anspruch-parttime"
  />
  {#if anspruch.autoCalcPartTimeVacation}
    <FormField label="Vollzeit-Arbeitstage pro Woche">
      {#snippet field({ id, describedBy })}
        <select
          {id}
          class="form-input vac-narrow"
          bind:value={anspruch.fullTimeWorkDaysPerWeek}
          disabled={anspruchSaving}
          data-testid="abwesenheiten-anspruch-fulltime-days"
          aria-describedby={describedBy}
        >
          <option value={5}>5 Tage (Mo–Fr)</option>
          <option value={6}>6 Tage (Mo–Sa)</option>
        </select>
      {/snippet}
    </FormField>
  {/if}
  <ToggleField
    bind:checked={anspruch.enforceMinVacation}
    label="Gesetzlichen Mindesturlaub durchsetzen"
    help="Warnung, wenn der Mindesturlaub (§ 7 BUrlG) nicht genommen wurde."
    disabled={anspruchSaving}
    testid="abwesenheiten-anspruch-minimum"
  />
</SettingsGroup>

<SettingsGroup
  title="Urlaubsanträge"
  description="Wie früh und wie weit im Voraus Urlaub beantragt werden kann."
  changes={antraegeChanges}
  errors={messageCount(antraegeMsg)}
  saving={antraegeSaving}
  saveLabel="Urlaubsanträge speichern"
  onSave={saveAntraege}
  onDiscard={discardAntraege}
>
  <FormField
    label="Vorlaufzeit (Tage)"
    help="0 = keine Vorlaufzeit. Gilt nicht für Krankmeldungen."
    error={antraegeMsg.vacationLeadTimeDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min="0"
        max={LEAD_TIME_MAX}
        step="1"
        bind:value={antraege.vacationLeadTimeDays}
        disabled={antraegeSaving}
        data-testid="abwesenheiten-antraege-lead"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
  <FormField
    label="Maximale Vorausbuchung (Monate)"
    help="0 = unbegrenzt."
    error={antraegeMsg.vacationMaxAdvanceMonths}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min="0"
        max={ADVANCE_MONTHS_MAX}
        step="1"
        bind:value={antraege.vacationMaxAdvanceMonths}
        disabled={antraegeSaving}
        data-testid="abwesenheiten-antraege-advance"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
  <ToggleField
    bind:checked={antraege.halfDayAllowed}
    label="Halbe Tage erlauben"
    disabled={antraegeSaving}
    testid="abwesenheiten-antraege-halfday"
  />
  <ToggleField
    bind:checked={antraege.leavePlanDeadlineLocksWishes}
    label="Planungsfrist sperrt eigene Änderungen"
    help="Ist eine Planungsfrist gesetzt, können Mitarbeitende ihre eigenen Wünsche danach nicht mehr ändern. Planungsberechtigte können weiter ändern."
    disabled={antraegeSaving}
    testid="abwesenheiten-antraege-plan-lock"
  />
</SettingsGroup>

<SettingsGroup
  title="Krankmeldung"
  description="Wer eine Krankmeldung einträgt und ab wann ein Nachweis dokumentiert wird (EFZG)."
  changes={krankheitChanges}
  errors={messageCount(krankheitMsg)}
  saving={krankheitSaving}
  saveLabel="Krankmeldung speichern"
  onSave={saveKrankheit}
  onDiscard={discardKrankheit}
>
  <ToggleField
    bind:checked={krankheit.sickSelfReport}
    label="Mitarbeitende dürfen eine Krankmeldung selbst eintragen"
    disabled={krankheitSaving}
    testid="abwesenheiten-krankheit-selfreport"
  />
  <FormField
    label="Nachweispflicht nach (Kalendertagen)"
    help="§ 5 Abs. 1 EFZG – „länger als drei Kalendertage“. Standard: 3. 0 = ab dem ersten Tag. Gilt nur für die Nachweis-Dokumentation. Auf die Urlaubsgutschrift bei Krankheit im Urlaub (§ 9 BUrlG) hat dieser Wert keinen Einfluss – dort ist immer ein ärztliches Zeugnis erforderlich."
    error={krankheitMsg.sickNoteRequiredAfterDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min="0"
        max={KARENZ_DAYS_MAX}
        step="1"
        bind:value={krankheit.sickNoteRequiredAfterDays}
        disabled={krankheitSaving}
        data-testid="abwesenheiten-krankheit-days"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
</SettingsGroup>

<SettingsGroup
  title="Heiligabend und Silvester"
  description="Ob der 24. und der 31. Dezember als Arbeitstag gelten oder ganz oder halb frei sind."
  changes={feiertageChanges}
  errors={messageCount(feiertageMsg)}
  saving={feiertageSaving}
  saveLabel="Feiertagsregeln speichern"
  onSave={saveFeiertage}
  onDiscard={discardFeiertage}
>
  <FormField label="Heiligabend (24.12.)">
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input"
        bind:value={feiertage.christmasEveRule}
        disabled={feiertageSaving}
        data-testid="abwesenheiten-feiertage-christmas"
        aria-describedby={describedBy}
      >
        {#each HOLIDAY_RULES as rule (rule.value)}
          <option value={rule.value}>{rule.label}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>
  <FormField label="Silvester (31.12.)">
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input"
        bind:value={feiertage.newYearsEveRule}
        disabled={feiertageSaving}
        data-testid="abwesenheiten-feiertage-newyears"
        aria-describedby={describedBy}
      >
        {#each HOLIDAY_RULES as rule (rule.value)}
          <option value={rule.value}>{rule.label}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>
  <FormField
    label="Gültig ab Jahr"
    help={holidayRulesSummary(feiertage)}
    error={feiertageMsg.holidayRulesValidFromYear}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input vac-narrow"
        type="number"
        min={HOLIDAY_YEAR_MIN}
        max={HOLIDAY_YEAR_MAX}
        step="1"
        bind:value={feiertage.holidayRulesValidFromYear}
        disabled={feiertageSaving}
        data-testid="abwesenheiten-feiertage-year"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
</SettingsGroup>

<style>
  .vac-pointer {
    margin: var(--s-4) 0 var(--s-6);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .vac-pointer a {
    color: var(--brand);
    font-weight: 600;
    text-decoration: underline;
  }

  .vac-narrow {
    max-width: 9rem;
  }
</style>
