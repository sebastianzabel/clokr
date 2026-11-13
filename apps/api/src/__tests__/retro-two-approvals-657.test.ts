/**
 * Issue #657 (Phase 657-03, AC-657-3, D-06) — two Zeitnachträge of one day, two approvals.
 *
 * With a Zeitnachtrag per interval a day can hold several pending requests, each with its own
 * coupled invalid row. The approval path of #70 is UNCHANGED (D-06): lock the employee first,
 * flip the status race-safe, re-check the overlap with the entries present at that moment inside
 * the same transaction. These tests prove that on the real routes:
 *
 *  - sequential: an approval whose corrected times overlap the other request's row (pending or
 *    already released) answers 409 with the detailed text, the request stays PENDING, its row
 *    keeps its times and stays invalid, and no approval audit row exists;
 *  - concurrent: two approvals whose corrected times overlap EACH OTHER (not the other's original
 *    row) end with exactly one 200 and one 409, and the valid rows never overlap;
 *  - lock race: an approval that waits on the employee lock while the holder releases the other
 *    request with overlapping times sees the holder's committed row.
 *
 * Mutation proof (recorded in the 657-03 SUMMARY, restored by `cp`): removing the
 * `recheckOverlapInTx` call of the approval branch turns the sequential case red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, cleanupTestData, seedTestData } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";
import { holdEmployeeLockThen } from "./entry-lock-race-helpers";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

function detailedText(dayStr: string, from: string, to: string): string {
  const [y, m, d] = dayStr.split("-");
  return `Überschneidung mit bestehendem Eintrag vom ${d}.${m}.${y} (${from} – ${to})`;
}

describe("Issue #657 — two Zeitnachträge of one day, two approvals", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let tenantId: string;
  let employeeId: string;
  let dayCounter = 0;

  /** A distinct past weekday per call, far outside the retro window and after the hire date. */
  function nextDay(): string {
    dayCounter += 1;
    return nextWeekdayStr(pastDateStr(150 + 7 * dayCounter));
  }

  /** Entry-first Zeitnachtrag through the real route; returns the request and its coupled row. */
  async function requestNachtrag(day: string, from: string, to: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        employeeId,
        date: day,
        startTime: at(day, from).toISOString(),
        endTime: at(day, to).toISOString(),
        breakMinutes: 0,
        reason: "Nachtrag fixture",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const request = await app.prisma.retroEntryRequest.findFirstOrThrow({
      where: {
        employeeId,
        targetDate: new Date(`${day}T00:00:00Z`),
        startTime: from,
        deletedAt: null,
      },
    });
    const entry = await app.prisma.timeEntry.findFirstOrThrow({
      where: { retroRequestId: request.id, deletedAt: null },
    });
    expect(entry.isInvalid).toBe(true);
    return { request, entry };
  }

  const review = (requestId: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/retro-entry-requests/${requestId}/review`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { status: "APPROVED", ...payload },
    });

  const approvalAudits = (requestId: string) =>
    app.prisma.auditLog.count({
      where: { entity: "RetroEntryRequest", entityId: requestId, action: "RETRO_ENTRY_APPROVED" },
    });

  /** The refused request is untouched: PENDING, row times unchanged, row still invalid, no audit. */
  async function expectUntouched(
    request: { id: string },
    entry: { id: string },
    day: string,
    from: string,
    to: string,
  ) {
    const requestAfter = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe("PENDING");
    expect(requestAfter.reviewedBy).toBeNull();
    const entryAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfter.isInvalid).toBe(true);
    expect(entryAfter.startTime.getTime()).toBe(at(day, from).getTime());
    expect(entryAfter.endTime?.getTime()).toBe(at(day, to).getTime());
    expect(await approvalAudits(request.id)).toBe(0);
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "rta657");
    tenantId = seed.tenant.id;
    employeeId = seed.employee.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId } } });
      await app.prisma.retroEntryRequest.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch {
      // best-effort cleanup
    }
  });

  it("sequential: each approval re-checks against the other request's row, pending or released", async () => {
    const day = nextDay();
    const a = await requestNachtrag(day, "08:00", "10:00");
    const b = await requestNachtrag(day, "12:00", "14:00");

    // B's corrected times reach into A's still PENDING row.
    const overPending = await review(b.request.id, { startTime: "09:00", endTime: "14:00" });
    expect(overPending.statusCode, overPending.body).toBe(409);
    expect(JSON.parse(overPending.body).error).toBe(detailedText(day, "08:00", "10:00"));
    await expectUntouched(b.request, b.entry, day, "12:00", "14:00");

    // A is approved as submitted: its row is released.
    const approveA = await review(a.request.id);
    expect(approveA.statusCode, approveA.body).toBe(200);
    const aRow = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: a.entry.id } });
    expect(aRow.isInvalid).toBe(false);

    // B's corrected times reach into A's RELEASED row.
    const overReleased = await review(b.request.id, { startTime: "09:30", endTime: "14:00" });
    expect(overReleased.statusCode, overReleased.body).toBe(409);
    expect(JSON.parse(overReleased.body).error).toBe(detailedText(day, "08:00", "10:00"));
    await expectUntouched(b.request, b.entry, day, "12:00", "14:00");

    // As submitted B does not overlap: approved.
    const approveB = await review(b.request.id);
    expect(approveB.statusCode, approveB.body).toBe(200);

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId, date: new Date(`${day}T00:00:00Z`), deletedAt: null },
      orderBy: { startTime: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.isInvalid)).toBe(true);
    const statuses = await app.prisma.retroEntryRequest.findMany({
      where: { id: { in: [a.request.id, b.request.id] } },
    });
    expect(statuses.every((r) => r.status === "APPROVED")).toBe(true);
  });

  it("concurrent: corrected times that overlap each other end with one 200 and one 409", async () => {
    const day = nextDay();
    const a = await requestNachtrag(day, "08:00", "10:00");
    const b = await requestNachtrag(day, "12:00", "14:00");

    // A 08:00-11:30 and B 11:00-14:00 each avoid the other's ORIGINAL row but overlap each other.
    const [resA, resB] = await Promise.all([
      review(a.request.id, { startTime: "08:00", endTime: "11:30" }),
      review(b.request.id, { startTime: "11:00", endTime: "14:00" }),
    ]);
    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes, `${resA.body} / ${resB.body}`).toEqual([200, 409]);

    const loser = resA.statusCode === 409 ? a : b;
    const loserFrom = resA.statusCode === 409 ? "08:00" : "12:00";
    const loserTo = resA.statusCode === 409 ? "10:00" : "14:00";
    await expectUntouched(loser.request, loser.entry, day, loserFrom, loserTo);

    const valid = await app.prisma.timeEntry.findMany({
      where: { employeeId, date: new Date(`${day}T00:00:00Z`), deletedAt: null, isInvalid: false },
      orderBy: { startTime: "asc" },
    });
    expect(valid).toHaveLength(1);
    // No two rows of the day (valid or pending) overlap.
    const all = await app.prisma.timeEntry.findMany({
      where: { employeeId, date: new Date(`${day}T00:00:00Z`), deletedAt: null },
      orderBy: { startTime: "asc" },
    });
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i].startTime.getTime()).toBeGreaterThanOrEqual(all[i - 1].endTime!.getTime());
    }
  });

  it("lock race: an approval waiting on the employee lock sees the row the holder released", async () => {
    const day = nextDay();
    const a = await requestNachtrag(day, "08:00", "10:00");
    const b = await requestNachtrag(day, "12:00", "14:00");

    const { result, blocked } = await holdEmployeeLockThen(app, {
      tenantId,
      employeeId,
      // 10:30-14:00 clears A's row as submitted (08:00-10:00) - only the holder's change collides.
      start: () => review(b.request.id, { startTime: "10:30", endTime: "14:00" }),
      holderWork: async (tx) => {
        // The release of A exactly as an approval with corrected end 11:00 would leave it.
        await tx.timeEntry.update({
          where: { id: a.entry.id },
          data: {
            endTime: at(day, "11:00"),
            isInvalid: false,
            invalidReason: null,
            invalidReasonCode: null,
          },
        });
        await tx.retroEntryRequest.update({
          where: { id: a.request.id },
          data: { status: "APPROVED", reviewedBy: seed.adminUser.id, reviewedAt: new Date() },
        });
      },
    });

    expect(blocked, "the approval must queue on the employee lock").toBe(true);
    expect(result.statusCode, result.body).toBe(409);
    expect(JSON.parse(result.body).error).toBe(detailedText(day, "08:00", "11:00"));
    await expectUntouched(b.request, b.entry, day, "12:00", "14:00");
  });
});
