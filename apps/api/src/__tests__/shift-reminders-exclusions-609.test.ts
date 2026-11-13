/**
 * Issue #609 (AC-3; D-05, D-12) - none of the three reminders is sent on a day of effective leave,
 * sick leave, an imposed absence, a holiday of the shift's salon or for a shift flagged as
 * conflicting with leave. Table driven: three occasions x eight exclusion kinds (24 suppressed cases),
 * plus the controls that must still send exactly one notice.
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`). Each case uses
 * its own person, so the once-per-shift dedupe cannot mask a rule.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import {
  TEST_DAY,
  addPerson,
  addSalon,
  createAbsence,
  createEntry,
  createLeave,
  createManualHoliday,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

type Occasion = {
  name: string;
  type: string;
  /** The tenant-local time of the tick that makes the occasion due. */
  tickAt: string;
  /** Whether the person must be clocked in (an open entry) for the occasion to apply. */
  openEntry: boolean;
};

const OCCASIONS: Occasion[] = [
  { name: "START", type: "REMINDER_SHIFT_START", tickAt: "09:15", openEntry: false },
  { name: "END", type: "REMINDER_SHIFT_END", tickAt: "17:15", openEntry: true },
  { name: "DAY_CLOSE", type: "REMINDER_DAY_CLOSE", tickAt: "20:00", openEntry: false },
];

/** A statutory holiday in every Bundesland (first Christmas day), a Friday in 2026. */
const STATUTORY_HOLIDAY = "2026-12-25";
/** A day that carries a manual holiday row of the first salon, and no other special day. */
const MANUAL_HOLIDAY = "2026-11-12";

let app: FastifyInstance;
let tenant: ReminderTenant;
let secondSalonId: string;
const tenantIds: string[] = [];

interface Situation {
  /** The shift day; defaults to the test day. */
  day?: string;
  /** Set the exclusion up for the fresh person. */
  setup?: (employeeId: string, otherEmployeeId: string, day: string) => Promise<void>;
  flagged?: boolean;
  salonId?: () => string;
}

/** Builds one fresh person with a 09:00-17:00 shift, the situation, runs the tick; returns its notices. */
async function run(occasion: Occasion, situation: Situation): Promise<number> {
  const day = situation.day ?? TEST_DAY;
  const person = await addPerson(app, tenant);
  const other = await addPerson(app, tenant);
  await situation.setup?.(person.employeeId, other.employeeId, day);
  await createShift(app, tenant, person.employeeId, day, "09:00", "17:00", {
    conflictsWithLeave: situation.flagged ?? false,
    ...(situation.salonId && { salonId: situation.salonId() }),
  });
  if (occasion.openEntry) {
    await createEntry(app, tenant, person.employeeId, localInstant(day, "09:00", tenant.tz), null);
  }
  await app.tryShiftReminders(localInstant(day, occasion.tickAt, tenant.tz));
  await app.settlePushDispatch();
  return (await remindersOf(app, person.userId, occasion.type)).length;
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "exclusions", {
    startEnabled: true,
    endEnabled: true,
    dayCloseEnabled: true,
  });
  tenantIds.push(tenant.tenantId);
  secondSalonId = await addSalon(app, tenant);
  await createManualHoliday(app, tenant, tenant.salonId, MANUAL_HOLIDAY);
  // A manual holiday of the SECOND salon on the test day: the first salon's shifts stay unaffected.
  await createManualHoliday(app, tenant, secondSalonId, TEST_DAY);
});

afterAll(async () => {
  for (const id of tenantIds) await cleanupTestData(app, id);
  await closeTestApp();
});

const EXCLUSIONS: [string, Situation][] = [
  [
    "approved vacation",
    { setup: (e, _o, d) => createLeave(app, tenant, e, d, d).then(() => undefined) },
  ],
  [
    "vacation with a cancellation requested",
    {
      setup: (e, _o, d) =>
        createLeave(app, tenant, e, d, d, { status: "CANCELLATION_REQUESTED" }).then(
          () => undefined,
        ),
    },
  ],
  [
    "approved sick leave",
    {
      setup: (e, _o, d) =>
        createLeave(app, tenant, e, d, d, { code: "SICK" }).then(() => undefined),
    },
  ],
  [
    "approved half-day vacation (D-12)",
    {
      setup: (e, _o, d) =>
        createLeave(app, tenant, e, d, d, { halfDay: true }).then(() => undefined),
    },
  ],
  [
    "imposed absence (Berufsschule)",
    { setup: (e, _o, d) => createAbsence(app, e, d, d).then(() => undefined) },
  ],
  ["statutory holiday of the shift's salon", { day: STATUTORY_HOLIDAY }],
  ["manual holiday of the shift's salon", { day: MANUAL_HOLIDAY }],
  ["shift flagged as conflicting with leave", { flagged: true }],
];

describe("no reminder on an excluded day (AC-3, D-05, D-12)", () => {
  it("has eight exclusion kinds and three occasions (24 suppressed cases)", () => {
    expect(EXCLUSIONS).toHaveLength(8);
    expect(OCCASIONS).toHaveLength(3);
  });

  describe.each(OCCASIONS)("$name", (occasion) => {
    it("sends exactly one notice on an ordinary day (base control)", async () => {
      expect(await run(occasion, {})).toBe(1);
    });

    it.each(EXCLUSIONS)("sends nothing on %s", async (_name, situation) => {
      expect(await run(occasion, situation)).toBe(0);
    });
  });
});

describe("controls - what must NOT silence a reminder", () => {
  describe.each(OCCASIONS)("$name", (occasion) => {
    it("still sends with a PENDING vacation on the day", async () => {
      expect(
        await run(occasion, {
          setup: (e, _o, d) =>
            createLeave(app, tenant, e, d, d, { status: "PENDING" }).then(() => undefined),
        }),
      ).toBe(1);
    });

    it("still sends when ANOTHER person has vacation on the day", async () => {
      expect(
        await run(occasion, {
          setup: (_e, o, d) => createLeave(app, tenant, o, d, d).then(() => undefined),
        }),
      ).toBe(1);
    });

    it("still sends when the vacation was on the day before only", async () => {
      expect(
        await run(occasion, {
          setup: (e) =>
            createLeave(app, tenant, e, "2026-11-09", "2026-11-09").then(() => undefined),
        }),
      ).toBe(1);
    });

    it("still sends when only a SECOND salon has a manual holiday on the day", async () => {
      // The second salon's holiday sits on the test day; the shift is in the first salon.
      expect(await run(occasion, {})).toBe(1);
    });

    it("is silent for the same shift once it lies in the second salon (the holiday applies there)", async () => {
      expect(await run(occasion, { salonId: () => secondSalonId })).toBe(0);
    });
  });

  it("DAY_CLOSE: a day with one flagged and one unflagged shift gives one notice", async () => {
    const person = await addPerson(app, tenant);
    await createShift(app, tenant, person.employeeId, TEST_DAY, "08:00", "12:00", {
      conflictsWithLeave: true,
    });
    await createShift(app, tenant, person.employeeId, TEST_DAY, "13:00", "19:00");
    await app.tryShiftReminders(localInstant(TEST_DAY, "20:00", tenant.tz));
    await app.settlePushDispatch();
    expect(await remindersOf(app, person.userId, "REMINDER_DAY_CLOSE")).toHaveLength(1);
  });
});
