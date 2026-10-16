/**
 * Issue #70 (Phase 70b-04, D-04, T-70b-15) — § 9 Abs. 1 Nr. 2 JArbSchG over the DAY sum.
 *
 * The Berufsschultag rule of a minor is a DAY rule. While a day held one entry, comparing that
 * entry's planned minutes with the day limit was the whole check; with several entries per day a
 * Berufsschultag split into two entries would bypass it. The POST and PUT pre-checks and the
 * Nachtrag approval therefore hand `checkJArbSchG` the planned minutes of THIS entry plus the
 * working minutes of the OTHER closed WORK entries of the same day (the row set `checkArbZG`
 * evaluates, folded with `addWorkingMinutes`, the one working-time formula of #79). A single-entry
 * day yields the old value, so its behaviour is unchanged.
 *
 * Fixture: an AZUBI under 18 with a Berufsschultag on D (no slot context, so the LEGACY flat
 * 225-minute limit applies) and an existing closed WORK entry of 150 minutes on D.
 *  - POST a second entry of 100 minutes: day 250 > 225 -> 400 JARBSCHG_MINOR_LIMIT, nothing written.
 *  - the same POST with no other entry passes (unchanged single-entry behaviour).
 *  - a second entry that keeps the day at 225 passes (the limit is "more than 225").
 *  - PUT of the existing entry excludes itself from the day sum; a PUT that pushes the day over the
 *    limit is refused.
 *  - the Nachtrag approval with corrected times is held to the same day sum.
 *
 * Mutation proof (recorded in the 70b-04 SUMMARY, restored by `cp`): passing only the entry's own
 * minutes again turns the POST, PUT and approval refusals red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { checkJArbSchG } from "../contexts/absence";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";

const DAY = "2026-05-15"; // a Friday in the past
// A different ISO week than DAY: a lone Berufsschultag per week keeps the LEGACY flat-225 limit.
const RETRO_DAY = "2026-05-06";
const BIRTH_AGE_17 = new Date("2008-12-15T00:00:00.000Z");

function at(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00.000Z`);
}

describe("Issue #70 — § 9 JArbSchG compares the day sum", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let hardBlockMessage: string;

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { employeeId: seed.employee.id, breakMinutes: 0, ...payload },
    });
  const put = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { breakMinutes: 0, reason: "Korrektur nach Rückfrage", ...payload },
    });
  const seedEntry = (day: string, from: string, to: string) =>
    app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00.000Z`),
        startTime: at(day, from),
        endTime: at(day, to),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
        salonId: seed.salonId,
      },
    });
  const liveCount = (day: string) =>
    app.prisma.timeEntry.count({
      where: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00.000Z`),
        deletedAt: null,
      },
    });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "jds70");
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { classification: "AZUBI", birthDate: BIRTH_AGE_17 },
    });
    for (const day of [DAY, RETRO_DAY]) {
      await app.prisma.absence.create({
        data: {
          employeeId: seed.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "PATTERN",
          startDate: new Date(`${day}T00:00:00.000Z`),
          endDate: new Date(`${day}T00:00:00.000Z`),
          days: 1.0,
          createdBy: "jarbschg-day-sum-test",
        },
      });
    }
    const reference = await checkJArbSchG(app.prisma, {
      employeeId: seed.employee.id,
      date: new Date(`${DAY}T00:00:00.000Z`),
      plannedNetWorkMin: 480,
    });
    expect(reference.blocked).toBe(true);
    hardBlockMessage = reference.message!;
  });

  afterEach(async () => {
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.employee.id } });
    await app.prisma.retroEntryRequest.deleteMany({ where: { employeeId: seed.employee.id } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("POST of a second entry whose day sum exceeds 225 minutes is blocked; nothing is written", async () => {
    await seedEntry(DAY, "04:00", "06:30"); // 150 min
    const res = await post({
      date: DAY,
      startTime: at(DAY, "07:00").toISOString(),
      endTime: at(DAY, "08:40").toISOString(), // 100 min -> day 250
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("JARBSCHG_MINOR_LIMIT");
    expect(body.message).toBe(hardBlockMessage);
    expect(await liveCount(DAY)).toBe(1);
  });

  it("the same POST with no other entry passes (single-entry behaviour unchanged)", async () => {
    const res = await post({
      date: DAY,
      startTime: at(DAY, "07:00").toISOString(),
      endTime: at(DAY, "08:40").toISOString(),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await liveCount(DAY)).toBe(1);
  });

  it("a second entry that keeps the day at exactly 225 minutes passes", async () => {
    await seedEntry(DAY, "04:00", "06:30"); // 150 min
    const res = await post({
      date: DAY,
      startTime: at(DAY, "07:00").toISOString(),
      endTime: at(DAY, "08:15").toISOString(), // 75 min -> day 225
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await liveCount(DAY)).toBe(2);
  });

  it("PUT excludes the edited entry from the day sum and refuses a day over the limit", async () => {
    const existing = await seedEntry(DAY, "04:00", "06:30"); // 150 min
    await seedEntry(DAY, "07:00", "08:00"); // 60 min -> day 210

    // Same length again: 150 + 60 = 210 (counting the edited entry twice would be 360).
    const same = await put(existing.id, {
      startTime: at(DAY, "04:10").toISOString(),
      endTime: at(DAY, "06:40").toISOString(),
    });
    expect(same.statusCode, same.body).toBe(200);

    // Longer: 180 + 60 = 240 > 225.
    const longer = await put(existing.id, {
      startTime: at(DAY, "04:00").toISOString(),
      endTime: at(DAY, "07:00").toISOString(),
    });
    expect(longer.statusCode, longer.body).toBe(400);
    expect(JSON.parse(longer.body).error).toBe("JARBSCHG_MINOR_LIMIT");
    const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.endTime?.getTime()).toBe(at(DAY, "06:40").getTime());
  });

  it("the Nachtrag approval with corrected times is held to the day sum", async () => {
    await seedEntry(RETRO_DAY, "04:00", "06:30"); // 150 min
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: new Date(`${RETRO_DAY}T00:00:00.000Z`),
        reason: "Nachtrag fixture for the day sum",
        startTime: "09:00",
        endTime: "10:00",
        breakMinutes: 0,
        status: "PENDING",
      },
    });
    const coupled = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${RETRO_DAY}T00:00:00.000Z`),
        startTime: at(RETRO_DAY, "09:00"),
        endTime: at(RETRO_DAY, "10:00"),
        breakMinutes: 0,
        source: "MANUAL",
        isInvalid: true,
        ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
        retroRequestId: request.id,
        salonId: seed.salonId,
      },
    });
    const review = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/retro-entry-requests/${request.id}/review`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { status: "APPROVED", ...payload },
      });

    // 100 corrected minutes + 150 recorded = 250 > 225: refused before anything is written.
    const refused = await review({ startTime: "09:00", endTime: "10:40" });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(JSON.parse(refused.body).error).toBe("JARBSCHG_MINOR_LIMIT");
    const stillPending = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(stillPending.status).toBe("PENDING");

    // 60 corrected minutes + 150 recorded = 210: approved.
    const ok = await review({ startTime: "09:00", endTime: "10:00" });
    expect(ok.statusCode, ok.body).toBe(200);
    const released = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: coupled.id } });
    expect(released.isInvalid).toBe(false);
  });
});
