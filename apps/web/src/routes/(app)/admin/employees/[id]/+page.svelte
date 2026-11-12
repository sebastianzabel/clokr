<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { employeeAdminRights, contractShiftRights } from "$lib/page-rights";
  import { DETAIL_TAB_ALIASES, employeeDetailTabs } from "$lib/employees/detail-tabs";
  import { markUnsaved } from "$stores/unsaved";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import PersonTab from "$lib/components/employees/detail/PersonTab.svelte";
  import UrlaubTab from "$lib/components/employees/detail/UrlaubTab.svelte";
  import VertragTab from "$lib/components/employees/detail/VertragTab.svelte";
  import VertragOverrides from "$lib/components/employees/detail/VertragOverrides.svelte";
  import BerufsschuleSection from "$lib/components/employees/detail/BerufsschuleSection.svelte";
  import ZugangTab from "$lib/components/employees/detail/ZugangTab.svelte";
  import SalonAssignmentsSection from "$lib/components/employees/SalonAssignmentsSection.svelte";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { employmentState, localCalendarDay } from "$lib/employees/employment-state";
  import type { PersonEmployee } from "$lib/employees/person-form";
  import type { VacationEntitlement } from "$lib/employees/urlaub-form";
  import type { ContractSchedule } from "$lib/employees/vertrag-form";
  import {
    dailySollMinutes,
    type OverrideEmployee,
    type OverrideTenant,
  } from "$lib/employees/overrides-form";
  import type { EmployeeClassification } from "$lib/employee-classification";
  import type { FormRole } from "$lib/employees/form-role";
  import { salonContext } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";

  // The detail page is a shell: it loads the record, the contract, the entitlement and the company
  // defaults once, and hands them to the five tabs (Person · Vertrag · Urlaub · Salons · Zugang).
  // Every tab owns its form, its snapshot and its SaveBar; the page only sums their unsaved counts
  // into ONE `markUnsaved` registration (Issue #854, D-854-04).

  // ── Types ──────────────────────────────────────────────────────────────────
  // The stored work schedule; the Vertrag tab owns its form (plan 854-21).
  type WorkSchedule = ContractSchedule;

  interface Employee extends OverrideEmployee {
    id: string;
    userId: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
    nfcCardId?: string | null;
    exitDate?: string | null;
    classification?: EmployeeClassification;
    coverageWeight?: number | null;
    requiresSupervision?: boolean;
    // Issue #482: per-person vacation base value; null = the classification's own Standard,
    // resolved server-side (resolveVacationBaseDays()).
    annualVacationDays?: number | string | null;
    // Phase 76.7 (UI-V19-04a) — § 18 ArbZG exemption flag (ADMIN-only toggle).
    isTimeTrackingExempt?: boolean;
    // The Zugang tab words the account state from it (GET /employees/:id sends it).
    invitationStatus?: "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
    user?: {
      role: FormRole | null;
      email: string;
      isActive: boolean;
      lastLoginAt?: string | null;
    } | null;
  }

  // The company defaults (GET /settings/work): the placeholders of the override groups and of the
  // vacation base value.
  interface TenantConfig extends OverrideTenant {
    // Issue #435 (D-13) — tenant default for the Stammdaten placeholder (same response).
    defaultVacationDays?: number | string;
    // Issue #482 — the Azubi-Standard, same response; feeds the placeholder for an AZUBI.
    defaultApprenticeVacationDays?: number | string;
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  let loading = $state(true);
  let loadError = $state("");

  // ── Data state (populated on mount) ───────────────────────────────────────
  let employee = $state<Employee | null>(null);
  let workSchedule = $state<WorkSchedule | null>(null);
  let vacationEntitlement = $state<VacationEntitlement | null>(null);
  let tenantBreakConfig = $state<TenantConfig | null>(null);

  const employeeId = $derived($page.params.id ?? "");

  onMount(async () => {
    activeTab = tabFromHash(
      $page.url.hash,
      tabs.map((t) => t.id),
      DETAIL_TAB_ALIASES,
    );
    loading = true;
    loadError = "";
    try {
      const [empRes, schedRes, vacRes, cfgRes] = await Promise.allSettled([
        api.get<Employee>(`/employees/${employeeId}`),
        api.get<WorkSchedule>(`/settings/work/${employeeId}`),
        api.get<VacationEntitlement>(
          `/settings/vacation/${employeeId}?year=${new Date().getFullYear()}`,
        ),
        api.get<TenantConfig>(`/settings/work`),
      ]);

      if (empRes.status === "rejected") {
        loadError = "Mitarbeiter nicht gefunden.";
        return;
      }
      employee = empRes.value;
      workSchedule = schedRes.status === "fulfilled" ? schedRes.value : null;
      vacationEntitlement = vacRes.status === "fulfilled" ? vacRes.value : null;
      tenantBreakConfig = cfgRes.status === "fulfilled" ? cfgRes.value : null;
      // The record and everything the tabs read are hydrated: the unsaved registration may arm now.
      snapshotsReady = true;
    } catch {
      loadError = "Fehler beim Laden des Mitarbeiters.";
    } finally {
      loading = false;
    }
  });

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // The tab list follows the caller's permissions (Issue #86, D-04); it is derived below, next to
  // `rights`, from employeeDetailTabs(). The selected tab lives in the URL hash (Issue #854): the
  // hash is read against the VISIBLE ids only, and the former ids (`#stammdaten`, `#arbeitszeit`,
  // `#berechtigungen`, `#danger`) resolve through DETAIL_TAB_ALIASES.
  let activeTab = $state<string>("person");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // Permission-driven controls (Issue #538): the API refuses anything beyond these, the page only
  // hides. Setting a role needs role-assignment:manage; the § 18 ArbZG exemption rides on the
  // employee PATCH, hence employee:update.
  let rights = $derived(employeeAdminRights($authStore.user));
  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let tabs = $derived(employeeDetailTabs(rights));
  let canDiscardShifts = $derived(contractShiftRights($authStore.user).canDiscardShifts);
  let canUpdateEmployee = $derived(rights.canUpdate);
  // PUT /settings/work/:id needs contract:update; presentation only, the API refuses anyway.
  let canUpdateContract = $derived(hasPermission($authStore.user, "contract:update:ZUGEWIESEN"));
  let canEditVacation = $derived(
    hasPermission($authStore.user, "leave-entitlement:update:ZUGEWIESEN"),
  );
  // PUT /employees/:id/vocational-school-pattern needs vocational-school:manage.
  let canManageVocationalSchool = $derived(
    hasPermission($authStore.user, "vocational-school:manage:ZUGEWIESEN"),
  );
  let classification = $derived<EmployeeClassification>(employee?.classification ?? "VOLLZEIT");
  // The lowest layer of the Berufsschule slots; follows the contract the Vertrag tab last saved.
  let empDailySollMin = $derived(dailySollMinutes(workSchedule));

  const vacYear = new Date().getFullYear();

  // ── Unsaved-section tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ──────────────
  // Every tab owns its snapshots (taken when it mounts, re-taken after each successful save) and
  // reports the number of its unsaved changes through `bind:changes`. This page sums them into ONE
  // registration (a second registration of the same id would let one section's cleanup disarm the
  // guard of the others). Registry id ("admin-employee-detail") is distinct from admin/system's
  // ("admin-system"), so the two pages cannot clear each other, and the cleanup de-registers on
  // unmount so a saved page that the operator leaves cannot strand a stale entry (T-109-27).
  let personChanges = $state(0);
  let vacationChanges = $state(0);
  let vertragChanges = $state(0);
  let overrideChanges = $state(0);
  let berufsschuleChanges = $state(0);
  let anyUnsaved = $derived(
    personChanges > 0 ||
      vertragChanges > 0 ||
      overrideChanges > 0 ||
      berufsschuleChanges > 0 ||
      vacationChanges > 0,
  );

  // Gate the registration on "the record was hydrated" (WR-01). The early `loadError` return of
  // onMount skips the hydration, so a stale bookmark to a deleted employee, which renders only an
  // error and no marker to explain a discard dialog, can never arm the guard.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-employee-detail", snapshotsReady && anyUnsaved);
    return () => markUnsaved("admin-employee-detail", false);
  });

  // ── Derived display ────────────────────────────────────────────────────────
  let displayName = $derived(`${employee?.firstName ?? ""} ${employee?.lastName ?? ""}`.trim());
  // The head's second line: the employee number and the employment state (Issue #86, D-01). The
  // state is decided from the exit date and a calendar day, never from a display string.
  let headSub = $derived.by(() => {
    const state = employmentState(employee?.exitDate, localCalendarDay());
    const parts: string[] = [];
    if (employee?.employeeNumber) parts.push(`Personalnummer ${employee.employeeNumber}`);
    parts.push(state.kind === "EMPLOYED" ? "Beschäftigt" : state.label);
    return parts.join(" · ");
  });

  // Tenant defaults for the placeholder of the vacation base value (Person tab).
  let tenantDefaultVacationDays = $derived(Number(tenantBreakConfig?.defaultVacationDays) || 30);
  // Issue #482 — the Azubi-Standard, same fallback as the vacation rules page (20).
  let tenantDefaultApprenticeVacationDays = $derived(
    Number(tenantBreakConfig?.defaultApprenticeVacationDays) || 20,
  );

  /** The Vertrag tab reports the saved schedule; the Berufsschule slots read its weekly hours. */
  function onContractSaved(saved: ContractSchedule) {
    workSchedule = saved;
  }

  /** The override groups report what a PATCH wrote; the record follows. */
  function onOverridesSaved(written: Partial<OverrideEmployee>) {
    if (employee) employee = { ...employee, ...written };
  }

  /** The Person tab reports what a PATCH wrote; the record (and so the head and the Vertrag tab) follows. */
  function onPersonSaved(written: Partial<PersonEmployee>) {
    if (employee) employee = { ...employee, ...(written as Partial<Employee>) };
  }
