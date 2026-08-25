/**
 * find-karenz-overrun-days.ts
 *
 * Single source of truth for the "Karenztage überschritten, kein Attest" detector (Phase 104,
 * R4 / D-21). Mirrors find-unconfirmed-break-days.ts (Phase 92) so the Monatsabschluss status
 * listing and the auto-close branch can never drift apart.
 *
 * ── R5 / D-23 — THE INVARIANT THIS FILE EXISTS TO PROTECT ────────────────────────────────
 * § 5 Abs. 1 EFZG (Karenztage) und § 9 BUrlG (Krank im Urlaub) sind UNTERSCHIEDLICHE Regeln
 * mit unterschiedlicher Rechtsfolge:
 *
 *   § 5 EFZG  — "wann darf der Arbeitgeber ein Attest verlangen?"  -> Dokumentationspflicht
 *   § 9 BUrlG — "wann werden Urlaubstage nicht angerechnet?"       -> nur gegen ärztliches Zeugnis
 *
 * Wären sie verdrahtet, bekäme ein Tenant mit Karenz=3 nach ZWEI attestlosen Krankheitstagen
 * Urlaubstage gutgeschrieben — rechtswidrig, weil § 9 ausnahmslos ein ärztliches Zeugnis
 * verlangt.
 *
 * DIESES MODUL IMPORTIERT NICHTS. Kein Section9Credit, kein leave.ts, kein Prisma-Typ, keine
 * timezone.ts. Es gibt damit keinen Aufrufweg, über den die Karenzregel den § 9-Pfad erreichen
 * könnte — die Trennung ist strukturell, nicht nur getestet. Wer hier einen Import ergänzen
 * möchte: bitte zuerst diese Zeilen lesen. Der zugehörige benannte Test heißt
 * "R5: Karenz=3 tenant with two attest-less days gets NO vacation credit".
 *
 * D-22: Gezählt wird in Kalendertagen ab Krankheitsbeginn (§ 5 Abs. 1 EFZG: "länger als drei
 * Kalendertage"), nicht in Arbeitstagen — ein Fr-Di-Zeitraum sind 5 Kalendertage, obwohl das
 * Wochenende nicht gearbeitet wird.
 *
 * D-24: Karenztage steuern ausschließlich die Nachweis-Dokumentation. Keine
 * Entgeltfortzahlungs- oder Lohnwirkung (§ 3 EFZG) — Clokr rechnet keine Entgeltfortzahlung.
 *
 * D-21: Der Befund ist ein HINWEIS, keine Blockade. Es gibt bewusst keinen Export, der eine
 * Genehmigung oder einen Monatsabschluss verhindert — die eAU ist oft erst nach Tagen abrufbar,
 * eine Blockade würde legitime Fälle verhindern und Umgehungen erzwingen.
 */

/** Legal maximum per D-22 (§ 5 Abs. 1 EFZG, range 0-3). Legacy rows above this are clamped. */
export const MAX_KARENZ_DAYS = 3;

/** Clamps a stored tenant value into the legal 0-3 range. Legacy rows (pre-D-22 range 1-30) keep working. */
export function normalizeKarenzDays(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || Number.isNaN(Number(raw))) return MAX_KARENZ_DAYS;
  return Math.min(MAX_KARENZ_DAYS, Math.max(0, Math.trunc(Number(raw))));
}

/**
 * Local, dependency-free equivalent of timezone.ts's dateStrInTz. Six lines of Intl are the
 * correct price for keeping this module import-free (see the D-23 note above); a shared helper
 * would create the exact edge the boundary forbids.
 */
function localDateStr(d: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return p; // en-CA yields YYYY-MM-DD
}

const SICK_NAMES = ["Krankmeldung", "Kinderkrank"] as const;

export type KarenzSickRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  status: string;
  attestPresent: boolean;
  attestValidFrom: Date | null;
  attestValidTo: Date | null;
  leaveType: { name: string };
  deletedAt?: Date | null;
};

export type KarenzOverrun = {
  leaveRequestId: string;
  /** Tenant-local YYYY-MM-DD days that are sick, beyond the Karenz threshold, and uncovered by an Attest. */
  days: string[];
};

/** Pure funnel — no DB, no async. `graceDays` is the raw tenant value; normalised internally. */
export function karenzOverrunFromRequests(
  rows: KarenzSickRow[],
  tz: string,
  graceDays: number | null | undefined,
): KarenzOverrun[] {
  const threshold = normalizeKarenzDays(graceDays);
  const out: KarenzOverrun[] = [];
  for (const r of rows) {
    if (!(SICK_NAMES as readonly string[]).includes(r.leaveType.name)) continue;
    if (r.deletedAt) continue;
    if (r.status !== "APPROVED") continue;
    // § 5 Abs. 1 EFZG zählt KALENDERTAGE, nicht Arbeitstage — calculateWorkDays wäre falsch.
    const calendarDays = Math.round((r.endDate.getTime() - r.startDate.getTime()) / 86400000) + 1;
    // "länger als" — bei exakt `threshold` Tagen besteht noch keine Nachweispflicht.
    if (calendarDays <= threshold) continue;
    const days: string[] = [];
    for (let t = r.startDate.getTime(); t <= r.endDate.getTime(); t += 86400000) {
      const d = new Date(t);
      // Deckung wie in reports.ts:264-289 gelesen: mit Von/Bis gilt das Fenster,
      // attestPresent ohne Daten deckt den ganzen Zeitraum, sonst nichts.
      const covered =
        r.attestPresent &&
        (!r.attestValidFrom || !r.attestValidTo
          ? true
          : d >= r.attestValidFrom && d <= r.attestValidTo);
      if (!covered) days.push(localDateStr(d, tz));
    }
    if (days.length > 0) out.push({ leaveRequestId: r.id, days });
  }
  return out;
}

/** DB-backed wrapper for one employee + month. Signature mirrors findUnconfirmedBreakDays. */
export async function findKarenzOverrunDays(
  prisma: { leaveRequest: { findMany: (args: unknown) => Promise<KarenzSickRow[]> } },
  opts: {
    employeeId: string;
    monthFirstDay: Date;
    monthLastDay: Date;
    tz: string;
    graceDays: number | null;
  },
): Promise<string[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      employeeId: opts.employeeId,
      deletedAt: null,
      status: "APPROVED",
      startDate: { lte: opts.monthLastDay },
      endDate: { gte: opts.monthFirstDay },
    },
    include: { leaveType: true },
  });
  const first = localDateStr(opts.monthFirstDay, opts.tz);
  const last = localDateStr(opts.monthLastDay, opts.tz);
  return karenzOverrunFromRequests(rows, opts.tz, opts.graceDays)
    .flatMap((o) => o.days)
    .filter((d) => d >= first && d <= last)
    .sort();
}
