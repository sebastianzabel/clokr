/**
 * Phase 100B Plan 06 (Wave 3) — Arbeitszeitkonto's `OvertimeAccount`/`OvertimeTransaction` facade.
 *
 * ADR 0001 rule 3: no direct table access across foreign schemas; every caller outside this
 * context reaches these two models through one of the eight named functions below, never through
 * `prisma.overtimeAccount`/`tx.overtimeTransaction` directly. Both models are added to
 * `convertedModels` in `apps/api/scripts/foreign-context-access-exceptions.json` in the same
 * commit, so a future direct access is a hard error, not a slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the SAME function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * ── W11 bookOvertimeCompensation / W12 reverseOvertimeCompensation — the collapse ─────────────
 * The SAME three-step rule (read the account → `update` its `balanceHours` → `create` an
 * `OvertimeTransaction`) existed in FOUR verbatim copies inside `contexts/absence/api/leave.ts`:
 *
 *   | Copy                                    | Lines (pre-plan)      | Receiver | Direction            |
 *   |------------------------------------------|-----------------------|----------|-----------------------|
 *   | W11 approval booking                     | `:1217`,`:1228`,`:1232` | `app.prisma` | decrement / REDUCTION |
 *   | W12 cancellation-approval reversal        | `:1030`,`:1041`,`:1045` | `app.prisma` | increment / CORRECTION |
 *   | W12 correction — reverse the OLD booking  | `:1874`,`:1886`,`:1890` | `tx`         | increment / CORRECTION |
 *   | W11 correction — apply the NEW booking    | `:1936`,`:1948`,`:1952` | `tx`         | decrement / REDUCTION  |
 *
 * Two of the four run on `app.prisma`, two run on the PATCH `/correct` handler's own `tx` (the
 * correction reverses the OLD booking and applies the NEW one in ONE transaction — CR-01). This is
 * R1's sharpest edge in the whole phase: if this facade took `app: FastifyInstance` and reached
 * for `app.prisma` internally, the two `tx` copies would leave the caller's transaction SILENTLY.
 * The write would survive a rollback. Nothing throws. In an audit-proof system that is the worst
 * class of defect — a divergent, unexplainable overtime balance with no error anywhere and no test
 * that would have caught it before this plan. Changing the first parameter's type away from
 * `db: Prisma.TransactionClient` reintroduces EXACTLY that defect — see
 * `__tests__/facade-overtime-account.test.ts`'s rollback assertion, which was seen RED under an
 * `app: FastifyInstance` signature before this file was written this way, and its own SUMMARY for
 * the captured transcript.
 *
 * `hours`/`description` are computed by the CALLER (both differ per call site — the description
 * text and, for `getScheduledHours`-derived hours, the date range) and passed in unchanged from
 * what the four original copies computed inline; this facade does not recompute or normalise
 * either. `getScheduledHours()` itself stays in `leave.ts` — it is Abwesenheiten's own policy
 * function (R-D, established by plan 05 H4) and is unrelated to the Arbeitszeitkonto booking rule
 * this facade owns.
 *
 * Neither function returns the account row: none of the four original call sites read `account`/
 * `acct` again after their `if (account && hours > 0)` block (verified by reading all four before
 * writing this file) — there is nothing for the caller to hand back.
 *
 * ── H1 / issue #220 — RESOLVED, one layer down; these two functions are unchanged ─────────────
 * The unconditional `updateOvertimeAccount()` recompute in `leave.ts` still runs right after
 * these writes and still REPLACES `balanceHours` with an independently-computed Ist-Soll value —
 * that is by design and was never the defect. The defect was that the recompute did not know
 * Überstundenausgleich existed: `closeEmployeeMonth()` reduced an OVERTIME_COMP day's Soll like
 * Urlaub and withdrew nothing, so the stored balance moved OPPOSITE to the journal row these
 * functions write. Since #220 the recompute carries the withdrawal (model B — see
 * `close-employee-month.ts`'s "Überstundenausgleich" header note), so journal and balance agree.
 *
 * The remaining open question here is atomicity, not correctness: `updateOvertimeAccount()` still
 * runs outside any transaction and its caller swallows its failure — tracked as issue #294.
 *
 * These two functions were NOT changed by that fix and must not be: for `isTimeTrackingExempt`
 * (§ 18) employees `computeOvertimeBalanceBreakdown()` returns null and `updateOvertimeAccount()`
 * leaves the stored value alone, which makes the manual booking here the ONLY effective writer on
 * that path. `overtime-comp-saldo.test.ts` covers both paths; `leave-characterization.test.ts`
 * pins the cancellation branch.
 *
 * ── H2 — the fail-safe reads are not the normal path ──────────────────────────────────────────
 * `leave.ts:634` and `:2443` (both W8) exist because `getConfirmedCarryOver` can throw. Reading
 * the stored account there is a DEGRADED fallback, never the primary source — nothing about them
 * is "unified" with the booking functions above, and W8 itself carries no opinion on which of its
 * callers is a fail-safe.
 *
 * ── H3 — `OvertimeAccount.balanceHours` is known to go stale ──────────────────────────────────
 * v1.8.24 already overrides it at read time in `overtime.ts`'s own live-saldo computation. W8
 * returns the stored row exactly as read; it is not, and must not become, a new source of truth.
 *
 * ── W13 createOvertimeAccount — the unused `tenantId` parameter ────────────────────────────────
 * `OvertimeAccount` carries no `tenantId` column at all (`schema.prisma:563-571` — the only tenant
 * path is via its `employee` relation). `tenantId` is declared here solely to satisfy D-10/G4
 * signature uniformity (`lint-facade-signatures`'s F3: an exported facade function with an
 * `*Id`/`*Ids` parameter also declares `tenantId`) and is deliberately UNUSED in the query itself:
 * both call sites (`platform/api/employees.ts`, `platform/api/imports.ts`) create this row inside
 * the SAME employee-creation `tx` that just created `employeeId`, so there is no separate tenant
 * boundary left to check against.
 *
 * ── W15 hardDeleteOvertimeDataForEmployee — deliberately NO tenant parameter ───────────────────
 * This is a HARD delete (D-08: no soft-delete guard applies to a hard delete by definition),
 * invoked only from `platform/api/employees.ts`'s `DELETE /:id/hard-delete` sequence, which
 * validates `id` against `req.user.tenantId` at its own top (`employee.findUnique({ where: { id,
 * tenantId: req.user.tenantId } })`) BEFORE the hard-delete `$transaction` — and therefore before
 * this function — is ever reached. Carries a named `lint-facade-signatures` F3 exception whose
 * reason points at exactly that validating line.
 */
