/**
 * Issue #847 — Verwalten › Übersicht: the setup checklist, the open administrative tasks and the
 * contradictory-configuration warnings, in ONE module.
 *
 * Every input is an answer of an existing endpoint, read only with that endpoint's own permission;
 * this module decides nothing a server rule decides — it only reads the answers as „erledigt / offen“
 * and counts rows. A check whose source the caller may not read is not shown at all (never a fake
 * „offen“): the page passes `null` for an unread source.
 *
 * `mailWithoutDelivery()` is the ONE rule of the warning „E-Mail aktiv, SMTP nicht eingerichtet“; the
 * overview and the mail settings (Regeln › Benachrichtigungen) both call it. „Can deliver“ is the server's own
 * answer (`GET /settings/smtp` → `deliveryReady`, the mailer's rule incl. the server fallback).
 */

export type CheckState = "erledigt" | "offen";

export interface SetupCheck {
  key: string;
  title: string;
  /** One sentence: what is missing, or what is in place. */
  detail: string;
  state: CheckState;
  href: string;
  action: string;
}

export interface SalonRow {
  id: string;
  name: string;
  isActive: boolean;
  openingHours?: unknown;
}

export interface EmployeeRow {
  id: string;
  exitDate?: string | null;
  user?: { isActive?: boolean; role?: string | null } | null;
  workSchedule?: unknown | null;
  invitationStatus?: "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
}

export interface SmtpAnswer {
  deliveryReady?: boolean;
  smtpHost?: string | null;
}

/** Can mail be sent? The server's answer (#847); an older answer without it: the tenant's own host. */
function canDeliver(smtp: SmtpAnswer): boolean {
  return smtp.deliveryReady ?? !!smtp.smtpHost;
}

export interface WorkSettingsAnswer {
  arbzgEnabled?: boolean;
}

export interface TerminalRow {
  revokedAt: string | null;
}

export interface CheckInputs {
  salons: SalonRow[] | null;
  employees: EmployeeRow[] | null;
  smtp: SmtpAnswer | null;
  work: WorkSettingsAnswer | null;
  /** `null` when the hardware clock is not booked or the list is not readable. */
  terminals: TerminalRow[] | null;
}

/** A person still employed today (no exit day, or one in the future). `today` = YYYY-MM-DD. */
export function isCurrentPerson(e: EmployeeRow, today: string): boolean {
  return !e.exitDate || e.exitDate.slice(0, 10) >= today;
}

