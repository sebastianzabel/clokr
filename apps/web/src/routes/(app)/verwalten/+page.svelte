<!--
  Issue #847: Verwalten › Übersicht — the start page of a pure administration role (Z-02) and the hub of
  the Verwalten area. Open administrative tasks (counted, linked), the setup checklist and the warnings
  of a contradictory configuration; below them the hub list (#844). Every source is read only with its
  own permission; an unread source shows no check (never a fake „offen“). The rules live in
  `$lib/admin/setup-checks.ts`.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { format } from "date-fns";
  import HubPage from "$lib/components/layout/HubPage.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenPath } from "$lib/nav/routes";
  import {
    adminTaskCounts,
    mailWithoutDelivery,
    overdueMonthCloses,
    setupChecks,
    MAIL_WITHOUT_DELIVERY_TEXT,
    type EmployeeRow,
    type SalonRow,
    type SmtpAnswer,
    type TerminalRow,
    type WorkSettingsAnswer,
    type YearStatusMonth,
  } from "$lib/admin/setup-checks";

  const Z = (k: string) => `${k}:ZUGEWIESEN`;
  const may = (k: string) => hasPermission($authStore.user, Z(k));

  let loaded = $state(false);
  let salons = $state<SalonRow[] | null>(null);
  let employees = $state<EmployeeRow[] | null>(null);
  let smtp = $state<SmtpAnswer | null>(null);
  let security = $state<{ emailNotificationsEnabled?: boolean } | null>(null);
  let work = $state<WorkSettingsAnswer | null>(null);
  let terminals = $state<TerminalRow[] | null>(null);
  let overdue = $state<number | null>(null);
  let atRisk = $state<number | null>(null);

  const today = format(new Date(), "yyyy-MM-dd");

  /** A read that the caller may not make, or that fails, is `null` — never a fabricated value. */
  async function readIf<T>(allowed: boolean, path: string): Promise<T | null> {
    if (!allowed) return null;
    try {
      return await api.get<T>(path);
    } catch {
      return null;
    }
  }

  onMount(async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const years = month === 1 ? [year - 1, year] : [year];
    const canSettings = may("tenant-settings:read");
    const hardware = moduleBooked($salonContext, "HARDWARE_CLOCK");
    const [s, e, m, sec, w, t, ys, risk] = await Promise.all([
      readIf<SalonRow[] | { salons: SalonRow[] }>(may("salon:read"), "/salons").then((r) =>
        r === null ? null : Array.isArray(r) ? r : (r.salons ?? null),
      ),
      readIf<EmployeeRow[]>(may("employee:read"), "/employees"),
      readIf<SmtpAnswer>(canSettings, "/settings/smtp"),
      readIf<{ emailNotificationsEnabled?: boolean }>(canSettings, "/settings/security"),
      readIf<WorkSettingsAnswer>(canSettings, "/settings/work"),
      readIf<{ keys: TerminalRow[] }>(
        may("terminal:manage") && hardware !== false,
        "/terminals",
      ).then((r) => r?.keys ?? null),
      may("month-close:read")
        ? Promise.all(
            years.map((y) =>
              readIf<{ months: YearStatusMonth[] }>(
                true,
                `/overtime/close-month/year-status?year=${y}`,
              ).then((r) => (r ? { year: y, months: r.months } : null)),
            ),
          )
        : Promise.resolve(null),
      readIf<{ summary: { employeesAtRisk: number } }>(
        may("report:read"),
        "/reports/carryover-at-risk",
      ),
    ]);
    salons = s;
    employees = e;
    smtp = m;
    security = sec;
    work = w;
    terminals = t;
    overdue =
      ys && ys.every((y) => y !== null)
        ? overdueMonthCloses(ys as { year: number; months: YearStatusMonth[] }[], { year, month })
        : null;
    atRisk = risk ? risk.summary.employeesAtRisk : null;
    loaded = true;
  });

  const checks = $derived(setupChecks({ salons, employees, smtp, work, terminals }, today));
  const openChecks = $derived(checks.filter((c) => c.state === "offen").length);
  const counts = $derived(employees ? adminTaskCounts(employees, today) : null);
  const mailWarning = $derived(mailWithoutDelivery(security, smtp));

  /** A derivation link only where the caller may open the target (no dead link). */
  const linkIf = (href: string) => (mayOpenPath($authStore.user, href) ? href : undefined);

  const tasks = $derived.by((): KpiItem[] => {
    const items: KpiItem[] = [];
    if (overdue !== null)
      items.push({
        label: "Monatsabschlüsse offen",
        value: String(overdue),
        explanation: overdue === 0 ? "alle vergangenen Monate abgeschlossen" : "vergangene Monate",
        deltaTone: overdue > 0 ? "warn" : "neutral",
        derivationHref: linkIf("/verwalten/monatsabschluss"),
        derivationLabel: "Monatsabschluss →",
        testId: "admin-overdue",
      });
    if (counts) {
      items.push({
        label: "Einladungen offen",
        value: String(counts.pendingInvitations),
        explanation: "noch nicht angenommen",
        derivationHref: linkIf("/verwalten/personen"),
        derivationLabel: "Personen →",
        testId: "admin-invitations",
      });
      items.push({
        label: "Ohne Vertrag",
        value: String(counts.withoutContract),
        explanation: "Personen ohne Arbeitszeit",
        derivationHref: linkIf("/verwalten/personen"),
        derivationLabel: "Personen →",
        testId: "admin-no-contract",
      });
    }
    if (atRisk !== null)
      items.push({
        label: "Urlaubsverfall droht",
        value: String(atRisk),
        explanation: "Personen mit Resturlaub vor Ablauf (§ 7 BUrlG)",
        derivationHref: linkIf("/verwalten/berichte"),
        derivationLabel: "Berichte →",
        testId: "admin-carryover",
      });
    return items;
  });
