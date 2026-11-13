/**
 * Issue #609 (AC-4; D-08) - the reminder job never creates, changes or deletes a time entry or a
 * break, and never sends an e-mail for its three types, not even with SMTP configured and every
 * e-mail toggle on. It also proves the notice links (D-09).
 *
 * Every instant is built from an explicit tenant-local date and time (`localInstant`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import {
  TEST_DAY,
  addPerson,
  createEntry,
  createShift,
  localInstant,
  remindersOf,
  seedReminderTenant,
  type ReminderTenant,
} from "./shift-reminder-fixtures-609";

// The transporter is built inside notify.ts through a dynamic import of nodemailer (the same seam
// notification-email.test.ts uses), so a mocked createTransport observes every mail.
const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({ sendMail: sendMailMock }));
  return { default: { createTransport }, createTransport };
});

const SMTP_AND_EVERY_TOGGLE_ON = {
  smtpHost: "smtp.test.local",
  smtpPort: 587,
  smtpUser: "smtp-user",
  smtpPassword: "smtp-pass",
  smtpFromEmail: "noreply@test.local",
  smtpFromName: "Clokr Test",
  smtpSecure: false,
  emailNotificationsEnabled: true,
  emailOnLeaveRequest: true,
  emailOnLeaveDecision: true,
  emailOnOvertimeWarning: true,
  emailOnMissingEntries: true,
  emailOnClockOutReminder: true,
  emailOnMonthClose: true,
  emailOnRetroEntry: true,
};

const flush = () => new Promise((r) => setTimeout(r, 300));

let app: FastifyInstance;
let tenant: ReminderTenant;
let startUser: string;
let endUser: string;
let closeUser: string;

async function tick(hhmm: string): Promise<void> {
  await app.tryShiftReminders(localInstant(TEST_DAY, hhmm, tenant.tz));
  await app.settlePushDispatch();
}

async function entryAndBreakCounts() {
  const where = { employee: { tenantId: tenant.tenantId } };
  return {
    entries: await app.prisma.timeEntry.count({ where }),
    breaks: await app.prisma.break.count({ where: { timeEntry: where } }),
  };
}

beforeAll(async () => {
  app = await getTestApp();
  tenant = await seedReminderTenant(app, "nostamp", {
    startEnabled: true,
    endEnabled: true,
    dayCloseEnabled: true,
  });
  await app.prisma.tenantConfig.update({
    where: { tenantId: tenant.tenantId },
    data: SMTP_AND_EVERY_TOGGLE_ON,
  });
  // One person per occasion on the same day: START (no entry), END (open entry), DAY_CLOSE (nothing).
  const a = await addPerson(app, tenant);
  const b = await addPerson(app, tenant);
  const c = await addPerson(app, tenant);
  startUser = a.userId;
  endUser = b.userId;
  closeUser = c.userId;
  for (const p of [a, b, c])
    await createShift(app, tenant, p.employeeId, TEST_DAY, "09:00", "17:00");
  await createEntry(app, tenant, b.employeeId, localInstant(TEST_DAY, "09:00", tenant.tz), null);
});

afterAll(async () => {
  await cleanupTestData(app, tenant.tenantId);
  await closeTestApp();
});

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test-message-id" });
});

describe("the job writes only notices (AC-4)", () => {
  it("a run that fires all three occasions leaves the time entries and breaks unchanged", async () => {
    const before = await entryAndBreakCounts();
    const rowBefore = await app.prisma.timeEntry.findMany({
      where: { employee: { tenantId: tenant.tenantId } },
      orderBy: { id: "asc" },
    });
    await tick("09:15");
    await tick("17:15");
    await tick("20:00");
    expect(await remindersOf(app, startUser, "REMINDER_SHIFT_START")).toHaveLength(1);
    expect(await remindersOf(app, endUser, "REMINDER_SHIFT_END")).toHaveLength(1);
    expect(await remindersOf(app, closeUser, "REMINDER_DAY_CLOSE")).toHaveLength(1);
    expect(await entryAndBreakCounts()).toEqual(before);
    const rowAfter = await app.prisma.timeEntry.findMany({
      where: { employee: { tenantId: tenant.tenantId } },
      orderBy: { id: "asc" },
    });
    expect(rowAfter).toEqual(rowBefore);
  });

  it("links the three types to the clock (start, end) and to the list view of the day (day close)", async () => {
    const [start] = await remindersOf(app, startUser, "REMINDER_SHIFT_START");
    const [end] = await remindersOf(app, endUser, "REMINDER_SHIFT_END");
    const [close] = await remindersOf(app, closeUser, "REMINDER_DAY_CLOSE");
    expect(start?.link).toBe("/dashboard?clock=1");
    expect(end?.link).toBe("/dashboard?clock=1");
    expect(close?.link).toBe(`/time-entries?view=list&date=${TEST_DAY}`);
  });
});

describe("the job never writes a time entry or a break (source pin)", () => {
  const FILES = [
    "../contexts/time-tracking/shift-reminders.ts",
    "../contexts/time-tracking/shift-reminder-job.ts",
  ];
  const WRITE =
    /\.(timeEntry|break)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

  /** Drops block and line comments; the two job files contain no `//` inside a string literal. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  }

  it("walks both job files and sees code in them (the pin is not vacuous)", () => {
    const sources = FILES.map((f) => stripComments(readFileSync(join(__dirname, f), "utf8")));
    expect(sources).toHaveLength(2);
    for (const code of sources) expect(code).toContain("export ");
    expect(sources[1]).toContain("app.notify(");
  });

  it("the pattern fires on a write and ignores a comment (the pin can fail)", () => {
    expect(WRITE.test("await app.prisma.timeEntry.update({})")).toBe(true);
    expect(WRITE.test("tx.break.deleteMany({})")).toBe(true);
    expect(WRITE.test(stripComments("// app.prisma.timeEntry.update({})"))).toBe(false);
    expect(WRITE.test(stripComments("/* tx.break.create */ const x = 1;"))).toBe(false);
  });

  it.each(FILES)("%s contains no timeEntry or break write call", (file) => {
    const code = stripComments(readFileSync(join(__dirname, file), "utf8"));
    expect(code).not.toMatch(WRITE);
  });
});

