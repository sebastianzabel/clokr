<script lang="ts">
  // Phase 55 — Admin availability list page.
  // Shows all employees as clickable rows linking to /admin/availability/[employeeId].
  // ADMIN + MANAGER only (server enforces 403; client redirects EMPLOYEE to /availability).

  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
  }

  let employees = $state<Employee[]>([]);
  let loading = $state(true);
  let search = $state("");

  const filtered = $derived(
    search.trim()
      ? employees.filter(
          (e) =>
            `${e.firstName} ${e.lastName}`.toLowerCase().includes(search.trim().toLowerCase()) ||
            (e.employeeNumber ?? "").toLowerCase().includes(search.trim().toLowerCase()),
        )
      : employees,
  );

  async function loadEmployees(): Promise<void> {
    try {
      const list = await api.get<Employee[]>("/employees?limit=500");
      employees = list ?? [];
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Mitarbeiter konnten nicht geladen werden.";
      toasts.error(msg);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    // Client-side UX redirect — server still enforces 403.
    const role = $authStore.user?.role;
    if (role === "EMPLOYEE") {
      void goto("/availability");
      return;
    }
    void loadEmployees();
  });
</script>

<ListDetail
  view="list"
  eyebrow="Planung"
  title="Verfügbarkeit"
  sub="Wer kann wann arbeiten?"
  animate
>
  {#snippet list()}
    <Section title="Mitarbeiter" sub="Wähle einen Mitarbeiter, um seine Verfügbarkeit zu bearbeiten.">
      <div class="av-list-toolbar">
        <input
          type="search"
          class="form-input av-search"
          placeholder="Suchen…"
          bind:value={search}
          aria-label="Mitarbeiter suchen"
        />
      </div>

      {#if loading}
        <div class="av-empty-state">
          <p class="av-empty-body">Lade Mitarbeiter…</p>
        </div>
      {:else if filtered.length === 0}
        <div class="av-empty-state">
          <h3 class="av-empty-title">Keine Mitarbeiter gefunden</h3>
          <p class="av-empty-body">Passe die Suche an oder lege neue Mitarbeiter an.</p>
        </div>
      {:else}
        <table class="av-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Personalnummer</th>
              <th scope="col" aria-label="Aktion"></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as emp (emp.id)}
              <tr
                class="av-row"
                role="button"
                tabindex="0"
                onclick={() => goto(`/admin/availability/${emp.id}`)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void goto(`/admin/availability/${emp.id}`);
                  }
                }}
              >
                <td class="av-cell av-cell--name">{emp.firstName} {emp.lastName}</td>
                <td class="av-cell av-cell--number">{emp.employeeNumber ?? "—"}</td>
                <td class="av-cell av-cell--arrow" aria-hidden="true">›</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </Section>
  {/snippet}
</ListDetail>

<style>
  .av-list-toolbar {
    padding: 0 0 var(--s-3);
  }

  .av-search {
    max-width: 320px;
    width: 100%;
  }

  .av-table {
    width: 100%;
    border-collapse: collapse;
  }

  .av-table thead th {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: var(--s-2) var(--s-3);
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .av-row {
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .av-row:hover {
    background: var(--bg-subtle);
  }

  .av-row:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }

  .av-cell {
    padding: var(--s-3);
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 0.9375rem;
  }

  .av-cell--name {
    font-weight: 500;
  }

  .av-cell--number {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.875rem;
  }

  .av-cell--arrow {
    width: 32px;
    text-align: right;
    color: var(--text-muted);
    font-size: 1.25rem;
    line-height: 1;
  }

  .av-empty-state {
    text-align: center;
    padding: var(--s-8) var(--s-4);
  }

  .av-empty-title {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text);
    margin: 0 0 var(--s-2);
  }

  .av-empty-body {
    color: var(--text-muted);
    max-width: 420px;
    margin: 0 auto;
    line-height: 1.5;
  }
</style>