import type { Prisma } from "@clokr/db";

// ── W8 — the one account read, used by both the real callers and the fail-safe branches ───────

/**
 * W8 — reads the stored `OvertimeAccount` row for `employeeId`, scoped to `tenantId` via the
 * `employee` relation (H3: this is the STORED value; several callers override it at read time
 * with a live computation — this function has no opinion on that, it returns what is persisted).
 * Used both by the two real booking paths' own account lookup (folded into
 * {@link bookOvertimeCompensation} / {@link reverseOvertimeCompensation} below) and by the
 * fail-safe reads (H2: `leave.ts:634`, `:2443`, `dashboard.ts:260`,
 * `time-tracking/api/time-entries.ts:470`).
 */
export async function getOvertimeAccount(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
) {
  return db.overtimeAccount.findUnique({
    where: { employeeId, employee: { tenantId } },
  });
}

// ── W9/W10 — tenant-wide / bulk reads ────────────────────────────────────────────────────────

/**
 * W9 — every active employee's `OvertimeAccount` for `tenantId`, joined with the fields
 * `dashboard.ts:762`'s "Überstunden-Übersicht" (RPT-01/SALDO-03) renders, ordered by last name.
 * Exit-date / active-user filtering matches the original call exactly.
 */
export async function listOvertimeAccountsForTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
) {
  return db.overtimeAccount.findMany({
    where: { employee: { tenantId, exitDate: null, user: { isActive: true } } },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
    },
    orderBy: { employee: { lastName: "asc" } },
  });
}

/**
 * W10 — bulk `balanceHours` lookup for `employeeIds`, ONE `findMany` (R-B, mirrors
 * `getConfirmedCarryOverBulk`'s N+1-free bulk shape — `confirmed-saldo.ts:58-63`).
 * `dashboard.ts:1345`'s team-wide balance sum is the sole caller today.
 *
 * `employee: { tenantId }` is a PROVEN no-op addition, not a plausible one: the caller derives
 * `employeeIds` from its own `employee.findMany({ where: { tenantId, ... } })` immediately above
 * (`dashboard.ts:1319-1326`), so every id already belongs to `tenantId` before this function is
 * ever called — the added clause can only ever match everything it already would have.
 */