</script>

<svelte:head>
  <title>{pageLabel("/verwalten")} – Clokr</title>
</svelte:head>

<HubPage
  title={pageLabel("/verwalten")}
  hub="/verwalten"
  sub="Was offen ist und was noch eingerichtet werden muss."
  listTitle="Alle Bereiche"
>
  {#snippet intro()}
    <div class="vw" data-testid="verwalten-overview">
      {#if mailWarning}
        <div data-testid="mail-warning">
          <Note tone="bad"
            >{MAIL_WITHOUT_DELIVERY_TEXT}
            <a href="/verwalten/system/allgemein">Mailserver einrichten</a></Note
          >
        </div>
      {/if}

      {#if !loaded}
        <Skeleton shape="card" />
      {:else if tasks.length > 0}
        <section aria-labelledby="vw-tasks">
          <h2 id="vw-tasks" class="vw-h2">Offene Aufgaben</h2>
          <KpiStrip band items={tasks} ariaLabel="Offene Aufgaben der Verwaltung" />
        </section>
      {/if}

      {#if loaded && checks.length > 0}
        <section aria-labelledby="vw-setup">
          <h2 id="vw-setup" class="vw-h2">
            Einrichtung
            <span class="vw-meta"
              >{openChecks === 0
                ? "alles erledigt"
                : `${checks.length - openChecks} von ${checks.length} erledigt`}</span
            >
          </h2>
          <div data-testid="setup-checks">
            <List ariaLabel="Einrichtung">
              {#each checks as c (c.key)}
                <ListRow
                  title={c.title}
                  subtitle={c.detail}
                  avatar={false}
                  href={mayOpenPath($authStore.user, c.href) ? c.href : undefined}
                >
                  {#snippet trailing()}
                    <span class="vw-row-end" data-check={c.key} data-state={c.state}>
                      <Chip tone={c.state === "erledigt" ? "ok" : "warn"}
                        >{c.state === "erledigt" ? "Erledigt" : "Offen"}</Chip
                      >
                      {#if mayOpenPath($authStore.user, c.href)}
                        <a
                          class="btn btn-sm"
                          class:btn-outline={c.state === "offen"}
                          class:btn-ghost={c.state === "erledigt"}
                          class:vw-quiet={c.state === "erledigt"}
                          href={c.href}>{c.action}</a
                        >
                      {/if}
                    </span>
                  {/snippet}
                </ListRow>
              {/each}
            </List>
          </div>
        </section>
      {/if}
    </div>
  {/snippet}
</HubPage>

<style>
  .vw {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
  .vw-h2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-2);
    margin: 0 0 var(--s-2);
    font-size: var(--fs-h2);
    font-weight: 600;
  }
  .vw-meta {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-2);
  }
  /* phone: a done check needs no second link — its title already is one */
  @media (max-width: 759.98px) {
    .vw-quiet {
      display: none;
    }
  }
  .vw-row-end {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
</style>