</script>

{#if loading}
  <div class="page-loading"><Skeleton shape="card" lines={3} /></div>
{:else if loadError || !employee}
  <div class="page-error">{loadError || "Mitarbeiter nicht gefunden."}</div>
{:else}
  <Breadcrumb
    crumbs={[
      { label: pageLabel("/admin/employees"), href: "/admin/employees" },
      { label: displayName || "Mitarbeiter" },
    ]}
  />
  <PageHead title={displayName || "Mitarbeiter"} sub={headSub} />

  <PageTabs
    tabs={tabs.map((t) => ({ value: t.id, label: t.label }))}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche der Person"
  >
    {#snippet panel(tab)}
      {#if tab === "person"}
        {#if employee}
          <PersonTab
            {employee}
            canEdit={canUpdateEmployee}
            {tenantDefaultVacationDays}
            {tenantDefaultApprenticeVacationDays}
            bind:changes={personChanges}
            onSaved={onPersonSaved}
          />
        {/if}
      {:else if tab === "vertrag"}
        <VertragTab
          {employeeId}
          schedule={workSchedule}
          employee={{ classification }}
          canEdit={canUpdateContract}
          {canDiscardShifts}
          bind:changes={vertragChanges}
          onSaved={onContractSaved}
        >
          {#if employee}
            <VertragOverrides
              {employee}
              tenant={tenantBreakConfig}
              canEdit={canUpdateEmployee}
              bind:changes={overrideChanges}
              onSaved={onOverridesSaved}
            />
          {/if}
          {#if employee && classification === "AZUBI"}
            <BerufsschuleSection
              {employeeId}
              {employee}
              tenant={tenantBreakConfig}
              dailySollMin={empDailySollMin}
              canManagePattern={canManageVocationalSchool}
              canEditSlots={canUpdateEmployee}
              bind:changes={berufsschuleChanges}
              onSlotsSaved={onOverridesSaved}
            />
          {/if}
        </VertragTab>
      {:else if tab === "urlaub"}
        <UrlaubTab
          {employeeId}
          year={vacYear}
          entitlement={vacationEntitlement}
          canEdit={canEditVacation}
          bind:changes={vacationChanges}
        />
      {:else if tab === "salons"}
        <!-- ── Salons (Issue #86, AC-86-5) ────────────────────────────────── -->
        <SalonAssignmentsSection {employeeId} canEdit={rights.canUpdate} />
      {:else if tab === "zugang"}
        {#if employee}
          <ZugangTab
            {employee}
            {rights}
            {canReadRoles}
            salons={$salonContext.salons}
            salonsLoaded={$salonContext.loaded}
            onRemoved={() => goto("/admin/employees")}
          />
        {/if}
      {/if}
    {/snippet}
  </PageTabs>
{/if}

<style>
  /* ── Loading / error states ─────────────────────────────────────────────── */
  .page-loading,
  .page-error {
    padding: var(--s-6);
    color: var(--text-2);
    font-size: 14px;
  }

  .page-error {
    color: var(--bad);
  }
</style>
