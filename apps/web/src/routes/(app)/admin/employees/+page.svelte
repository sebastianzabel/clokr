<script lang="ts">
  import { onMount } from "svelte";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";

  type InvitationStatus = "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
  type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";

  interface Employee {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    hireDate: string;
    exitDate: string | null;
    nfcCardId: string | null;
    user: {
      email: string;
      role: Role;
      isActive: boolean;
      lastLoginAt: string | null;
    };
    invitationStatus: InvitationStatus;
  }

  let employees: Employee[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Create modal
  let createOpen = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let createEmailError = $state("");
  let cFirstName = $state("");
  let cLastName = $state("");
  let cEmail = $state("");
  let cEmployeeNumber = $state("");
  let cHireDate = $state(new Date().toISOString().split("T")[0]);
  let cRole: Role = $state("EMPLOYEE");
  let cScheduleType = $state<"FIXED_WEEKLY" | "MONTHLY_HOURS">("FIXED_WEEKLY");
  let cWeeklyHours = $state(40);
  let cMonthlyHours = $state<number | null>(null);
  let cUsePassword = $state(false);
  let cPassword = $state("");

  // Edit modal
  let editOpen = $state(false);
  let editingEmployee: Employee | null = $state(null);
  let editSaving = $state(false);
  let editError = $state("");
  let eFirstName = $state("");
  let eLastName = $state("");
  let eEmployeeNumber = $state("");
  let eRole: Role = $state("EMPLOYEE");
  let eNfcCardId = $state("");
  let eExitDate = $state("");

  // Anonymize confirm (step 1)
  let anonOpen = $state(false);
  let anonymizingEmployee: Employee | null = $state(null);
  let anonymizing = $state(false);

  // Hard-delete confirm (step 2 — only for already-anonymized employees)
  let hardDelOpen = $state(false);
  let hardDeletingEmployee: Employee | null = $state(null);
  let hardDeleting = $state(false);
  let hardDeleteError = $state("");
  let hardDeleteRetentionExpiresAt = $state<string | null>(null);
  let hardDeleteForce = $state(false);

  let isAdmin = $derived($authStore.user?.role === "ADMIN");

  // ── Helpers ──────────────────────────────────────────────────────────────
  function isAnonymized(emp: Employee): boolean {
    // Sentinel set by DELETE /employees/:id anonymization flow (CLAUDE.md / DSGVO)
    return emp.firstName === "Gelöscht" && emp.lastName.startsWith("GELÖSCHT-");
  }

  // Filters
  let filterSearch = $state("");
  let filterRole = $state<Role | "">("");
  let filterStatus = $state<"active" | "pending" | "expired" | "inactive" | "">("");
  let showAnonymized = $state(false);

  // Pagination
  let empPage = $state(1);
  let empPageSize = $state(10);

  let filteredEmployees = $derived(
    employees.filter((emp) => {
      // Hide anonymized employees by default
      if (!showAnonymized && isAnonymized(emp)) return false;
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        const match =
          `${emp.firstName} ${emp.lastName} ${emp.user.email} ${emp.employeeNumber}`.toLowerCase();
        if (!match.includes(q)) return false;
      }
      if (filterRole && emp.user.role !== filterRole) return false;
      if (filterStatus) {
        if (filterStatus === "active" && !emp.user.isActive) return false;
        if (filterStatus === "pending" && (emp.user.isActive || emp.invitationStatus !== "PENDING"))
          return false;
        if (filterStatus === "expired" && (emp.user.isActive || emp.invitationStatus !== "EXPIRED"))
          return false;
        if (
          filterStatus === "inactive" &&
          (emp.user.isActive ||
            emp.invitationStatus === "PENDING" ||
            emp.invitationStatus === "EXPIRED")
        )
          return false;
      }
      return true;
    }),
  );

  let pagedEmployees = $derived(
    filteredEmployees.slice((empPage - 1) * empPageSize, empPage * empPageSize),
  );

  // KPI mini-stats (exclude anonymized)
  let statTotal = $derived(employees.filter((e) => !isAnonymized(e)).length);
  let statActive = $derived(employees.filter((e) => e.user.isActive && !isAnonymized(e)).length);
  let statManagers = $derived(
    employees.filter((e) => e.user.role === "MANAGER" && !isAnonymized(e)).length,
  );
  let statAdmins = $derived(
    employees.filter((e) => e.user.role === "ADMIN" && !isAnonymized(e)).length,
  );

  $effect(() => {
    filteredEmployees.length;
    empPage = 1;
  });

  onMount(loadEmployees);

  async function loadEmployees() {
    loading = true;
    error = "";
    try {
      employees = await api.get<Employee[]>("/employees");
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    cFirstName = "";
    cLastName = "";
    cEmail = "";
    cEmployeeNumber = "";
    cHireDate = new Date().toISOString().split("T")[0];
    cRole = "EMPLOYEE";
    cScheduleType = "FIXED_WEEKLY";
    cWeeklyHours = 40;
    cMonthlyHours = null;
    cUsePassword = false;
    cPassword = "";
    createError = "";
    createEmailError = "";
    createOpen = true;
  }

  async function createEmployee() {
    creating = true;
    createError = "";
    createEmailError = "";
    try {
      const payload: Record<string, unknown> = {
        email: cEmail,
        firstName: cFirstName,
        lastName: cLastName,
        employeeNumber: cEmployeeNumber,
        hireDate: new Date(cHireDate).toISOString(),
        role: cRole,
        scheduleType: cScheduleType,
        weeklyHours: cScheduleType === "FIXED_WEEKLY" ? cWeeklyHours : 0,
        monthlyHours: cScheduleType === "MONTHLY_HOURS" ? cMonthlyHours : null,
      };
      if (cUsePassword && cPassword) payload.password = cPassword;
      const res = await api.post<Employee & { emailError?: string }>("/employees", payload);
      employees = [...employees, res].sort((a, b) => a.lastName.localeCompare(b.lastName));
      createOpen = false;
      if (res.emailError) {
        alert(
          `Mitarbeiter angelegt, aber Einladungsmail konnte nicht gesendet werden: ${res.emailError}`,
        );
      }
    } catch (e: unknown) {
      createError = e instanceof Error ? e.message : "Fehler beim Anlegen";
    } finally {
      creating = false;
    }
  }

  function openEdit(emp: Employee) {
    editingEmployee = emp;
    eFirstName = emp.firstName;
    eLastName = emp.lastName;
    eEmployeeNumber = emp.employeeNumber;
    eRole = emp.user.role;
    eNfcCardId = emp.nfcCardId ?? "";
    eExitDate = emp.exitDate ? emp.exitDate.split("T")[0] : "";
    editError = "";
    editOpen = true;
  }

  async function saveEdit() {
    if (!editingEmployee) return;
    editSaving = true;
    editError = "";
    try {
      const res = await api.patch<Employee & { proRataWarning?: { message: string } }>(
        `/employees/${editingEmployee.id}`,
        {
          firstName: eFirstName,
          lastName: eLastName,
          employeeNumber: eEmployeeNumber,
          role: eRole,
          nfcCardId: eNfcCardId || null,
          exitDate: eExitDate ? new Date(eExitDate).toISOString() : null,
        },
      );
      employees = employees.map((e) =>
        e.id === editingEmployee!.id
          ? {
              ...e,
              firstName: eFirstName,
              lastName: eLastName,
              employeeNumber: eEmployeeNumber,
              nfcCardId: eNfcCardId || null,
              exitDate: eExitDate ? new Date(eExitDate).toISOString() : null,
              user: { ...e.user, role: eRole },
            }
          : e,
      );
      editOpen = false;
      if (res.proRataWarning) {
        toasts.warning(res.proRataWarning.message, 8000);
      }
    } catch (e: unknown) {
      editError = e instanceof Error ? e.message : "Fehler beim Speichern";
    } finally {
      editSaving = false;
    }
  }

  async function resendInvitation(emp: Employee) {
    try {
      await api.post(`/employees/${emp.id}/resend-invitation`, {});
      alert("Einladung erneut gesendet.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Senden");
    }
  }

  // Activation confirm dialog (deactivate + reactivate share one dialog)
  let activationConfirm = $state<{
    open: boolean;
    emp: Employee | null;
    action: "deactivate" | "reactivate" | null;
  }>({ open: false, emp: null, action: null });

  function askDeactivate(emp: Employee) {
    activationConfirm = { open: true, emp, action: "deactivate" };
  }

  function askReactivate(emp: Employee) {
    activationConfirm = { open: true, emp, action: "reactivate" };
  }

  async function confirmActivationChange() {
    const { emp, action } = activationConfirm;
    if (!emp || !action) return;
    try {
      await api.patch(`/employees/${emp.id}/${action}`, {});
      if (action === "deactivate") {
        employees = employees.map((e) =>
          e.id === emp.id ? { ...e, user: { ...e.user, isActive: false } } : e,
        );
      } else {
        await loadEmployees();
      }
    } catch (e: unknown) {
      alert(
        e instanceof Error
          ? e.message
          : action === "deactivate"
            ? "Fehler beim Deaktivieren"
            : "Fehler beim Reaktivieren",
      );
    }
  }

  function confirmAnonymize(emp: Employee) {
    anonymizingEmployee = emp;
    anonOpen = true;
  }

  async function doAnonymize() {
    if (!anonymizingEmployee) return;
    anonymizing = true;
    try {
      await api.delete(`/employees/${anonymizingEmployee.id}`);
      anonOpen = false;
      anonymizingEmployee = null;
      // Refresh to show anonymized state
      await loadEmployees();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Fehler beim Anonymisieren");
    } finally {
      anonymizing = false;
    }
  }

  function confirmHardDelete(emp: Employee) {
    hardDeletingEmployee = emp;
    hardDeleteError = "";
    hardDeleteRetentionExpiresAt = null;
    hardDeleteForce = false;
    hardDelOpen = true;
  }

  async function doHardDelete() {
    if (!hardDeletingEmployee) return;
    hardDeleting = true;
    hardDeleteError = "";
    try {
      const body = hardDeleteForce ? { forceDelete: true } : undefined;
      await api.delete(`/employees/${hardDeletingEmployee.id}/hard-delete`, body);
      employees = employees.filter((e) => e.id !== hardDeletingEmployee!.id);
      hardDelOpen = false;
      hardDeletingEmployee = null;
      hardDeleteRetentionExpiresAt = null;
      hardDeleteForce = false;
    } catch (e: unknown) {
      if (e instanceof Error) {
        hardDeleteError = e.message;
        // Extract retentionExpiresAt from API error response data if present
        const apiData = (e as { data?: { retentionExpiresAt?: string } }).data;
        hardDeleteRetentionExpiresAt = apiData?.retentionExpiresAt ?? null;
      } else {
        hardDeleteError = "Fehler beim endgültigen Löschen";
      }
    } finally {
      hardDeleting = false;
    }
  }

  function roleLabel(role: Role): string {
    return role === "ADMIN" ? "Administrator" : role === "MANAGER" ? "Manager" : "Mitarbeiter";
  }

  function roleChipClass(role: Role): string {
    return role === "ADMIN" ? "chip chip-brand" : role === "MANAGER" ? "chip chip-warn" : "chip";
  }

  function statusLabel(emp: Employee): string {
    if (emp.user.isActive) return "Aktiv";
    if (emp.invitationStatus === "PENDING") return "Einladung ausstehend";
    if (emp.invitationStatus === "EXPIRED") return "Einladung abgelaufen";
    return "Inaktiv";
  }

  function statusClass(emp: Employee): string {
    if (emp.user.isActive) return "chip chip-good";
    if (emp.invitationStatus === "PENDING") return "chip chip-warn";
    if (emp.invitationStatus === "EXPIRED") return "chip chip-bad";
    return "chip";
  }
</script>

<svelte:head>
  <title>Mitarbeiter – Clokr</title>
</svelte:head>

<div class="page">
  <PageHead
    eyebrow="Administration"
    title="Mitarbeitende"
    accent="Mitarbeitende"
    sub="Einladungsbasiertes Onboarding · Rollen · CSV-Import · DSGVO-konforme Anonymisierung beim Löschen."
  >
    {#snippet actions()}
      {#if isAdmin}
        <button class="btn btn-primary" onclick={openCreate}>+ Mitarbeiter anlegen</button>
      {/if}
    {/snippet}
  </PageHead>

  {#if loading}
    <div class="loading">Laden…</div>
  {:else if error}
    <div class="callout error">{error}</div>
  {:else if employees.length === 0}
    <div class="empty-state">
      <p>Noch keine Mitarbeiter angelegt.</p>
      {#if isAdmin}<button class="btn btn-primary" onclick={openCreate}>Jetzt anlegen</button>{/if}
    </div>
  {:else}
    <!-- ── KPI cluster ──────────────────────────────────────────────────── -->
    <Card animate class="kpi-card">
      <CardHeader title="Übersicht" sub="Belegschaft auf einen Blick" />
      <div class="kpi-row">
        <KPIStat label="Mitarbeitende" value={String(statTotal)} unit="gesamt" />
        <KPIStat label="Aktiv" value={String(statActive)} unit="angemeldet" />
        <KPIStat label="Manager" value={String(statManagers)} unit="Rolle" />
        <KPIStat label="Administratoren" value={String(statAdmins)} unit="Rolle" />
      </div>
    </Card>

    <Card animate class="table-card">
      <CardHeader title="Personenverzeichnis" sub="Filter · Rollenwechsel · Einladungen" />
      <div class="table-toolbar">
        <input
          type="search"
          class="input filter-search"
          placeholder="Person suchen…"
          bind:value={filterSearch}
          aria-label="Mitarbeiter suchen"
        />
        <select
          class="select filter-select"
          bind:value={filterRole}
          aria-label="Nach Rolle filtern"
        >
          <option value="">Alle Rollen</option>
          <option value="ADMIN">Administrator</option>
          <option value="MANAGER">Manager</option>
          <option value="EMPLOYEE">Mitarbeiter</option>
        </select>
        <select
          class="select filter-select"
          bind:value={filterStatus}
          aria-label="Nach Status filtern"
        >
          <option value="">Alle Status</option>
          <option value="active">Aktiv</option>
          <option value="pending">Einladung ausstehend</option>
          <option value="expired">Einladung abgelaufen</option>
          <option value="inactive">Inaktiv</option>
        </select>
        <label class="filter-checkbox">
          <input type="checkbox" bind:checked={showAnonymized} />
          Anonymisierte anzeigen
        </label>
        <span class="spacer"></span>
        <span class="filter-count">{filteredEmployees.length} von {employees.length}</span>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Name</th>
              <th>E-Mail</th>
              <th>Rolle</th>
              <th>Eintritt</th>
              <th>Status</th>
              <th>Letzter Login</th>
              {#if isAdmin}<th>Aktionen</th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each pagedEmployees as emp (emp.id)}
              <tr class:row-inactive={!emp.user.isActive}>
                <td class="col-number num">{emp.employeeNumber}</td>
                <td class="col-name">
                  <strong>{emp.lastName}, {emp.firstName}</strong>
                </td>
                <td class="col-email">{emp.user.email}</td>
                <td>
                  <span class={roleChipClass(emp.user.role)}>
                    <span class="dot"></span>{roleLabel(emp.user.role)}
                  </span>
                </td>
                <td class="col-date"
                  >{new Date(emp.hireDate).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}</td
                >
                <td>
                  <span class={statusClass(emp)}>
                    <span class="dot"></span>{statusLabel(emp)}
                  </span>
                </td>
                <td class="col-login">
                  {emp.user.lastLoginAt
                    ? new Date(emp.user.lastLoginAt).toLocaleDateString("de-DE", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      })
                    : "—"}
                </td>
                {#if isAdmin}
                  <td class="col-actions">
                    <div class="action-group">
                      {#if !emp.user.isActive && (emp.invitationStatus === "PENDING" || emp.invitationStatus === "EXPIRED")}
                        <button
                          class="btn btn-ghost btn-sm"
                          onclick={() => resendInvitation(emp)}
                          title="Einladung erneut senden"
                        >
                          Einladen
                        </button>
                      {/if}
                      <button class="btn btn-ghost btn-sm" onclick={() => openEdit(emp)}
                        >Bearbeiten</button
                      >
                      {#if emp.user.isActive}
                        <button class="btn btn-ghost btn-sm" onclick={() => askDeactivate(emp)}
                          >Deaktivieren</button
                        >
                      {:else}
                        <button class="btn btn-ghost btn-sm" onclick={() => askReactivate(emp)}
                          >Reaktivieren</button
                        >
                      {/if}
                      {#if isAnonymized(emp)}
                        <button
                          class="btn btn-danger btn-sm"
                          onclick={() => confirmHardDelete(emp)}
                          title="Endgültig löschen (nur nach Ablauf der Aufbewahrungsfrist)"
                        >
                          Endgültig löschen
                        </button>
                      {:else}
                        <button class="btn btn-danger btn-sm" onclick={() => confirmAnonymize(emp)}>
                          Anonymisieren
                        </button>
                      {/if}
                    </div>
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination
        total={filteredEmployees.length}
        bind:page={empPage}
        bind:pageSize={empPageSize}
      />
    </Card>
  {/if}
</div>

<!-- ── Anlegen Modal ──────────────────────────────────────────────────────── -->
<Modal bind:open={createOpen} eyebrow="Mitarbeiter einladen" title="Person einladen">
  {#if createError}
    <div class="callout error">{createError}</div>
  {/if}
  {#if createEmailError}
    <div class="callout">
      Mitarbeiter angelegt, aber: {createEmailError}
    </div>
  {:else}
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="c-firstname">Vorname</label>
        <input id="c-firstname" type="text" bind:value={cFirstName} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-lastname">Nachname</label>
        <input id="c-lastname" type="text" bind:value={cLastName} class="input" required />
      </div>
      <div class="form-group form-group--full">
        <label class="form-label" for="c-email">E-Mail-Adresse</label>
        <input id="c-email" type="email" bind:value={cEmail} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-empno">Mitarbeiter-Nr.</label>
        <input id="c-empno" type="text" bind:value={cEmployeeNumber} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-hiredate">Eintrittsdatum</label>
        <input id="c-hiredate" type="date" bind:value={cHireDate} class="input" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="c-role">Rolle</label>
        <select id="c-role" bind:value={cRole} class="select">
          <option value="EMPLOYEE">Mitarbeiter</option>
          <option value="MANAGER">Manager</option>
          <option value="ADMIN">Administrator</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="c-schedule-type">Arbeitszeitmodell</label>
        <select id="c-schedule-type" bind:value={cScheduleType} class="select">
          <option value="FIXED_WEEKLY">Feste Wochenstunden</option>
          <option value="MONTHLY_HOURS">Monatsstunden (Minijob)</option>
        </select>
      </div>
      {#if cScheduleType === "FIXED_WEEKLY"}
        <div class="form-group">
          <label class="form-label" for="c-hours">Wochenstunden</label>
          <input
            id="c-hours"
            type="number"
            bind:value={cWeeklyHours}
            class="input"
            min="1"
            max="60"
            step="0.5"
          />
        </div>
      {:else}
        <div class="form-group">
          <label class="form-label" for="c-monthly-hours"
            >Stunden/Monat <span class="text-muted">(optional)</span></label
          >
          <input
            id="c-monthly-hours"
            type="number"
            bind:value={cMonthlyHours}
            class="input"
            min="0"
            max="200"
            step="0.5"
            placeholder="z.B. 15 — leer = nur Tracking"
          />
        </div>
      {/if}
      <div class="form-group form-group--full">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={cUsePassword} />
          Passwort direkt setzen (statt Einladungsmail)
        </label>
      </div>
      {#if cUsePassword}
        <div class="form-group form-group--full">
          <label class="form-label" for="c-password">Passwort</label>
          <input
            id="c-password"
            type="password"
            bind:value={cPassword}
            class="input"
            minlength="8"
            placeholder="Mindestens 8 Zeichen"
            required
          />
          <p class="hint">Mitarbeiter kann sich sofort anmelden. Kein Einladungslink nötig.</p>
        </div>
      {/if}
    </div>

    <div class="callout brand">
      <div>
        Die Person erhält per E-Mail einen Einladungslink. Stammdaten werden beim ersten Login
        vervollständigt.
      </div>
    </div>
  {/if}
  {#snippet footer()}
    {#if !createEmailError}
      <button class="btn btn-ghost" onclick={() => (createOpen = false)}>Abbrechen</button>
      <button class="btn btn-primary" onclick={createEmployee} disabled={creating}>
        {creating ? "Anlegen…" : "Mitarbeiter anlegen"}
      </button>
    {:else}
      <button class="btn btn-primary" onclick={() => (createOpen = false)}>Schließen</button>
    {/if}
  {/snippet}
</Modal>

<!-- ── Bearbeiten Modal ───────────────────────────────────────────────────── -->
{#if editingEmployee}
  <Modal bind:open={editOpen} eyebrow="Stammdaten" title="Mitarbeiter bearbeiten">
    {#if editError}
      <div class="callout error">{editError}</div>
    {/if}
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="e-firstname">Vorname</label>
        <input id="e-firstname" type="text" bind:value={eFirstName} class="input" />
      </div>
      <div class="form-group">
        <label class="form-label" for="e-lastname">Nachname</label>
        <input id="e-lastname" type="text" bind:value={eLastName} class="input" />
      </div>
      <div class="form-group">
        <label class="form-label" for="e-empno">Mitarbeiter-Nr.</label>
        <input id="e-empno" type="text" bind:value={eEmployeeNumber} class="input" />
      </div>
      <div class="form-group">
        <label class="form-label" for="e-role">Rolle</label>
        <select id="e-role" bind:value={eRole} class="select">
          <option value="EMPLOYEE">Mitarbeiter</option>
          <option value="MANAGER">Manager</option>
          <option value="ADMIN">Administrator</option>
        </select>
      </div>
      <div class="form-group form-group--full">
        <label class="form-label" for="e-exitdate">Austrittsdatum (optional)</label>
        <input id="e-exitdate" type="date" bind:value={eExitDate} class="input" />
        <p class="hint">
          Bei gesetztem Datum wird der Jahresurlaub anteilig berechnet (<span translate="no"
            >§ 5 Abs. 2 BUrlG</span
          >).
        </p>
      </div>
      <div class="form-group form-group--full">
        <label class="form-label" for="e-nfc">NFC-Karten-ID</label>
        <input
          id="e-nfc"
          type="text"
          bind:value={eNfcCardId}
          class="input"
          placeholder="z.B. NFC-A1B2C3D4"
        />
        <p class="hint">Optional. Ermöglicht Stempeln per NFC-Karte.</p>
      </div>
    </div>
    {#snippet footer()}
      <button class="btn btn-ghost" onclick={() => (editOpen = false)}>Abbrechen</button>
      <button class="btn btn-primary" onclick={saveEdit} disabled={editSaving}>
        {editSaving ? "Speichern…" : "Speichern"}
      </button>
    {/snippet}
  </Modal>
{/if}

<!-- ── Anonymisieren Bestätigung (Schritt 1) ─────────────────────────────── -->
{#if anonymizingEmployee}
  <Modal bind:open={anonOpen} eyebrow="DSGVO Art. 17" title="Mitarbeiter anonymisieren">
    <p>
      Möchten Sie <strong>{anonymizingEmployee.firstName} {anonymizingEmployee.lastName}</strong>
      wirklich anonymisieren?
    </p>
    <div class="callout">
      Persönliche Daten (Name, E-Mail, Notizen) werden gemäß <span translate="no">DSGVO</span>
      gelöscht. Zeiteinträge, Urlaubsanträge und Salden bleiben aus rechtlichen Gründen für die Aufbewahrungsfrist
      (10 Jahre nach <span translate="no">§ 147 AO</span>) erhalten. Erst danach kann der Datensatz
      endgültig gelöscht werden.
    </div>
    {#snippet footer()}
      <button
        class="btn btn-ghost"
        onclick={() => {
          anonOpen = false;
          anonymizingEmployee = null;
        }}>Abbrechen</button
      >
      <button class="btn btn-danger" onclick={doAnonymize} disabled={anonymizing}>
        {anonymizing ? "Anonymisieren…" : "Anonymisieren"}
      </button>
    {/snippet}
  </Modal>
{/if}

<!-- ── Endgültig löschen Bestätigung (Schritt 2) ────────────────────────── -->
{#if hardDeletingEmployee}
  <Modal bind:open={hardDelOpen} eyebrow="Endgültige Löschung" title="Datensatz löschen">
    {#if hardDeleteError && !hardDeleteRetentionExpiresAt}
      <div class="callout error">{hardDeleteError}</div>
    {/if}
    {#if hardDeleteRetentionExpiresAt}
      <div class="callout">
        <b>Aufbewahrungsfrist noch nicht abgelaufen.</b>
        Die gesetzliche Aufbewahrungsfrist (<span translate="no">§ 147 AO</span>, 10 Jahre) läuft ab
        am:
        <strong
          >{new Date(hardDeleteRetentionExpiresAt).toLocaleDateString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })}</strong
        >.
      </div>
      <label class="force-delete-checkbox">
        <input type="checkbox" bind:checked={hardDeleteForce} />
        Ich bestätige, dass ich diese Aufbewahrungsfrist kenne und den Datensatz trotzdem unwiderruflich
        löschen möchte (z. B. Testdaten). Diese Aktion wird im Audit-Log protokolliert.
      </label>
    {/if}
    <p>
      Den anonymisierten Datensatz von <strong>{hardDeletingEmployee.employeeNumber}</strong> endgültig
      und unwiderruflich löschen?
    </p>
    <p class="hint danger-hint">
      Diese Aktion entfernt alle verbleibenden Daten dauerhaft (<span translate="no">DSGVO</span>
      Art. 17). Sie ist nur nach Ablauf der gesetzlichen Aufbewahrungsfrist (<span translate="no"
        >§ 147 AO</span
      >, 10 Jahre) möglich.
    </p>
    {#snippet footer()}
      <button
        class="btn btn-ghost"
        onclick={() => {
          hardDelOpen = false;
          hardDeletingEmployee = null;
          hardDeleteError = "";
          hardDeleteRetentionExpiresAt = null;
          hardDeleteForce = false;
        }}>Abbrechen</button
      >
      <button
        class="btn btn-danger"
        onclick={doHardDelete}
        disabled={hardDeleting || (hardDeleteRetentionExpiresAt !== null && !hardDeleteForce)}
      >
        {hardDeleting ? "Löschen…" : "Endgültig löschen"}
      </button>
    {/snippet}
  </Modal>
{/if}

<!-- ── Bestätigung: Aktivierungsstatus ändern ─────────────────────────────── -->
{#if activationConfirm.emp}
  <ConfirmDialog
    bind:open={activationConfirm.open}
    title={activationConfirm.action === "deactivate"
      ? "Mitarbeiter deaktivieren?"
      : "Mitarbeiter reaktivieren?"}
    description={activationConfirm.action === "deactivate"
      ? `${activationConfirm.emp.firstName} ${activationConfirm.emp.lastName} kann sich nach der Deaktivierung nicht mehr anmelden. Die Zeitdaten bleiben erhalten.`
      : `${activationConfirm.emp.firstName} ${activationConfirm.emp.lastName} kann sich nach der Reaktivierung wieder anmelden.`}
    confirmLabel={activationConfirm.action === "deactivate" ? "Deaktivieren" : "Reaktivieren"}
    danger={activationConfirm.action === "deactivate"}
    onConfirm={confirmActivationChange}
  />
{/if}

<style>
  .page {
    /* max-width inherited from .app-main */
  }

  .loading {
    padding: 48px;
    text-align: center;
    color: var(--text-muted);
  }

  .empty-state {
    text-align: center;
    padding: 64px 32px;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  /* ── KPI card (v1.5) ────────────────────────────────────────────────── */
  :global(.kpi-card) {
    margin-bottom: 18px;
  }
  .kpi-row {
    display: flex;
    align-items: flex-end;
    gap: 32px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  /* Table card */
  :global(.table-card) {
    padding: 0;
    margin-bottom: 18px;
  }

  .table-toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    padding: 14px 18px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .filter-search {
    flex: 0 1 280px;
    min-width: 200px;
  }
  .filter-select {
    flex: 0 0 auto;
    min-width: 170px;
  }
  .filter-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    white-space: nowrap;
    cursor: pointer;
  }
  .filter-checkbox input[type="checkbox"] {
    cursor: pointer;
  }
  .filter-count {
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .spacer {
    flex: 1;
  }

  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .table th {
    background: var(--bg-subtle);
    padding: 12px 16px;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .table td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
    color: var(--text);
  }
  .table tbody tr:last-child td {
    border-bottom: none;
  }
  .table tbody tr:hover {
    background: var(--bg-subtle);
  }

  .row-inactive {
    opacity: 0.6;
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .col-number {
    color: var(--text-muted);
    width: 80px;
  }
  .col-email {
    color: var(--text-muted);
  }
  .col-date,
  .col-login {
    color: var(--text-muted);
    font-size: 13px;
  }
  .col-actions {
    width: 240px;
  }

  .action-group {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Slightly compact buttons inside the actions column */
  .action-group :global(.btn.btn-sm) {
    padding: 6px 10px;
    font-size: 12.5px;
  }

  /* Form helpers used inside modals */
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  @media (max-width: 480px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .form-group--full {
    grid-column: 1 / -1;
  }
  .form-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    color: var(--text);
    cursor: pointer;
  }

  .hint {
    font-size: 13px;
    color: var(--text-muted);
    margin: 4px 0 0;
  }
  .danger-hint {
    color: var(--bad);
  }
  .text-muted {
    color: var(--text-muted);
    font-weight: 400;
  }

  .force-delete-checkbox {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13.5px;
    color: var(--text);
    cursor: pointer;
    margin: 8px 0 4px;
    line-height: 1.45;
  }
  .force-delete-checkbox input[type="checkbox"] {
    flex-shrink: 0;
    margin-top: 2px;
    cursor: pointer;
  }
</style>
