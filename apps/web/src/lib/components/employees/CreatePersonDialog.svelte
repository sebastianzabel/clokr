<!--
  CreatePersonDialog - the guided "Person anlegen" flow (Issue #854, D-854-06, #581). Four steps:
  Person, Salon & Rolle, Vertrag, Einladung. "Weiter" validates the step (`validateStep`, shown as
  field messages and focus on the first one); the last step validates the whole draft and sends.

  The calls are those of the former single form, in the same order: ONE `POST /employees` (the body
  comes only from `employeeCreatePayload`, it carries no `role`), then one `POST /role-assignments`
  per role draft through `postAssignmentDrafts`. A refused draft keeps the person, says which role
  was not assigned and opens the person's tab „Berechtigungen“ (Issue #580, D-580-03). The server
  stays the authority for every rule; nothing here decides access.

  The contract of the new person starts on the Eintrittsdatum (any day, CLAUDE.md: a contract START
  is not a contract CHANGE); the Vertrag step says so. The Minijob hint is advisory (D-854-08).

  Props:
    open               - bindable
    onCreated          - called with the new employee's id as soon as the person exists
    roles, mandantRoleIds, people, roleChoicesFailed
                       - the role choices; the page loads them (it shares them with the bulk
                         role dialog), only for a holder of role-assignment:manage
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import { employeeAdminRights, salonAdminRights } from "$lib/page-rights";
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import PersonRoleAssignments from "$lib/components/admin/roles/PersonRoleAssignments.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import HomeSalonField from "$lib/components/employees/HomeSalonField.svelte";
  import type { AccessRole, AssignablePerson, AssignmentDraft } from "$lib/api/roles";
  import { CREATE_DEFAULT_ROLE_NAME, assignmentLabel } from "$lib/roles/assignment-label";
  import {
    berechtigungenTabHref,
    draftFailureMessage,
    draftLabel,
    draftsSavedMessage,
    postAssignmentDrafts,
  } from "$lib/roles/assignment-drafts";
  import {
    CLASSIFICATION_LABELS,
    CLASSIFICATION_OPTIONS,
    applyDefaults,
    isOverridden,
    type EmployeeClassification,
  } from "$lib/employee-classification";
  import { MISSING_BIRTH_DATE_HINT } from "$lib/statutory-minimum-vacation";
  import {
    homeSalonOptions,
    offerHomeSalonChoice,
    type SalonRef,
  } from "$lib/employees/salon-assignments";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import { minijobHint, minijobHintText } from "$lib/employees/minijob";
  import {
    CREATE_STEPS,
    CREATE_STEP_LABELS,
    SCHEDULE_TYPE_OPTIONS,
    emptyDraft,
    employeeCreatePayload,
    firstInvalidStep,
    statutoryMinimum,
    suggestedVacationDays,
    validateStep,
    type CreateContext,
    type CreatePersonDraft,
    type CreateScheduleType,
    type CreateStep,
    type StepErrors,
  } from "$lib/employees/create-person";

  interface Props {
    open: boolean;
    onCreated?: (employeeId: string) => void | Promise<void>;
    roles?: AccessRole[];
    mandantRoleIds?: string[];
    people?: AssignablePerson[];
    roleChoicesFailed?: boolean;
  }

  let {
    open = $bindable(false),
    onCreated,
    roles = [],
    mandantRoleIds = [],
    people = [],
    roleChoicesFailed = false,
  }: Props = $props();

  // Controls follow the caller's permissions (Issue #538); the API refuses anything beyond them.
  const canAssignRoles = $derived(employeeAdminRights($authStore.user).canAssignRoles);
  const canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  const canReadSalons = $derived(salonAdminRights($authStore.user).canRead);

  const FIXED_ROWS = [{ roleName: CREATE_DEFAULT_ROLE_NAME, scope: { type: "TENANT" as const } }];

  let step = $state<CreateStep>("person");
  let draft = $state<CreatePersonDraft>(emptyDraft(localCalendarDay()));
  let roleDrafts = $state<AssignmentDraft[]>([]);
  let errors = $state<StepErrors>({});
  let submitError = $state("");
  let creating = $state(false);
  // Issue #86 (AC-86-1): the salon list is read only for a caller who may list salons; null = not
  // available, then no field is offered and the server's own German error answers a missing Stammsalon.
  let salons = $state<SalonRef[] | null>(null);
  // Tenant defaults for the pre-fills (loaded on open): vacation Standards (#435, #482) and the
  // FLEXTIME core times (Phase 49.2).
  let tenantDefaultVacationDays = $state<number | null>(null);
  let tenantDefaultApprenticeVacationDays = $state<number | null>(null);
  let tenantDefaultCoreStart = $state("");
  let tenantDefaultCoreEnd = $state("");
  let tenantDefaultCoreDays = $state<number[]>([]);
  // The value the form itself last proposed for the vacation days; a typed value is never overwritten.
  let vacationPrefill: number | null = null;
  // Plain let: an older tenant-defaults response never overwrites a newer open.
  let openGeneration = 0;

  const stepIndex = $derived(CREATE_STEPS.indexOf(step));
  const isLastStep = $derived(stepIndex === CREATE_STEPS.length - 1);
  const ctx = $derived<CreateContext>({
    tenantDefaultVacationDays,
    tenantDefaultApprenticeVacationDays,
    homeSalonRequired:
      salons !== null && offerHomeSalonChoice(true, homeSalonOptions(salons).length),
  });
  const personName = $derived(`${draft.firstName} ${draft.lastName}`.trim() || "Neue Person");
  const labelCtx = $derived({
    salons: $salonContext.salons,
    salonsLoaded: $salonContext.loaded,
    people,
  });
  const weeklyType = $derived(draft.scheduleType !== "MONTHLY_HOURS");
  const minimum = $derived(statutoryMinimum(draft));
  const coverageOverridden = $derived(
    isOverridden(draft.classification, "coverageWeight", draft.coverageWeight),
  );
  const supervisionOverridden = $derived(
    isOverridden(draft.classification, "requiresSupervision", draft.requiresSupervision),
  );
  const minijob = $derived(
    minijobHint({
      classification: draft.classification,
      scheduleType: draft.scheduleType,
      weeklyHours: draft.weeklyHours,
      monthlyHours: draft.monthlyHours,
      validFrom: draft.hireDate,
    }),
  );

  async function loadSalons() {
    if (!canReadSalons) {
      salons = null;
      return;
    }
    try {
      const res = await api.get<{ salons: SalonRef[] }>("/salons");
      salons = res.salons;
    } catch {
      // Without the list no choice is offered; the API still answers a missing Stammsalon.
      salons = null;
    }
  }

  async function loadTenantDefaults(generation: number) {
    try {
      const cfg = await api.get<{
        defaultCoreStart?: string | null;
        defaultCoreEnd?: string | null;
        defaultCoreDays?: number[];
        defaultVacationDays?: number | string;
        defaultApprenticeVacationDays?: number | string;
      }>("/settings/work");
      if (generation !== openGeneration) return;
      tenantDefaultCoreStart = cfg.defaultCoreStart ?? "";
      tenantDefaultCoreEnd = cfg.defaultCoreEnd ?? "";
      tenantDefaultCoreDays = Array.isArray(cfg.defaultCoreDays) ? [...cfg.defaultCoreDays] : [];
      const vacation = Number(cfg.defaultVacationDays);
      tenantDefaultVacationDays = Number.isFinite(vacation) ? vacation : null;
      const apprentice = Number(cfg.defaultApprenticeVacationDays);
      tenantDefaultApprenticeVacationDays = Number.isFinite(apprentice) ? apprentice : null;
      refreshVacationPrefill();
    } catch {
      // non-critical: the pre-fills just do not happen
    }
  }

  // Proposes the classification's own Standard raised to the statutory minimum; never overwrites a
  // value the person typed (it only follows while the field still holds the form's own suggestion).
  function refreshVacationPrefill() {
    const next = suggestedVacationDays($state.snapshot(draft), ctx);
    if (draft.annualVacationDays === null || draft.annualVacationDays === vacationPrefill) {
      draft.annualVacationDays = next;
    }
    vacationPrefill = next;
  }

  function reset() {
    draft = emptyDraft(localCalendarDay());
    roleDrafts = [];
    errors = {};
    submitError = "";
    creating = false;
    step = "person";
    vacationPrefill = null;
    refreshVacationPrefill();
    const generation = ++openGeneration;
    void loadSalons();
    void loadTenantDefaults(generation);
  }

  // Start from a clean state each time the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(reset);
  });

  function onClassificationChange() {
    const defaults = applyDefaults(draft.classification);
    draft.coverageWeight = defaults.coverageWeight;
    draft.requiresSupervision = defaults.requiresSupervision;
    refreshVacationPrefill();
  }

  function onScheduleTypeChange(next: CreateScheduleType) {
    draft.scheduleType = next;
    // FLEXTIME: propose the tenant's core times while the fields are still empty (Phase 49.2).
    if (
      next === "FLEXTIME" &&
      !draft.coreStart &&
      !draft.coreEnd &&
      draft.coreDays.length === 0 &&
      (tenantDefaultCoreStart || tenantDefaultCoreEnd || tenantDefaultCoreDays.length > 0)
    ) {
      draft.coreStart = tenantDefaultCoreStart;
      draft.coreEnd = tenantDefaultCoreEnd;
      draft.coreDays = [...tenantDefaultCoreDays];
    }
  }

  /** Puts the focus on the first field that carries a message (after the messages are rendered). */
  async function focusFirstInvalid() {
    await tick();
    document.querySelector<HTMLElement>('.cp-body [aria-invalid="true"]')?.focus();
  }

  async function next() {
    const found = validateStep(step, $state.snapshot(draft), ctx);
    errors = found;
    if (Object.keys(found).length > 0) {
      await focusFirstInvalid();
      return;
    }
    step = CREATE_STEPS[stepIndex + 1];
    await tick();
    document.querySelector<HTMLElement>(".cp-body [data-autofocus]")?.focus();
  }

  function back() {
    errors = {};
    submitError = "";
    if (stepIndex > 0) step = CREATE_STEPS[stepIndex - 1];
  }

  async function submit() {
    const snapshot = $state.snapshot(draft);
    const invalid = firstInvalidStep(snapshot, ctx);
    if (invalid !== null) {
      step = invalid;
      errors = validateStep(invalid, snapshot, ctx);
      await focusFirstInvalid();
      return;
    }
    creating = true;
    submitError = "";
    let res: { id: string; userId: string; emailError?: string };
    try {
      res = await api.post("/employees", employeeCreatePayload(snapshot, ctx));
    } catch (e: unknown) {
      submitError = e instanceof Error ? e.message : "Fehler beim Anlegen";
      creating = false;
      return;
    }
    // The person exists from here on: whatever follows never rolls it back.
    try {
      draft.password = "";
      open = false;
      await onCreated?.(res.id);
      const drafts = $state.snapshot(roleDrafts);
      const refused = await postDrafts(res.userId, drafts);
      if (res.emailError) {
        toasts.error(
          `Person angelegt, aber die Einladungsmail konnte nicht gesendet werden: ${res.emailError}`,
        );
      } else if (!refused) {
        toasts.success(
          drafts.length > 0
            ? `Person angelegt. ${draftsSavedMessage(drafts.length)}.`
            : "Person angelegt.",
        );
      }
      if (refused) await goto(berechtigungenTabHref(res.id));
    } finally {
      creating = false;
    }
  }

  /** Posts the role drafts; true when one was refused (the admin is then handed over to the person's tab). */
  async function postDrafts(userId: string, drafts: AssignmentDraft[]): Promise<boolean> {
    if (drafts.length === 0) return false;
    try {
      const failures = await postAssignmentDrafts(userId, drafts);
      if (failures.length === 0) return false;
      toasts.error(
        draftFailureMessage(
          failures.map((f) => ({
            label: draftLabel(f.draft, roles, labelCtx),
            message: f.message,
          })),
        ),
        10000,
      );
    } catch {
      toasts.error(
        "Die Person ist angelegt, aber die Rollen konnten nicht zugewiesen werden. Weise sie im Tab „Berechtigungen“ zu.",
      );
    }
    return true;
  }

  function dayText(iso: string | null): string {
    if (!iso) return "";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }

  const homeSalonName = $derived(salons?.find((s) => s.id === draft.homeSalonId)?.name ?? "");
  const rolesSummary = $derived(
    [
      assignmentLabel({ roleName: CREATE_DEFAULT_ROLE_NAME, scope: { type: "TENANT" } }, labelCtx),
      ...roleDrafts.map((d) => draftLabel(d, roles, labelCtx)),
    ].join("; "),
  );
  const modelSummary = $derived(
    `${SCHEDULE_TYPE_OPTIONS.find((o) => o.value === draft.scheduleType)?.label ?? ""}, ${
      weeklyType
        ? `${draft.weeklyHours ?? 0} Std./Woche`
        : draft.monthlyHours
          ? `${draft.monthlyHours} Std./Monat`
          : "nur Zeiterfassung"
    }`,
  );