function hasOpeningHours(s: SalonRow): boolean {
  const h = s.openingHours;
  if (Array.isArray(h)) return h.length > 0;
  if (h && typeof h === "object") return Object.keys(h).length > 0;
  return false;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function setupChecks(input: CheckInputs, today: string): SetupCheck[] {
  const checks: SetupCheck[] = [];
  if (input.salons) {
    const active = input.salons.filter((s) => s.isActive);
    checks.push({
      key: "salons",
      title: "Salons angelegt",
      detail:
        active.length > 0
          ? `${plural(active.length, "aktiver Salon", "aktive Salons")} mit Bundesland`
          : "Lege deinen ersten Salon an.",
      state: active.length > 0 ? "erledigt" : "offen",
      href: "/verwalten/salons",
      action: "Salons",
    });
    const without = active.filter((s) => !hasOpeningHours(s));
    checks.push({
      key: "opening-hours",
      title: "Öffnungszeiten gepflegt",
      detail:
        active.length === 0
          ? "Erst einen Salon anlegen."
          : without.length === 0
            ? "Jeder aktive Salon hat Öffnungszeiten."
            : `${plural(without.length, "Salon", "Salons")} ohne Öffnungszeiten`,
      state: active.length > 0 && without.length === 0 ? "erledigt" : "offen",
      href: "/verwalten/salons",
      action: "Öffnungszeiten",
    });
  }
  if (input.work) {
    checks.push({
      key: "rules",
      title: "Arbeitszeitregeln aktiv",
      detail: input.work.arbzgEnabled
        ? "Die Prüfung nach Arbeitszeitgesetz ist eingeschaltet."
        : "Die Prüfung nach Arbeitszeitgesetz ist ausgeschaltet.",
      state: input.work.arbzgEnabled ? "erledigt" : "offen",
      href: "/verwalten/regeln/arbeitszeit#arbzg",
      action: "Regeln",
    });
  }
  if (input.smtp) {
    checks.push({
      key: "smtp",
      title: "E-Mail-Versand eingerichtet",
      detail: canDeliver(input.smtp)
        ? "E-Mails können verschickt werden."
        : "Es ist kein Mailserver eingerichtet.",
      state: canDeliver(input.smtp) ? "erledigt" : "offen",
      href: "/verwalten/regeln/benachrichtigungen#mailserver",
      action: "E-Mail",
    });
  }
  if (input.employees) {
    const current = input.employees.filter((e) => isCurrentPerson(e, today));
    const withoutRole = current.filter((e) => e.user && (e.user.role ?? null) === null);
    checks.push({
      key: "roles",
      title: "Rollen vergeben",
      detail:
        withoutRole.length === 0
          ? "Jede Person hat eine Rolle."
          : `${plural(withoutRole.length, "Person", "Personen")} ohne Rolle`,
      state: withoutRole.length === 0 ? "erledigt" : "offen",
      href: "/verwalten/system/rollen",
      action: "Rollen",
    });
  }
  if (input.terminals) {
    const live = input.terminals.filter((t) => t.revokedAt === null);
    checks.push({
      key: "terminals",
      title: "Stempel-Terminal verbunden",
      detail:
        live.length > 0
          ? `${plural(live.length, "aktives Terminal", "aktive Terminals")}`
          : "Noch kein Terminal verbunden.",
      state: live.length > 0 ? "erledigt" : "offen",
      href: "/verwalten/system/integrationen#terminals",
      action: "Terminals",
    });
  }
  return checks;
}

/** One month of `GET /overtime/close-month/year-status`. */
export interface YearStatusMonth {
  month: number;
  status: "closed" | "partial" | "ready" | "open" | "blocked" | "future" | "no_data";
}

const OVERDUE = new Set<YearStatusMonth["status"]>(["partial", "ready", "open", "blocked"]);

/** Months before the current one (YYYY, M) whose close is still outstanding. */
export function overdueMonthCloses(
  years: { year: number; months: YearStatusMonth[] }[],
  current: { year: number; month: number },
): number {
  let n = 0;
  for (const y of years) {
    for (const m of y.months) {
      const before = y.year < current.year || (y.year === current.year && m.month < current.month);
      if (before && OVERDUE.has(m.status)) n++;
    }
  }
  return n;
}

export interface AdminTaskCounts {
  pendingInvitations: number;
  withoutContract: number;
}

/** Invitations not yet accepted (open or expired) and persons without any contract, today's staff only. */
export function adminTaskCounts(employees: EmployeeRow[], today: string): AdminTaskCounts {
  const current = employees.filter((e) => isCurrentPerson(e, today));
  return {
    pendingInvitations: current.filter(
      (e) => e.invitationStatus === "PENDING" || e.invitationStatus === "EXPIRED",
    ).length,
    withoutContract: current.filter((e) => !e.workSchedule).length,
  };
}

/** „E-Mail aktiv, SMTP nicht eingerichtet“: notification mails are switched on but cannot be sent. */
export function mailWithoutDelivery(
  security: { emailNotificationsEnabled?: boolean } | null,
  smtp: SmtpAnswer | null,
): boolean {
  return security?.emailNotificationsEnabled === true && smtp !== null && !canDeliver(smtp);
}

export const MAIL_WITHOUT_DELIVERY_TEXT =
  "E-Mail-Benachrichtigungen sind eingeschaltet, aber es ist kein Mailserver eingerichtet. Es werden keine E-Mails verschickt.";
