/**
 * auto-break-write.ts
 *
 * Issue #511 (AK-4, D-17) + Issue #799 — the ONE write of an automatic break and the ONE
 * post-STOP step every clock trigger (web, NFC, WIFI, future sources) runs after the resolver has
 * closed or consolidated an entry. WHICH break (regime, amount, placement) is decided by
 * `planAutoBreak`; this module only decides WHEN a stopped entry gets one and writes it.
 */
import type { FastifyInstance } from "fastify";
import { planAutoBreak, type AutoBreakPlan } from "./auto-break-plan";

export type StoredBreak = {
  id: string;
  timeEntryId: string;
  startTime: Date;
  endTime: Date;
  createdAt: Date;
};

/**
 * Writes the planned Break rows and the entry's summary fields together or not at all. Returns the
 * minutes written (shared by the clock STOP step and the manual POST).
 */
export async function autoInsertBreak(
  app: FastifyInstance,
  params: { entryId: string; plan: AutoBreakPlan },
): Promise<{ minutes: number; breaks: StoredBreak[] }> {
  const { entryId, plan } = params;
  const [breaks] = await app.prisma.$transaction([
    app.prisma.break.createManyAndReturn({
      data: plan.segments.map((s) => ({
        timeEntryId: entryId,
        startTime: s.startTime,
        endTime: s.endTime,
        isAuto: true, // Issue #799: the row-level marker the reopen replacement selects on
      })),
    }),
    // Phase 91 (BREAK-02): Pflichtpause auto-inserted → mark AUTO for confirmation
    app.prisma.timeEntry.update({
      where: { id: entryId },
      data: { breakMinutes: plan.amountMin, breakStatus: "AUTO" },
    }),
  ]);
  return { minutes: plan.amountMin, breaks };
}

/**
 * Issue #799: the automatic break of an entry a clock STOP just closed (CLOCKED_OUT or
 * CONSOLIDATED). Called by every clock adapter after `resolveClockEvent` — one rule, no per-source
 * copy. Month locks are already refused by the resolver before a STOP is written, so a locked
 * month never reaches this step.
 *
 * Skipped when Break rows already exist on the entry (D-01 Pitfall 1): a reopened entry carries a
 * gap Break and an automatic break must not overwrite its breakMinutes.
 */
export async function applyAutoBreakAfterClockStop(
  app: FastifyInstance,
  params: { entryId: string; employeeId: string; tz: string },
): Promise<{ minutes: number; breaks: StoredBreak[] }> {
  const { entryId, employeeId, tz } = params;
  const none = { minutes: 0, breaks: [] as StoredBreak[] };
  const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return none;
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });
  const existingBreakCount = await app.prisma.break.count({ where: { timeEntryId: entryId } });
  if (!tenantConfig?.autoBreakEnabled || existingBreakCount !== 0) return none;
  const closedEntry = await app.prisma.timeEntry.findUnique({ where: { id: entryId } });
  if (!closedEntry?.startTime || !closedEntry?.endTime) return none;
  // Issue #511 (D-20): minors get at least the § 11 JArbSchG amount; adults unchanged.
  const plan = planAutoBreak({
    employee,
    tenantConfig,
    start: closedEntry.startTime,
    end: closedEntry.endTime,
    entryDate: closedEntry.date,
    tz,
  });
  if (!plan) return none;
  return autoInsertBreak(app, { entryId, plan });
}