</script>

<Dialog bind:open title="Person anlegen" eyebrow="Mitarbeiter einladen" size="wide">
  <div class="cp-body" data-testid="create-person-dialog">
    <ol class="cp-steps" aria-label="Schritte">
      {#each CREATE_STEPS as s, i (s)}
        <li
          class="cp-step"
          class:cp-step--current={s === step}
          class:cp-step--done={i < stepIndex}
          aria-current={s === step ? "step" : undefined}
        >
          <span class="cp-step-no" aria-hidden="true">{i + 1}</span>
          <span class="cp-step-label">{CREATE_STEP_LABELS[s]}</span>
        </li>
      {/each}
    </ol>

    {#if submitError}
      <div role="alert"><Note tone="bad">{submitError}</Note></div>
    {/if}

    {#if step === "person"}
      <div class="cp-grid">
        <FormField label="Vorname" required error={errors.firstName}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="text"
              autocomplete="off"
              bind:value={draft.firstName}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
              data-autofocus
            />
          {/snippet}
        </FormField>
        <FormField label="Nachname" required error={errors.lastName}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="text"
              autocomplete="off"
              bind:value={draft.lastName}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <div class="cp-full">
          <FormField label="E-Mail-Adresse" required error={errors.email}>
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                class="form-input"
                type="email"
                autocomplete="off"
                bind:value={draft.email}
                aria-invalid={invalid ? "true" : undefined}
                aria-describedby={describedBy}
              />
            {/snippet}
          </FormField>
        </div>
        <FormField label="Personalnummer" required error={errors.employeeNumber}>
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="text"
              autocomplete="off"
              bind:value={draft.employeeNumber}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <FormField label="Eintrittsdatum" required error={errors.hireDate}>
          {#snippet field({ id, describedBy, invalid })}
            <DatePicker
              bind:value={draft.hireDate}
              label="Eintrittsdatum"
              {id}
              {describedBy}
              {invalid}
              onValueChange={refreshVacationPrefill}
            />
          {/snippet}
        </FormField>
        <FormField
          label="Geburtsdatum (optional)"
          help="Aus dem Alter ergibt sich der gesetzliche Mindesturlaub und der Jugendarbeitsschutz."
          error={errors.birthDate}
        >
          {#snippet field({ id, describedBy, invalid })}
            <DatePicker
              bind:value={draft.birthDate}
              label="Geburtsdatum"
              {id}
              {describedBy}
              {invalid}
              onValueChange={refreshVacationPrefill}
            />
          {/snippet}
        </FormField>
      </div>
    {:else if step === "salon-rolle"}
      <div class="cp-stack">
        <HomeSalonField {salons} bind:value={draft.homeSalonId} error={errors.homeSalonId} />
        {#if salons !== null && !ctx.homeSalonRequired}
          <Note tone="info">
            Bei nur einem aktiven Salon ordnet das System die Person diesem Salon zu. Weitere
            Einsatzsalons trägst du später bei der Person ein.
          </Note>
        {/if}
        <section class="cp-section" aria-labelledby="cp-roles-title">
          <h4 id="cp-roles-title" class="cp-section-title">Rollen</h4>
          {#if canAssignRoles}
            <PersonRoleAssignments
              {personName}
              bind:drafts={roleDrafts}
              fixedRows={FIXED_ROWS}
              {roles}
              {mandantRoleIds}
              salons={$salonContext.salons}
              salonsLoaded={$salonContext.loaded}
              {people}
              canManage={canAssignRoles}
              {canReadRoles}
              allowGrant={!roleChoicesFailed}
            />
            {#if roleChoicesFailed}
              <Note tone="warn">
                Rollen konnten nicht geladen werden. Weitere Rollen kannst du nach dem Anlegen im
                Tab „Berechtigungen“ zuweisen.
              </Note>
            {/if}
            <Note tone="info">
              Jede neue Person erhält die Rolle „{CREATE_DEFAULT_ROLE_NAME}“ für das ganze
              Unternehmen. Weitere Rollen werden gespeichert, sobald die Person angelegt ist.
            </Note>
          {:else}
            <Note tone="info">
              Jede neue Person erhält die Rolle „{CREATE_DEFAULT_ROLE_NAME}“ für das ganze
              Unternehmen. Weitere Rollen weist du nach dem Anlegen im Tab „Berechtigungen“ zu, wenn
              du Rollen vergeben darfst.
            </Note>
          {/if}
        </section>
      </div>
    {:else if step === "vertrag"}
      <div class="cp-stack">
        <Note tone="info">
          Der Vertrag beginnt am Eintrittsdatum. Spätere Änderungen am Vertrag gelten jeweils ab dem
          Ersten eines Monats.
        </Note>
        <div class="cp-grid">
          <FormField label="Arbeitszeitmodell" required>
            {#snippet field({ id, describedBy })}
              <select
                {id}
                class="form-input"
                value={draft.scheduleType}
                aria-describedby={describedBy}
                data-autofocus
                onchange={(e) => onScheduleTypeChange(e.currentTarget.value as CreateScheduleType)}
              >
                {#each SCHEDULE_TYPE_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            {/snippet}
          </FormField>
          {#if weeklyType}
            <FormField label="Wochenstunden" required error={errors.weeklyHours}>
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  class="form-input"
                  type="number"
                  min="0.5"
                  max="60"
                  step="0.5"
                  bind:value={draft.weeklyHours}
                  aria-invalid={invalid ? "true" : undefined}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
          {:else}
            <FormField
              label="Stunden pro Monat (optional)"
              help="Leer lassen: die Zeiten werden nur erfasst."
              error={errors.monthlyHours}
            >
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  class="form-input"
                  type="number"
                  min="0"
                  max="999"
                  step="0.5"
                  bind:value={draft.monthlyHours}
                  aria-invalid={invalid ? "true" : undefined}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
          {/if}
          {#if draft.scheduleType === "SHIFT_BASED"}
            <FormField
              label="Arbeitstage pro Woche"
              help="Vertragliche Anzahl Arbeitstage pro Woche. Welche Wochentage das konkret sind, bestimmt der Schichtplan."
              error={errors.contractWorkDays}
            >
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  class="form-input"
                  type="number"
                  min="1"
                  max="7"
                  step="1"
                  bind:value={draft.contractWorkDays}
                  aria-invalid={invalid ? "true" : undefined}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
            <div class="cp-full">
              <WeekdayPicker
                bind:value={draft.usualWorkDays}
                legend="Übliche Arbeitstage (Pflicht)"
                help="Pflicht bei Schichtbetrieb: mindestens so viele Tage wie Arbeitstage pro Woche. In angebrochenen Urlaubswochen zählen nur Urlaubstage an diesen Wochentagen; eine volle Urlaubswoche kostet immer die vertraglichen Arbeitstage."
                error={errors.usualWorkDays}
                testidPrefix="create-usual-workday"
              />
            </div>
          {/if}
          {#if draft.scheduleType === "FLEXTIME"}
            <FormField label="Kernzeitbeginn (optional)">
              {#snippet field({ id, describedBy })}
                <input
                  {id}
                  class="form-input"
                  type="time"
                  bind:value={draft.coreStart}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
            <FormField label="Kernzeitende (optional)">
              {#snippet field({ id, describedBy })}
                <input
                  {id}
                  class="form-input"
                  type="time"
                  bind:value={draft.coreEnd}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
            <div class="cp-full">
              <WeekdayPicker
                bind:value={draft.coreDays}
                legend="Kerntage (optional)"
                help="Leer lassen für reine Gleitzeit ohne Kernzeit."
                testidPrefix="create-core-day"
              />
            </div>
          {/if}
        </div>

        <section class="cp-section" aria-labelledby="cp-structure-title">
          <h4 id="cp-structure-title" class="cp-section-title">Personalstruktur und Urlaub</h4>
          <div class="cp-grid">
            <FormField label="Personalkategorie" required>
              {#snippet field({ id, describedBy })}
                <select
                  {id}
                  class="form-input"
                  value={draft.classification}
                  aria-describedby={describedBy}
                  onchange={(e) => {
                    draft.classification = e.currentTarget.value as EmployeeClassification;
                    onClassificationChange();
                  }}
                >
                  {#each CLASSIFICATION_OPTIONS as option (option)}
                    <option value={option}>{CLASSIFICATION_LABELS[option]}</option>
                  {/each}
                </select>
              {/snippet}
            </FormField>
            <div class="cp-field-with-extra">
              <FormField label="Schicht-Gewicht" error={errors.coverageWeight}>
                {#snippet field({ id, describedBy, invalid })}
                  <input
                    {id}
                    class="form-input"
                    type="number"
                    min="0"
                    max="9.99"
                    step="0.05"
                    bind:value={draft.coverageWeight}
                    aria-invalid={invalid ? "true" : undefined}
                    aria-describedby={describedBy}
                  />
                {/snippet}
              </FormField>
              {#if coverageOverridden}
                <div class="cp-override">
                  <Chip tone="warn">Manuell überschrieben</Chip>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onclick={() =>
                      (draft.coverageWeight = applyDefaults(draft.classification).coverageWeight)}
                    >Auf Standard zurück</button
                  >
                </div>
              {/if}
            </div>
            <div class="cp-full cp-field-with-extra">
              <label class="cp-check">
                <input type="checkbox" bind:checked={draft.requiresSupervision} />
                Aufsichtspflichtig
              </label>
              {#if supervisionOverridden}
                <div class="cp-override">
                  <Chip tone="warn">Manuell überschrieben</Chip>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onclick={() =>
                      (draft.requiresSupervision = applyDefaults(
                        draft.classification,
                      ).requiresSupervision)}>Auf Standard zurück</button
                  >
                </div>
              {/if}
            </div>
            <div class="cp-full">
              <FormField
                label="Urlaubstage pro Jahr (5-Tage-Woche)"
                help="Vorschlag aus den Einstellungen des Unternehmens (Azubis: „Urlaubstage Azubis“). Entspricht der Wert dem Standard, wird kein eigener Wert gespeichert – die Person folgt dann auch späteren Änderungen des Standards. Wird auf die vertraglichen Arbeitstage umgerechnet und im Eintrittsjahr anteilig berechnet."
                error={errors.annualVacationDays}
              >
                {#snippet field({ id, describedBy, invalid })}
                  <input
                    {id}
                    class="form-input"
                    type="number"
                    min="0.5"
                    max="365"
                    step="0.01"
                    bind:value={draft.annualVacationDays}
                    aria-invalid={invalid ? "true" : undefined}
                    aria-describedby={describedBy}
                    data-testid="admin-employees-create-annual-vacation-days"
                  />
                {/snippet}
              </FormField>
            </div>
          </div>
          {#if draft.classification === "AZUBI" && !draft.birthDate}
            <Note tone="warn">{MISSING_BIRTH_DATE_HINT}</Note>
          {/if}
          {#if minijob}
            <Note tone="warn">{minijobHintText(minijob)}</Note>
          {/if}
          <p class="cp-minimum">
            Gesetzlicher Mindesturlaub: {minimum.days.toLocaleString("de-DE", {
              maximumFractionDigits: 2,
            })} Tage ({minimum.law}).
          </p>
        </section>
      </div>
    {:else}
      <div class="cp-stack">
        <SegmentedControl
          name="create-invite-mode"
          ariaLabel="Zugang der Person"
          size="sm"
          options={[
            { value: "invite", label: "Per E-Mail einladen" },
            { value: "password", label: "Passwort setzen" },
          ]}
          value={draft.usePassword ? "password" : "invite"}
          onchange={(v) => {
            draft.usePassword = v === "password";
            errors = {};
          }}
        />
        {#if draft.usePassword}
          <FormField
            label="Passwort"
            required
            help="Die Person kann sich sofort anmelden. Kein Einladungslink nötig."
            error={errors.password}
          >
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                class="form-input"
                type="password"
                autocomplete="new-password"
                minlength="8"
                placeholder="Mindestens 8 Zeichen"
                bind:value={draft.password}
                aria-invalid={invalid ? "true" : undefined}
                aria-describedby={describedBy}
                data-autofocus
              />
            {/snippet}
          </FormField>
        {:else}
          <Note tone="brand">
            Die Person erhält per E-Mail einen Einladungslink. Stammdaten werden beim ersten Login
            vervollständigt.
          </Note>
        {/if}
        <dl class="cp-summary" aria-label="Zusammenfassung">
          <div>
            <dt>Person</dt>
            <dd>{personName}</dd>
          </div>
          <div>
            <dt>E-Mail-Adresse</dt>
            <dd>{draft.email.trim()}</dd>
          </div>
          <div>
            <dt>Eintritt</dt>
            <dd>{dayText(draft.hireDate)}</dd>
          </div>
          {#if homeSalonName}
            <div>
              <dt>Stammsalon</dt>
              <dd>{homeSalonName}</dd>
            </div>
          {/if}
          <div>
            <dt>Rollen</dt>
            <dd>{rolesSummary}</dd>
          </div>
          <div>
            <dt>Vertrag</dt>
            <dd>{modelSummary}</dd>
          </div>
        </dl>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" disabled={creating} onclick={() => (open = false)}
      >Abbrechen</button
    >
    {#if stepIndex > 0}
      <button type="button" class="btn btn-ghost" disabled={creating} onclick={back}>Zurück</button>
    {/if}
    {#if isLastStep}
      <button type="button" class="btn btn-primary" disabled={creating} onclick={submit}>
        {#if creating}<Spinner size={14} label="Wird angelegt" />{/if}
        Person anlegen
      </button>
    {:else}
      <button type="button" class="btn btn-primary" onclick={next}>Weiter</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .cp-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .cp-steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cp-step {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--text-3);
  }
  .cp-step-no {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .cp-step--done {
    color: var(--text-2);
  }
  .cp-step--done .cp-step-no {
    border-color: var(--brand);
    color: var(--brand);
  }
  .cp-step--current {
    color: var(--text);
    font-weight: 600;
  }
  .cp-step--current .cp-step-no {
    border-color: var(--brand);
    background: var(--brand);
    color: var(--brand-ink);
  }

  .cp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--s-4);
  }
  .cp-full {
    grid-column: 1 / -1;
    min-width: 0;
  }
  .cp-stack {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .cp-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding-top: var(--s-4);
    border-top: 1px solid var(--line);
  }
  .cp-section-title {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }
  .cp-field-with-extra {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .cp-override {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .cp-check {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-base);
    color: var(--text);
    cursor: pointer;
  }
  .cp-check input {
    accent-color: var(--brand);
  }
  .cp-minimum {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .cp-summary {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin: 0;
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--sunk);
  }
  .cp-summary > div {
    display: grid;
    grid-template-columns: minmax(110px, 30%) 1fr;
    gap: var(--s-3);
  }
  .cp-summary dt {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .cp-summary dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text);
  }
</style>