describe("no e-mail for the three types (D-08)", () => {
  it("makes zero sendMail calls with SMTP configured and every toggle on, while a notify of CLOCK_OUT_REMINDER does mail (control)", async () => {
    // New persons and a later day, so the three occasions fire again for fresh notices.
    const day = "2026-11-17";
    const a = await addPerson(app, tenant);
    const b = await addPerson(app, tenant);
    const c = await addPerson(app, tenant);
    for (const p of [a, b, c]) await createShift(app, tenant, p.employeeId, day, "09:00", "17:00");
    await createEntry(app, tenant, b.employeeId, localInstant(day, "09:00", tenant.tz), null);
    for (const hhmm of ["09:15", "17:15", "20:00"]) {
      await app.tryShiftReminders(localInstant(day, hhmm, tenant.tz));
      await app.settlePushDispatch();
    }
    expect(await remindersOf(app, a.userId, "REMINDER_SHIFT_START")).toHaveLength(1);
    expect(await remindersOf(app, b.userId, "REMINDER_SHIFT_END")).toHaveLength(1);
    expect(await remindersOf(app, c.userId, "REMINDER_DAY_CLOSE")).toHaveLength(1);
    await flush();
    expect(sendMailMock).not.toHaveBeenCalled();

    // Control: the mock observes mails - the same user, the same toggles, a type that mails.
    await app.notify({
      userId: a.userId,
      tenantId: tenant.tenantId,
      type: "CLOCK_OUT_REMINDER",
      title: "Vergessene Stempelung",
      message: "Kontrolle",
      link: "/dashboard",
    });
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
  });
});
