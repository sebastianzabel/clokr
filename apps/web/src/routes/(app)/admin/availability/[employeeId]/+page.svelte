<script lang="ts">
  // Phase 260523-0qf, Task 3 — per-employee availability detail page.
  // Accessed via /admin/availability/[employeeId].
  //
  // ADMIN + MANAGER only (server enforces 403).
  //
  // F-21 fix: 410 + AVAILABILITY_FEATURE_DISABLED is detected and shown as
  // an actionable empty state instead of silently swallowed. The backend 410
  // is CORRECT (Phase 47.3 feature toggle) — this is a UX bug on the web side.

  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { toasts } from "$stores/toast";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import AvailabilityWeekGrid, {
    type RecurringEntry,
  } from "$lib/components/availability/AvailabilityWeekGrid.svelte";
  import AvailabilityOneOffList, {
    type OneOffEntry,
  } from "$lib/components/availability/AvailabilityOneOffList.svelte";

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
  }

  interface ApiAvailabilityEntry {
    id: string;
    employeeId: string;
    dayOfWeek: number | null;
    date: string | null;
    status: Status;
    note: string | null;
    validFrom: string;
    validUntil: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string | null;
  }

  interface AvailabilityListResponse {
    entries: ApiAvailabilityEntry[];
  }

  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  const employeeId = $derived($page.params.employeeId);

  let employee = $state<Employee | null>(null);
  let recurringEntries = $state<RecurringEntry[]>([]);
  let oneOffEntries = $state<OneOffEntry[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let loadError = $state("");
  let featureDisabled = $state(false);
  let lastSnapshot = $state("");

  // WR-01 (109-REVIEW-FIX.md): `lastSnapshot` is assigned in exactly one place — the last
  // statement of applyEntries() — and onMount has paths that never reach it (a rejected employee
  // request returns early; a rejected availability request that is not a 410 falls through).
  // Without this flag `lastSnapshot` stays "" while `currentSnapshot` is `{"r":[],"o":[]}`, so
  // `dirty` reads true on a page that shows nothing but an error: the Speichern button is enabled
  // and would PUT an empty entries array. Setting the flag AT the single baseline site rather
  // than "at the end of onMount's try" is deliberate — this onMount has several exits, and a
  // trailing assignment would have to be duplicated into each of them correctly.
  let snapshotsReady = $state(false);

  const currentSnapshot = $derived(JSON.stringify({ r: recurringEntries, o: oneOffEntries }));

  const dirty = $derived(
    snapshotsReady && !loading && !featureDisabled && currentSnapshot !== lastSnapshot,
  );

  function applyEntries(entries: ApiAvailabilityEntry[]): void {
    const recurring: RecurringEntry[] = [];
    const oneoff: OneOffEntry[] = [];
    for (const e of entries) {
      if (e.dayOfWeek != null) {
        recurring.push({
          id: e.id,
          dayOfWeek: e.dayOfWeek,
          status: e.status,
          note: e.note,
          validFrom: e.validFrom?.slice(0, 10) ?? todayISO(),
          validUntil: e.validUntil ? e.validUntil.slice(0, 10) : null,
        });
      } else if (e.date != null) {
        oneoff.push({
          id: e.id,
          date: e.date.slice(0, 10),
          status: e.status,
          note: e.note,
          validFrom: e.validFrom?.slice(0, 10) ?? todayISO(),
          validUntil: e.validUntil ? e.validUntil.slice(0, 10) : null,
        });
      }
    }
    recurringEntries = recurring;
    oneOffEntries = oneoff;
    lastSnapshot = JSON.stringify({ r: recurringEntries, o: oneOffEntries });
    snapshotsReady = true;
  }

  function buildPayload() {
    const recurring = recurringEntries.map((e) => ({
      dayOfWeek: e.dayOfWeek,
      date: null,
      status: e.status,
      note: e.note ?? null,
      validFrom: e.validFrom ?? todayISO(),
      validUntil: e.validUntil ?? null,
    }));
    const oneoff = oneOffEntries.map((e) => ({
      dayOfWeek: null,
      date: e.date,
      status: e.status,
      note: e.note ?? null,
      validFrom: e.validFrom ?? todayISO(),
      validUntil: e.validUntil ?? null,
    }));
    return { entries: [...recurring, ...oneoff] };
  }

  async function save(): Promise<void> {
    if (saving || featureDisabled) return;
    saving = true;
    try {
      const res = await api.put<AvailabilityListResponse>(
        `/employees/${employeeId}/availability`,
        buildPayload(),
      );
      applyEntries(res.entries ?? []);
      toasts.success("Verfügbarkeit gespeichert.");
    } catch (err) {
      const fallback = "Die Verfügbarkeit konnte nicht gespeichert werden. Bitte erneut versuchen.";
      const msg = err instanceof ApiError && err.status < 500 ? err.message : fallback;
      toasts.error(msg);
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    // Client-side UX redirect — server still enforces 403.
    const role = $authStore.user?.role;
    if (role === "EMPLOYEE") {
      void goto("/availability");
      return;
    }

    void (async () => {
      loading = true;
      const [empRes, avRes] = await Promise.allSettled([
        api.get<Employee>(`/employees/${employeeId}`),
        api.get<AvailabilityListResponse>(`/employees/${employeeId}/availability`),
      ]);

      if (empRes.status === "fulfilled") {
        employee = empRes.value;
      } else {
        const err = empRes.reason as ApiError;
        loadError =
          err instanceof ApiError ? err.message : "Mitarbeiter konnte nicht geladen werden.";
        loading = false;
        return;
      }

      if (avRes.status === "rejected") {
        const err = avRes.reason as { status?: number; data?: { code?: string } };
        if (err?.status === 410 && err?.data?.code === "AVAILABILITY_FEATURE_DISABLED") {
          featureDisabled = true;
          tenantFeatures.applyLocal(false);
        }
        // For any other rejection: availabilityData stays empty — show generic error
        // only if employee itself failed to load (handled above via loadError).
      } else {
        applyEntries(avRes.value.entries ?? []);
      }

      loading = false;
    })();
  });
</script>

<ListDetail
  view="detail"
  eyebrow="Administration"
  title={employee ? `${employee.firstName} ${employee.lastName}` : "Verfügbarkeit"}
  sub="Wann kann dieser Mitarbeiter arbeiten? Urlaub und Abwesenheit werden automatisch berücksichtigt."
  crumbs={[
    { label: "Verfügbarkeit", href: "/admin/availability" },
    { label: employee ? `${employee.firstName} ${employee.lastName}` : "Detail" },
  ]}
>
  {#snippet actions()}
    <a class="btn btn-ghost btn-sm" href="/admin/availability">Zurück</a>
    <button
      class="btn btn-primary btn-sm"
      disabled={featureDisabled || !dirty || saving}
      onclick={save}
    >
      {saving ? "Speichert…" : "Speichern"}
    </button>
  {/snippet}
  {#snippet tabContent(_tab)}
    {#if loading}
      <div class="av-loading" role="status" aria-label="Laden…">
        <span class="av-loading-dot"></span>
      </div>
    {:else if loadError}
      <Section>
        <div class="av-load-error">
          <p class="av-load-error-msg">{loadError}</p>
          <a class="btn btn-secondary btn-sm" href="/admin/availability">Zurück zur Übersicht</a>
        </div>
      </Section>
    {:else if featureDisabled}
      <div class="av-feature-disabled" role="status">
        <div class="av-feature-disabled-icon" aria-hidden="true">⚙️</div>
        <h2 class="av-feature-disabled-title">Verfügbarkeits-System deaktiviert</h2>
        <p class="av-feature-disabled-body">
          Diese Funktion ist für deinen Tenant deaktiviert. Aktiviere sie in den
          System-Einstellungen unter <strong>Features</strong>.
        </p>
        <a class="btn btn-primary" href="/admin/system#features">Zu den Features</a>
      </div>
    {:else}
      <div class="alert alert-info" role="alert">
        <span aria-hidden="true">ℹ</span>
        <span
          >Urlaub und Abwesenheit werden automatisch als „nicht verfügbar" angezeigt — bitte direkt
          in der jeweiligen Quelle bearbeiten.</span
        >
      </div>

      <Section title="Wochenraster">
        <AvailabilityWeekGrid bind:entries={recurringEntries} disabled={loading} />
      </Section>

      <Section title="Einmaltermine">
        <AvailabilityOneOffList bind:entries={oneOffEntries} disabled={loading} />
      </Section>
    {/if}
  {/snippet}
</ListDetail>

<style>
  .av-loading {
    display: flex;
    justify-content: center;
    padding: var(--s-8) 0;
  }

  .av-loading-dot {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--brand);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .av-load-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-6) var(--s-4);
    text-align: center;
  }

  .av-load-error-msg {
    color: var(--bad);
    margin: 0;
  }

  .av-feature-disabled {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--s-3);
    padding: var(--s-8) var(--s-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    color: var(--text);
  }

  .av-feature-disabled-icon {
    font-size: 48px;
    line-height: 1;
  }

  .av-feature-disabled-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
    margin: 0;
    color: var(--text);
  }

  .av-feature-disabled-body {
    margin: 0;
    max-width: 480px;
    color: var(--text-muted);
    font-size: 0.9375rem;
    line-height: 1.55;
  }
</style>
