<!--
  UrlaubsgrenzenPanel - the „Urlaubsgrenzen & Sperren“ tab of Verwalten › Regeln › Abwesenheiten (Issue #854,
  rebuilt on the blocks of #843; the data, the endpoints and the rules are those of the pre-#854 page
  /admin/leave-limits, Issue #836). A management section without configuration keys of its own (registry
  section `abwesenheiten-urlaubsgrenzen`).

  Loads `GET /leave/limits` itself, the first time the tab is shown and again when the viewed salon changes.
  Writes are `POST /leave/limits`, `PUT /leave/limits/:id` and the soft removal `DELETE /leave/limits/:id`; each
  acts at once and answers with a toast (docs/ADMIN_STRUCTURE.md §3.2.1: a list action saves instantly, there is
  no section button). A rule and a Urlaubssperre (everybody, at most 0, a window mandatory) are created and
  edited in a Dialog. A removed rule stays traceable.

  Presentation only: the API decides every read and write by reach (#836, D-836-13). The panel hides controls the
  caller cannot use (`canManage` of the row, `leave-limit:manage`); a forged request still meets the API's 403 or
  404. It counts nothing itself - the parallel-leave load is the API's kernel (CLAUDE.md, Issue #836) - and shows
  no names of other persons.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";
  import { CLASSIFICATION_LABELS, CLASSIFICATION_OPTIONS } from "$lib/employee-classification";
  import {
    createLeaveLimitRule,
    fetchLeaveLimitRules,
    removeLeaveLimitRule,
    updateLeaveLimitRule,
  } from "$lib/leave-limits/api";
  import {
    LEAVE_LIMIT_LEGAL_HINT,
    groupLabel,
    groupPluralLabel,
    isBlackout,
    limitText,
    windowLabel,
  } from "$lib/leave-limits/labels";
  import {
    ALL_SALONS_CHOICE_LABEL,
    RULE_NAME_MAX_LENGTH,
    blackoutPreset,
    emptyRuleForm,
    ruleFormFromDto,
    ruleFormPayload,
    ruleSalonChoices,
    validateRuleForm,
    type RuleForm,
  } from "$lib/leave-limits/rule-form";
  import type { LeaveLimitRoleChoice, LeaveLimitRuleDto } from "$lib/leave-limits/types";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  interface Props {
    active: boolean;
  }

  let { active }: Props = $props();

  const canCreate = $derived(hasPermission($authStore.user, "leave-limit:manage:ZUGEWIESEN"));

  let rules: LeaveLimitRuleDto[] = $state([]);
  let roleChoices: LeaveLimitRoleChoice[] = $state([]);
  let canManageAllSalons = $state(false);
  let loading = $state(false);
  let loadError = $state("");
  let forbidden = $state(false);

  // The panel's own salon selection ("" = every salon in reach). It is not the header salon context.
  let viewSalon = $state("");
  const salonOptionsShown = $derived(showSalonOptions($salonContext));
  const reachableSalons = $derived($salonContext.salons);
  // Without salon options the sole reachable salon is the view; otherwise the selection decides.
  const effectiveSalonId = $derived(
    salonOptionsShown
      ? viewSalon || null
      : reachableSalons.length === 1
        ? reachableSalons[0].id
        : null,
  );
  const showSalonColumn = $derived(
    salonOptionsShown || rules.some((rule) => rule.salonId !== null),
  );

  const columns = $derived<DataTableColumn[]>([
    { key: "group", label: "Gruppe", primary: true },
    ...(showSalonColumn ? [{ key: "salon", label: "Salon" }] : []),
    { key: "limit", label: "Grenze" },
    { key: "window", label: "Zeitraum" },
    { key: "name", label: "Bezeichnung" },
    { key: "actions", label: "Aktionen", align: "end" as const },
  ]);

  let loadSeq = 0;
  async function load(salonId: string | null) {
    const mine = ++loadSeq;
    loading = true;
    loadError = "";
    try {
      const res = await fetchLeaveLimitRules(salonId);
      if (mine !== loadSeq) return;
      rules = res.rules;
      roleChoices = res.roleChoices;
      canManageAllSalons = res.canManageAllSalons;
      forbidden = false;
    } catch (err) {
      if (mine !== loadSeq) return;
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Urlaubsgrenzen konnten nicht geladen werden.";
      }
    } finally {
      if (mine === loadSeq) loading = false;
    }
  }

  // Lazy load on the first visit of the tab (a person who never opens it costs no request); after that the
  // viewed salon decides. The salon context must be there first: it names the sole reachable salon.
  let started = false;
  $effect(() => {
    const salonId = effectiveSalonId;
    if (!active && !started) return;
    if (!$salonContext.loaded) return;
    started = true;
    untrack(() => void load(salonId));
  });

  // ── Rule dialog ───────────────────────────────────────────────────────────
  let dialogOpen = $state(false);
  let editingId: string | null = $state(null);
  let editingRule: LeaveLimitRuleDto | null = $state(null);
  let blackoutMode = $state(false);
  let form: RuleForm = $state(emptyRuleForm(null));
  let formError = $state("");
  let saving = $state(false);

  const salonChoices = $derived(ruleSalonChoices(reachableSalons, canManageAllSalons, editingRule));
  // The salon field follows the #64 rule: a choice exists only with salon options.
  const salonFieldShown = $derived(salonOptionsShown);

  /** The salon a new rule starts in: the viewed salon, else the sole one, else all salons. */
  function defaultSalonId(): string | null {
    if (effectiveSalonId) return effectiveSalonId;
    if (reachableSalons.length === 1 && !canManageAllSalons) return reachableSalons[0].id;
    return canManageAllSalons ? null : (reachableSalons[0]?.id ?? null);
  }

  function openDialog(next: RuleForm, blackout: boolean, editing: LeaveLimitRuleDto | null) {
    form = next;
    blackoutMode = blackout;
    editingId = editing?.id ?? null;
    editingRule = editing;
    formError = "";
    dialogOpen = true;
  }

  function openCreate() {
    openDialog(emptyRuleForm(defaultSalonId()), false, null);
  }

  function openBlackout() {
    openDialog(blackoutPreset(defaultSalonId()), true, null);
  }

  function openEdit(rule: LeaveLimitRuleDto) {
    openDialog(ruleFormFromDto(rule), isBlackout(rule), rule);
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function saveRule() {
    const problem = validateRuleForm(form, { blackout: blackoutMode });
    if (problem) {
      formError = problem;
      return;
    }
    saving = true;
    formError = "";
    const creating = editingId === null;
    try {
      const body = ruleFormPayload(form);
      if (editingId) {
        await updateLeaveLimitRule(editingId, body);
      } else {
        await createLeaveLimitRule(body);
      }
      dialogOpen = false;
      toasts.success(creating ? "Regel angelegt." : "Regel gespeichert.");
      await load(effectiveSalonId);
    } catch (err) {
      formError = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  // ── Removal ───────────────────────────────────────────────────────────────
  let removeConfirm: { open: boolean; rule: LeaveLimitRuleDto | null } = $state({
    open: false,
    rule: null,
  });

  function askRemove(rule: LeaveLimitRuleDto) {
    removeConfirm = { open: true, rule };
  }

  async function confirmRemove() {
    const rule = removeConfirm.rule;
    if (!rule) return;
    try {
      await removeLeaveLimitRule(rule.id);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Entfernen fehlgeschlagen.");
      throw err;
    }
    toasts.success("Regel entfernt.");
    await load(effectiveSalonId);
  }

  function removeDescription(rule: LeaveLimitRuleDto | null): string {
    if (!rule) return "";
    const what = rule.name ? `„${rule.name}“` : `Die Regel für ${groupPluralLabel(rule)}`;
    return `${what} gilt danach nicht mehr. Die Regel bleibt nachvollziehbar und wird nicht gelöscht.`;
  }

  function salonCell(rule: LeaveLimitRuleDto): string {
    if (rule.salonId === null) return ALL_SALONS_CHOICE_LABEL;
    const name = rule.salonName ?? "Salon";
    return rule.salonActive === false ? `${name} (deaktiviert)` : name;
  }

  const dialogTitle = $derived(
    editingId
      ? blackoutMode
        ? "Urlaubssperre bearbeiten"
        : "Regel bearbeiten"
      : blackoutMode
        ? "Neue Urlaubssperre"
        : "Neue Regel",
  );
</script>

<section class="settings-group" aria-labelledby="abwesenheiten-urlaubsgrenzen-title">
  <h2 class="settings-group-title" id="abwesenheiten-urlaubsgrenzen-title">
    Urlaubsgrenzen & Sperren
  </h2>
  <p class="settings-group-desc">
    Lege fest, wie viele Personen gleichzeitig im Urlaub sein dürfen, oder sperre einen Zeitraum.
    Die strengste Regel eines Tages gilt.
  </p>

  <div class="ug-bar">
    {#if salonOptionsShown}
      <FormField
        label="Salon"
        help="Zeigt die Regeln des gewählten Salons und die Regeln für alle Salons."
      >
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input ug-salon"
            bind:value={viewSalon}
            aria-describedby={describedBy}
            data-testid="abwesenheiten-urlaubsgrenzen-salon"
          >
            <option value="">{ALL_SALONS_CHOICE_LABEL}</option>
            {#each reachableSalons as salon (salon.id)}
              <option value={salon.id}>{salon.name}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    {/if}
    {#if canCreate}
      <div class="ug-actions">
        <button type="button" class="btn btn-secondary" onclick={openBlackout}>
          Urlaubssperre
        </button>
        <button type="button" class="btn btn-primary" onclick={openCreate}>Neue Regel</button>
      </div>
    {/if}
  </div>

  {#if forbidden}
    <div role="alert">
      <Note tone="bad">Für die Urlaubsgrenzen fehlt dir die Berechtigung.</Note>
    </div>
  {:else if loadError}
    <ErrorState message={loadError} onRetry={() => load(effectiveSalonId)} retrying={loading} />
  {:else if loading && rules.length === 0}
    <Skeleton shape="card" count={1} lines={4} />
  {:else if rules.length === 0}
    <EmptyState
      icon="calendar"
      title="Noch keine Regeln"
      description="Mit einer Regel legst du fest, wie viele Personen gleichzeitig im Urlaub sein dürfen. Für einen Zeitraum, in dem niemand Urlaub nehmen soll, legst du eine Urlaubssperre an."
      actionLabel={canCreate ? "Erste Regel anlegen" : undefined}
      onaction={canCreate ? openCreate : undefined}
    />
  {:else}
    <DataTable
      {columns}
      rows={rules}
      rowKey={(row) => row.id}
      caption="Urlaubsgrenzen und Sperren mit Gruppe, Grenze und Zeitraum"
    >
      {#snippet cell(row, column)}
        {#if column.key === "salon"}
          {salonCell(row)}
        {:else if column.key === "limit"}
          {limitText(row)}
          {#if isBlackout(row)}<Chip tone="bad">Sperre</Chip>{/if}
        {:else if column.key === "window"}
          {windowLabel(row)}
        {:else if column.key === "name"}
          {row.name ?? "–"}
        {:else if column.key === "actions"}
          {#if row.canManage}
            <button type="button" class="btn btn-secondary btn-sm" onclick={() => openEdit(row)}>
              Bearbeiten
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm btn-danger"
              onclick={() => askRemove(row)}
            >
              Entfernen
            </button>
          {/if}
        {:else}
          {groupLabel(row)}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<!-- ── Dialog: create or edit a rule ───────────────────────────────────────── -->
<Dialog bind:open={dialogOpen} title={dialogTitle}>
  <form
    id="leave-limit-form"
    novalidate
    class="ug-form"
    onsubmit={(event) => {
      event.preventDefault();
      void saveRule();
    }}
  >
    <div data-testid="leave-limit-legal-hint">
      <Note tone="brand">{LEAVE_LIMIT_LEGAL_HINT}</Note>
    </div>

    {#if salonFieldShown}
      <FormField label="Salon">
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input"
            aria-describedby={describedBy}
            bind:value={
              () => form.salonId ?? "",
              (value) => {
                form.salonId = value === "" ? null : value;
              }
            }
          >
            {#each salonChoices as choice (choice.value)}
              <option value={choice.value}>{choice.label}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    {/if}

    {#if blackoutMode}
      <p class="ug-hint">
        Eine Urlaubssperre gilt für alle Mitarbeitenden: Im Zeitraum darf niemand gleichzeitig im
        Urlaub sein.
      </p>
    {:else}
      <FormField label="Gruppe">
        {#snippet field({ id, describedBy })}
          <select
            {id}
            class="form-input"
            aria-describedby={describedBy}
            bind:value={form.groupKind}
          >
            <option value="ALL">Alle</option>
            <option value="CLASSIFICATION">Beschäftigungsart</option>
            <option value="ACCESS_ROLE">Rolle</option>
          </select>
        {/snippet}
      </FormField>

      {#if form.groupKind === "CLASSIFICATION"}
        <FormField label="Beschäftigungsart" required>
          {#snippet field({ id, describedBy })}
            <select
              {id}
              class="form-input"
              aria-describedby={describedBy}
              bind:value={
                () => form.classification ?? "",
                (value) => {
                  form.classification = value === "" ? null : (value as typeof form.classification);
                }
              }
            >
              <option value="">– bitte wählen –</option>
              {#each CLASSIFICATION_OPTIONS as option (option)}
                <option value={option}>{CLASSIFICATION_LABELS[option]}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
      {:else if form.groupKind === "ACCESS_ROLE"}
        <FormField label="Rolle" required>
          {#snippet field({ id, describedBy })}
            <select
              {id}
              class="form-input"
              aria-describedby={describedBy}
              bind:value={
                () => form.accessRoleId ?? "",
                (value) => {
                  form.accessRoleId = value === "" ? null : value;
                }
              }
            >
              <option value="">– bitte wählen –</option>
              {#each roleChoices as role (role.id)}
                <option value={role.id}>{role.name}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
      {/if}

      <FormField
        label="Höchstens gleichzeitig im Urlaub"
        required
        help="Mit 0 ist in diesem Zeitraum kein Urlaub möglich."
      >
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input ug-max"
            type="number"
            min="0"
            max="999"
            step="1"
            inputmode="numeric"
            aria-describedby={describedBy}
            bind:value={
              () => form.maxPersons,
              (value) => {
                form.maxPersons = value === null || value === undefined ? "" : String(value);
              }
            }
          />
        {/snippet}
      </FormField>
    {/if}

    <div class="ug-dates">
      <FormField label={blackoutMode ? "Von" : "Von (optional)"} required={blackoutMode}>
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input"
            type="date"
            aria-describedby={describedBy}
            bind:value={form.validFrom}
          />
        {/snippet}
      </FormField>
      <FormField label={blackoutMode ? "Bis" : "Bis (optional)"} required={blackoutMode}>
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input"
            type="date"
            aria-describedby={describedBy}
            bind:value={form.validUntil}
          />
        {/snippet}
      </FormField>
    </div>
    {#if !blackoutMode}
      <p class="ug-hint">Ohne Zeitraum gilt die Regel das ganze Jahr.</p>
    {/if}

    <FormField label="Bezeichnung (optional)">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={RULE_NAME_MAX_LENGTH}
          placeholder={blackoutMode ? "z. B. Weihnachtsgeschäft" : "z. B. Sommerferien"}
          aria-describedby={describedBy}
          bind:value={form.name}
        />
      {/snippet}
    </FormField>

    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (dialogOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="leave-limit-form" class="btn btn-primary" disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Dialog>

<!-- ── Confirmation: remove a rule ─────────────────────────────────────────── -->
<ConfirmDialog
  bind:open={removeConfirm.open}
  title="Regel entfernen?"
  description={removeDescription(removeConfirm.rule)}
  confirmLabel="Entfernen"
  danger
  onConfirm={confirmRemove}
/>

<style>
  .ug-bar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin-bottom: var(--s-3);
  }

  .ug-salon {
    width: auto;
    min-width: 12rem;
  }

  .ug-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    margin-left: auto;
  }

  .ug-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .ug-dates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--s-4);
  }

  .ug-max {
    max-width: 9rem;
  }

  .ug-hint {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
</style>
