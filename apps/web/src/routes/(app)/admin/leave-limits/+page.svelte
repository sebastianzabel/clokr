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
    blackoutPreset,
    emptyRuleForm,
    ruleFormFromDto,
    ruleFormPayload,
    ruleSalonChoices,
    validateRuleForm,
    type RuleForm,
  } from "$lib/leave-limits/rule-form";
  import type { LeaveLimitRoleChoice, LeaveLimitRuleDto } from "$lib/leave-limits/types";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  // Presentation only: the API decides every read and write by reach (Issue #836, D-836-13). The
  // page hides controls the caller cannot use; a forged request still meets the API's 403/404.
  const canCreate = $derived(hasPermission($authStore.user, "leave-limit:manage:ZUGEWIESEN"));

  let rules: LeaveLimitRuleDto[] = $state([]);
  let roleChoices: LeaveLimitRoleChoice[] = $state([]);
  let canManageAllSalons = $state(false);
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  // The page's own salon selection ("" = every salon in reach). It is not the header salon context.
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

  $effect(() => {
    const salonId = effectiveSalonId;
    if (!$salonContext.loaded) return;
    untrack(() => void load(salonId));
  });

  // ── Rule modal ────────────────────────────────────────────────────────────
  let modalOpen = $state(false);
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

  function openModal(next: RuleForm, blackout: boolean, editing: LeaveLimitRuleDto | null) {
    form = next;
    blackoutMode = blackout;
    editingId = editing?.id ?? null;
    editingRule = editing;
    formError = "";
    modalOpen = true;
  }

  function openCreate() {
    openModal(emptyRuleForm(defaultSalonId()), false, null);
  }

  function openBlackout() {
    openModal(blackoutPreset(defaultSalonId()), true, null);
  }

  function openEdit(rule: LeaveLimitRuleDto) {
    openModal(ruleFormFromDto(rule), isBlackout(rule), rule);
  }

  async function saveRule() {
    const problem = validateRuleForm(form, { blackout: blackoutMode });
    if (problem) {
      formError = problem;
      return;
    }
    saving = true;
    formError = "";
    try {
      const body = ruleFormPayload(form);
      if (editingId) {
        await updateLeaveLimitRule(editingId, body);
      } else {
        await createLeaveLimitRule(body);
      }
      modalOpen = false;
      toasts.success(editingId ? "Regel gespeichert." : "Regel angelegt.");
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
    return `${what} gilt danach nicht mehr. Sie bleibt nachvollziehbar und wird nicht gelöscht.`;
  }

  function salonCell(rule: LeaveLimitRuleDto): string {
    if (rule.salonId === null) return ALL_SALONS_CHOICE_LABEL;
    const name = rule.salonName ?? "Salon";
    return rule.salonActive === false ? `${name} (deaktiviert)` : name;
  }
</script>

<svelte:head>
  <title>Urlaubsgrenzen &amp; Sperren – Clokr</title>
</svelte:head>

<ListDetail
  eyebrow="Personal"
  title="Urlaubsgrenzen & Sperren"
  sub="Lege fest, wie viele Personen gleichzeitig im Urlaub sein dürfen, oder sperre einen Zeitraum."
  view="list"
>
  {#snippet actions()}
    {#if canCreate}
      <button type="button" class="btn btn-outline btn-sm" onclick={openBlackout}>
        Urlaubssperre
      </button>
      <button type="button" class="btn btn-primary btn-sm" onclick={openCreate}>Neue Regel</button>
    {/if}
  {/snippet}

  {#snippet list()}
    {#if salonOptionsShown}
      <Section>
        <div class="form-group salon-pick">
          <label class="form-label" for="ll-salon">Salon</label>
          <select id="ll-salon" class="form-input" bind:value={viewSalon}>
            <option value="">{ALL_SALONS_CHOICE_LABEL}</option>
            {#each reachableSalons as salon (salon.id)}
              <option value={salon.id}>{salon.name}</option>
            {/each}
          </select>
          <span class="form-hint">
            Zeigt die Regeln des gewählten Salons und die Regeln für alle Salons.
          </span>
        </div>
      </Section>
    {/if}

    {#if loading}
      <Section>
        <p class="text-muted" role="status">Wird geladen…</p>
      </Section>
    {:else if forbidden}
      <Section>
        <p class="text-muted">Für die Urlaubsgrenzen fehlt dir die Berechtigung.</p>
      </Section>
    {:else if loadError}
      <div class="alert alert-error" role="alert">{loadError}</div>
    {:else if rules.length === 0}
      <Section>
        <div class="empty-state">
          <h3>Noch keine Regeln</h3>
          <p class="text-muted">
            Mit einer Regel legst du fest, wie viele Personen gleichzeitig im Urlaub sein dürfen.
            Für einen Zeitraum, in dem niemand Urlaub nehmen soll, legst du eine Urlaubssperre an.
          </p>
          {#if canCreate}
            <button type="button" class="btn btn-primary" onclick={openCreate}>
              Erste Regel anlegen
            </button>
          {/if}
        </div>
      </Section>
    {:else}
      <Section title="Regeln" sub="Die strengste Regel eines Tages gilt.">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                {#if showSalonColumn}<th>Salon</th>{/if}
                <th>Gruppe</th>
                <th>Grenze</th>
                <th>Zeitraum</th>
                <th>Bezeichnung</th>
                <th><span class="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              {#each rules as rule (rule.id)}
                <tr>
                  {#if showSalonColumn}<td>{salonCell(rule)}</td>{/if}
                  <td>{groupLabel(rule)}</td>
                  <td>
                    {limitText(rule)}
                    {#if isBlackout(rule)}<span class="badge badge-red">Sperre</span>{/if}
                  </td>
                  <td>{windowLabel(rule)}</td>
                  <td class="text-muted">{rule.name ?? "–"}</td>
                  <td class="row-end">
                    {#if rule.canManage}
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm"
                        onclick={() => openEdit(rule)}
                      >
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm btn-danger"
                        onclick={() => askRemove(rule)}
                      >
                        Entfernen
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Section>
    {/if}
  {/snippet}
</ListDetail>

<!-- ── Modal: create or edit a rule ──────────────────────────────────────── -->
<Modal
  bind:open={modalOpen}
  eyebrow="Urlaubsgrenzen"
  title={editingId
    ? blackoutMode
      ? "Urlaubssperre bearbeiten"
      : "Regel bearbeiten"
    : blackoutMode
      ? "Neue Urlaubssperre"
      : "Neue Regel"}
>
  {#if formError}
    <div class="callout error" role="alert">{formError}</div>
  {/if}

  <div class="callout brand" data-testid="leave-limit-legal-hint">
    <p>{LEAVE_LIMIT_LEGAL_HINT}</p>
  </div>

  {#if salonFieldShown}
    <div class="form-group">
      <label class="form-label" for="ll-rule-salon">Salon</label>
      <select
        id="ll-rule-salon"
        class="form-input"
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
    </div>
  {/if}

  {#if blackoutMode}
    <p class="form-hint">
      Eine Urlaubssperre gilt für alle Mitarbeitenden: Im Zeitraum darf niemand gleichzeitig im
      Urlaub sein.
    </p>
  {:else}
    <div class="form-group">
      <label class="form-label" for="ll-rule-group">Gruppe</label>
      <select id="ll-rule-group" class="form-input" bind:value={form.groupKind}>
        <option value="ALL">Alle</option>
        <option value="CLASSIFICATION">Beschäftigungsart</option>
        <option value="ACCESS_ROLE">Rolle</option>
      </select>
    </div>

    {#if form.groupKind === "CLASSIFICATION"}
      <div class="form-group">
        <label class="form-label" for="ll-rule-classification">Beschäftigungsart *</label>
        <select
          id="ll-rule-classification"
          class="form-input"
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
      </div>
    {:else if form.groupKind === "ACCESS_ROLE"}
      <div class="form-group">
        <label class="form-label" for="ll-rule-role">Rolle *</label>
        <select
          id="ll-rule-role"
          class="form-input"
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
      </div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="ll-rule-max">Höchstens gleichzeitig im Urlaub *</label>
      <input
        id="ll-rule-max"
        class="form-input"
        type="number"
        min="0"
        max="999"
        step="1"
        inputmode="numeric"
        bind:value={
          () => form.maxPersons,
          (value) => {
            form.maxPersons = value === null || value === undefined ? "" : String(value);
          }
        }
      />
      <span class="form-hint">Mit 0 ist in diesem Zeitraum kein Urlaub möglich.</span>
    </div>
  {/if}

  <div class="form-row">
    <div class="form-group">
      <label class="form-label" for="ll-rule-from">
        Von {blackoutMode ? "*" : "(optional)"}
      </label>
      <input id="ll-rule-from" class="form-input" type="date" bind:value={form.validFrom} />
    </div>
    <div class="form-group">
      <label class="form-label" for="ll-rule-until">
        Bis {blackoutMode ? "*" : "(optional)"}
      </label>
      <input id="ll-rule-until" class="form-input" type="date" bind:value={form.validUntil} />
    </div>
  </div>
  {#if !blackoutMode}
    <p class="form-hint">Ohne Zeitraum gilt die Regel das ganze Jahr.</p>
  {/if}

  <div class="form-group">
    <label class="form-label" for="ll-rule-name">Bezeichnung (optional)</label>
    <input
      id="ll-rule-name"
      class="form-input"
      type="text"
      maxlength="80"
      placeholder={blackoutMode ? "z. B. Weihnachtsgeschäft" : "z. B. Sommerferien"}
      bind:value={form.name}
    />
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (modalOpen = false)}>
      Abbrechen
    </button>
    <button type="button" class="btn btn-primary" onclick={saveRule} disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Modal>

<!-- ── Confirmation: remove a rule ───────────────────────────────────────── -->
<ConfirmDialog
  bind:open={removeConfirm.open}
  title="Regel entfernen?"
  description={removeDescription(removeConfirm.rule)}
  confirmLabel="Entfernen"
  danger
  onConfirm={confirmRemove}
/>

<style>
  .salon-pick {
    max-width: 320px;
    margin-bottom: 0;
  }

  .row-end {
    text-align: right;
    white-space: nowrap;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .callout {
    margin-bottom: 14px;
  }
</style>
