/**
 * Issue #70 (Phase 70b-04, D-06, I-19) — approving a Zeitnachtrag with corrected times cannot
 * overlap another entry of the day.
 *
 * With several entries per day the corrected times a manager writes onto the coupled Nachtrag entry
 * can land on another entry. The approval therefore locks the employee FIRST (the one writer lock of
 * Phase 70b), re-checks the overlap inside its transaction with the coupled entry excluded, and
 * answers 409 — never a 500 from the database's exclusion constraint. A refused approval changes
 * nothing: the request stays PENDING, the coupled entry keeps its as-submitted times and stays
 * invalid, and no approval audit row exists.
 *
 * The race case holds the employee lock in a competing transaction, starts the approval, waits until
 * PostgreSQL reports the approval blocked, lets the competitor commit an overlapping entry, and only
 * then lets the approval continue. Without lock-then-re-check the answer would be the neutral
 * database-level text instead of the detailed one asserted below.
 *
 * Mutation proof (recorded in the 70b-04 SUMMARY, restored by `cp`): removing the lock call turns
 * the race case red; removing the in-transaction re-check turns the first case red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, cleanupTestData, seedTestData, soleAuditRowOrNull } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";
import { holdEmployeeLockThen } from "./entry-lock-race-helpers";

function at(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

function detailedText(dayStr: string, from: string, to: string): string {
  const [y, m, d] = dayStr.split("-");
  return `Überschneidung mit bestehendem Eintrag vom ${d}.${m}.${y} (${from} – ${to})`;
}

describe("Issue #70 — Zeitnachtrag approval with corrected times", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let tenantId: string;
  let employeeId: string;

  /** A pending entry-first Nachtrag of `day` (09:00-12:00) plus its coupled invalid entry. */
  async function seedPending(day: string) {
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId,
        targetDate: new Date(`${day}T00:00:00Z`),
        reason: "Nachtrag fixture for the overlap approval",
        startTime: "09:00",
        endTime: "12:00",
        breakMinutes: 0,
        status: "PENDING",
      },
    });
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: at(day, "09:00"),
        endTime: at(day, "12:00"),
        breakMinutes: 0,
        source: "MANUAL",
        createdBy: employeeId,
        isInvalid: true,
        ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
        retroRequestId: request.id,
        salonId: seed.salonId,
      },
    });
    return { request, entry };
  }

  const review = (requestId: string, payload: Record<string, unknown>) =>
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

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "rao70");
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

  it("corrected times that overlap another entry: 409 with the overlap text, the request stays PENDING, nothing changes; non-overlapping times then approve", async () => {
    const day = nextWeekdayStr(pastDateStr(200));
    const { request, entry } = await seedPending(day);
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: at(day, "13:00"),
        endTime: at(day, "15:00"),
        source: "MANUAL",
        salonId: seed.salonId,
      },
    });

    const refused = await review(request.id, { startTime: "11:00", endTime: "14:00" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body).error).toBe(detailedText(day, "13:00", "15:00"));

    const requestAfter = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe("PENDING");
    expect(requestAfter.reviewedBy).toBeNull();
    const entryAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfter.startTime.getTime()).toBe(at(day, "09:00").getTime());
    expect(entryAfter.endTime?.getTime()).toBe(at(day, "12:00").getTime());
    expect(entryAfter.isInvalid).toBe(true);
    expect(await approvalAudits(request.id)).toBe(0);
    const correctionAudit = await soleAuditRowOrNull(app.prisma, {
      where: { entity: "TimeEntry", entityId: entry.id, action: "MANAGER_CORRECTION" },
    });
    expect(correctionAudit).toBeNull();

    // The same request is still decidable: times that end before the other entry are fine.
    const approved = await review(request.id, { startTime: "09:00", endTime: "12:30" });
    expect(approved.statusCode, approved.body).toBe(200);
    const released = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(released.isInvalid).toBe(false);
    expect(released.endTime?.getTime()).toBe(at(day, "12:30").getTime());
    expect(await approvalAudits(request.id)).toBe(1);
  });

  it("an approval without corrected times needs no overlap decision and releases the entry", async () => {
    const day = nextWeekdayStr(pastDateStr(207));
    const { request, entry } = await seedPending(day);
    const res = await review(request.id, {});
    expect(res.statusCode, res.body).toBe(200);
    const released = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(released.isInvalid).toBe(false);
    expect(released.startTime.getTime()).toBe(at(day, "09:00").getTime());
  });

  it("race: an overlapping entry committed while the approval waits for the employee lock is seen by the in-transaction re-check", async () => {
    const day = nextWeekdayStr(pastDateStr(214));
    const { request, entry } = await seedPending(day);

    const { result, blocked } = await holdEmployeeLockThen(app, {
      tenantId,
      employeeId,
      start: () => review(request.id, { startTime: "11:30", endTime: "14:00" }),
      holderWork: async (tx) => {
        await tx.timeEntry.create({
          data: {
            employeeId,
            date: new Date(`${day}T00:00:00Z`),
            startTime: at(day, "12:30"),
            endTime: at(day, "13:30"),
            source: "MANUAL",
            salonId: seed.salonId,
          },
        });
      },
    });

    expect(blocked, "the approval must queue on the employee lock").toBe(true);
    expect(result.statusCode, result.body).toBe(409);
    expect(JSON.parse(result.body).error).toBe(detailedText(day, "12:30", "13:30"));
    const requestAfter = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe("PENDING");
    const entryAfter = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfter.isInvalid).toBe(true);
    expect(entryAfter.endTime?.getTime()).toBe(at(day, "12:00").getTime());
    expect(await approvalAudits(request.id)).toBe(0);
  });
});
