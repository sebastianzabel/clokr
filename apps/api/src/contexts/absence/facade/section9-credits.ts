/**
 * Phase 100B Plan 11 (Wave 5) — Abwesenheiten's `Section9Credit` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `Section9Credit` through one of the
 * functions below, never through `prisma.section9Credit`/`app.prisma.section9Credit`/
 * `tx.section9Credit` directly. Added to `convertedModels` in
 * `apps/api/scripts/foreign-context-access-exceptions.json` in the same commit.
 *
 * `contexts/absence/api/leave.ts`, `api/section9-documents.ts` and `section9-credit-days.ts` keep
 * their OWN direct access — they sit INSIDE this context, never foreign.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient`.
 *
 * ── The guarded read vs the two named compliance functions ──────────────────────────────────────
 * {@link getConfirmedSection9Credits} is the ordinary tenant-scoped read every new caller uses.
 * {@link getSection9DocumentPaths} and {@link anonymizeSection9CreditsForEmployee} are DSGVO Art.
 * 17 compliance functions and deliberately do NOT carry a `tenantId` parameter — see each
 * function's own docblock and CLAUDE.md § DSGVO Employee Deletion. Both carry a named F3 exception
 * in `lint-facade-signatures-exceptions.json`.
 */
import type { Prisma } from "@clokr/db";

// ── The guarded read ─────────────────────────────────────────────────────────────────────────

export interface ConfirmedSection9Credit {
  employeeId: string;
  creditedStart: Date | null;
  creditedEnd: Date | null;
}

/**
 * The `CONFIRMED` `Section9Credit`s for `tenantId` whose credited range overlaps `[from, to]`.
 * Site: `composition/reports.ts`'s `fetchConfirmedSection9CreditsByEmp` (Phase 104 D-30 — one
 * query across every visible employee, tenant-scoped, `CONFIRMED`-only — an `AU_PENDING` row must
 * not change a reported number).
 */
export async function getConfirmedSection9Credits(
  db: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<ConfirmedSection9Credit[]> {
  return db.section9Credit.findMany({
    where: {
      status: "CONFIRMED",
      employee: { tenantId },
      creditedStart: { lte: to },
      creditedEnd: { gte: from },
    },
    select: { employeeId: true, creditedStart: true, creditedEnd: true },
  });
}

// ── The two named DSGVO Art. 17 compliance functions ────────────────────────────────────────────

/**
 * F3 exception (D-08, no `tenantId` parameter): the `documentPath`s of every `Section9Credit` for
 * `employeeId` — every row regardless of `status` (`AU_PENDING`/`CONFIRMED`/`REJECTED`), so an
 * Art. 17 document cleanup cannot leave a paper-AU behind because it was never confirmed.
 * `Section9Credit` has no `deletedAt` column (unlike `Absence`/`LeaveRequest`/`TimeEntry`) — there
 * is no soft-delete guard to omit here, only a `status` filter this function deliberately does not
 * add. Site: `platform/api/employees.ts`'s `DELETE /:id` (`ANONYMIZE`) handler, called BEFORE the
 * anonymisation `$transaction` opens (MinIO deletes happen after commit — MinIO is not
 * transactional with Postgres). Its handler validates `id` against `req.user.tenantId` before this
 * function is ever reached (see the neighbouring `employee.tenantId !== req.user.tenantId` check a
 * few lines above the call).
 */
export async function getSection9DocumentPaths(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<Array<{ documentPath: string | null }>> {
  return db.section9Credit.findMany({
    where: { employeeId, documentPath: { not: null } },
    select: { documentPath: true },
  });
}

/**
 * F3 exception (D-08, no `tenantId` parameter, T-100B-48): DSGVO Art. 17 anonymisation — nulls
 * `documentPath` and `reason` for every `Section9Credit` row belonging to `employeeId` and NOTHING
 * else. Deliberately no `delete`: CLAUDE.md § DSGVO Employee Deletion names `Section9Credit` under
 * "§ 9-Vorgänge: documentPath → null, reason → null (Zeilen bleiben erhalten — Korrektureintrag
 * nach R7)" — the rows are the Revisionssicherheit record that a vacation credit once existed and
 * how it was computed; only the personal/health-related fields (a paper-AU document is an Art. 9
 * DSGVO health datum, and `reason` is free text) are erased. No `status` filter — every row for
 * `employeeId` is cleared regardless of `AU_PENDING`/`CONFIRMED`/`REJECTED` (`Section9Credit` has
 * no `deletedAt` column at all, so there is no soft-delete guard to omit, only a status filter
 * this deliberately does not add).
 *
 * `db: Prisma.TransactionClient` (D-07) is what keeps this write inside the CALLER's transaction —
 * `anonymize.ts`'s own `$transaction` callback passes its `tx` straight through in the same
 * position in the sequence as before this plan moved it. A lost transaction here means a partially
 * anonymised employee whose audit row still rolls back: the worst class of defect this facade
 * initiative exists to prevent (D-07's own rationale). Its sole caller, `anonymizeEmployeeData()`,
 * resolves and validates `employeeId` before opening the transaction this function runs inside —
 * there is no second, untrusted identifier here for a `tenantId` parameter to constrain (same
 * shape as `time-entries.ts`'s `clearEntryNotesForEmployee`, `overtime-account.ts`'s
 * `hardDeleteOvertimeDataForEmployee`, `entitlements.ts`'s `hardDeleteEntitlementsForEmployee`).
 */
export async function anonymizeSection9CreditsForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.section9Credit.updateMany({
    where: { employeeId },
    data: { documentPath: null, reason: null },
  });
}