export async function getBalances(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
) {
  if (employeeIds.length === 0) return [];
  return db.overtimeAccount.findMany({
    where: { employeeId: { in: employeeIds }, employee: { tenantId } },
    select: { balanceHours: true },
  });
}

// ── W11/W12 — the booking rule, collapsed from four verbatim copies ────────────────────────────

/**
 * W11 — books an Überstundenausgleich: decrements `balanceHours` by `hours` and writes a
 * `REDUCTION` `OvertimeTransaction`. No-ops (does neither write) when the account does not exist
 * or `hours <= 0` — exactly the `if (account && hours > 0)` guard both original copies applied.
 * See the module header for the full four-copies-to-two-functions accounting and R1's stakes.
 */
export async function bookOvertimeCompensation(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  hours: number,
  description: string,
): Promise<void> {
  const account = await db.overtimeAccount.findUnique({
    where: { employeeId, employee: { tenantId } },
  });
  if (!account || hours <= 0) return;

  await db.overtimeAccount.update({
    where: { id: account.id },
    data: { balanceHours: { decrement: hours } },
  });
  await db.overtimeTransaction.create({
    data: {
      overtimeAccountId: account.id,
      hours: -hours,
      type: "REDUCTION",
      description,
    },
  });
}

/**
 * W12 — reverses a previously-booked Überstundenausgleich: increments `balanceHours` by `hours`
 * and writes a `CORRECTION` `OvertimeTransaction`. Same no-op guard as
 * {@link bookOvertimeCompensation}. H1/#220: one of this function's two call sites
 * (cancellation-approval reversal) has its write immediately overwritten by a later unconditional
 * recompute in the SAME request — reproduced here on purpose, see the module header.
 */
export async function reverseOvertimeCompensation(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  hours: number,
  description: string,
): Promise<void> {
  const account = await db.overtimeAccount.findUnique({
    where: { employeeId, employee: { tenantId } },
  });
  if (!account || hours <= 0) return;

  await db.overtimeAccount.update({
    where: { id: account.id },
    data: { balanceHours: { increment: hours } },
  });
  await db.overtimeTransaction.create({
    data: {
      overtimeAccountId: account.id,
      hours,
      type: "CORRECTION",
      description,
    },
  });
}

// ── W13/W14/W15 — lifecycle: create, recompute-write, hard-delete ──────────────────────────────

/**
 * W13 — creates the zero-balance `OvertimeAccount` row for a newly-created employee. Both call
 * sites (`platform/api/employees.ts`, `platform/api/imports.ts`) invoke this inside the SAME
 * employee-creation `tx` immediately after `tx.employee.create(...)`. See the module header for
 * why `tenantId` is declared but deliberately unused.
 */
export async function createOvertimeAccount(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
): Promise<void> {
  void tenantId; // D-10/G4 signature uniformity only — OvertimeAccount has no tenantId column, see module header
  await db.overtimeAccount.create({ data: { employeeId, balanceHours: 0 } });
}

/**
 * W14 — the event-driven writer's persistence step: `time-entries.ts`'s `updateOvertimeAccount()`
 * recomputes the live lifetime saldo on every time-entry mutation and month close/unlock, then
 * calls this to upsert the stored `balanceHours`. `employee: { tenantId }` in the `where` is a
 * PROVEN no-op: `updateOvertimeAccount()`'s own caller-facing signature is unchanged
 * (`(app, employeeId)`, no `tenantId` parameter) — internally it now fetches the employee's
 * `tenantId` once before calling this, so the value passed here always matches the account's own
 * (single, immutable) tenant.
 */
export async function setOvertimeAccountBalance(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  balanceHours: number,
) {
  return db.overtimeAccount.upsert({
    where: { employeeId, employee: { tenantId } },
    create: { employeeId, balanceHours },
    update: { balanceHours },
  });
}

/**
 * W15 — hard-deletes the `OvertimeAccount` row (and, via `onDelete: Cascade`, its
 * `OvertimeTransaction` rows) for `employeeId`. See the module header for why this deliberately
 * takes NO `tenantId` parameter and carries a named `lint-facade-signatures` F3 exception instead.
 */
export async function hardDeleteOvertimeDataForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.overtimeAccount.deleteMany({ where: { employeeId } });
}
