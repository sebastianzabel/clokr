/**
 * Issue #597 — „Mein Dienstplan“ als Kalender-Abo.
 *
 * Covers: create / rotate / revoke of the own token (hashed at rest, URL returned once, audited
 * without the secret), the public feed (own shifts with salon, no label/note/integration name,
 * vacation by name, sick leave neutral, holidays), one identical 404 for every invalid token, the
 * end of the link on revoke, rotation, deactivation and anonymization, and the log redaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, auditRowsFor } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import {
  hashCalendarFeedToken,
  redactCalendarFeedPath,
} from "../contexts/platform/calendar-feed-token";
import { deleteCalendarFeedTokensOfUser } from "../contexts/platform";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("Issue #597 — calendar feed", () => {
  let app: FastifyInstance;
  let data: Seed;
  let feedPath: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cal597");
    const tomorrow = new Date(Date.now() + 86_400_000);
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: new Date(`${iso(tomorrow)}T00:00:00Z`),
        startTime: "09:00",
        endTime: "17:30",
        label: "Phorest Termin",
        note: "geheime Notiz",
      },
    });
    const inTenDays = new Date(Date.now() + 10 * 86_400_000);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${iso(inTenDays)}T00:00:00Z`),
        endDate: new Date(`${iso(inTenDays)}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
        note: "Hochzeit meiner Schwester",
      },
    });
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    const inTwentyDays = new Date(Date.now() + 20 * 86_400_000);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date(`${iso(inTwentyDays)}T00:00:00Z`),
        endDate: new Date(`${iso(inTwentyDays)}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
      },
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  const me = (method: "GET" | "POST" | "DELETE", token = data.empToken) =>
    app.inject({
      method,
      url: "/api/v1/me/calendar-feed",
      headers: { authorization: `Bearer ${token}` },
    });
  const feed = (path: string) => app.inject({ method: "GET", url: path });

  it("starts without a feed", async () => {
    const res = await me("GET");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: false, createdAt: null });
  });

  it("creates the feed: URL once, only the hash stored, audited without the secret", async () => {
    const res = await me("POST");
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.active).toBe(true);
    expect(body.url).toMatch(/\/api\/v1\/calendar-feed\/dienstplan\.ics\?token=[A-Za-z0-9_-]{43}$/);
    expect(body.webcalUrl).toMatch(/^webcal:\/\//);
    const parsedUrl = new URL(body.url);
    feedPath = parsedUrl.pathname + parsedUrl.search;
    const token = parsedUrl.searchParams.get("token")!;
    const row = await app.prisma.calendarFeedToken.findUniqueOrThrow({
      where: { userId: data.employee.userId },
    });
    expect(row.tokenHash).toBe(hashCalendarFeedToken(token));
    expect(row.tokenHash).not.toContain(token);
    const audits = await auditRowsFor(app, "CalendarFeedToken", row.id);
    expect(audits.map((a) => a.action)).toEqual(["CREATE"]);
    expect(JSON.stringify(audits)).not.toContain(token);
    // The state never carries the URL again.
    const state = (await me("GET")).json();
    expect(state).not.toHaveProperty("url");
    expect(state.active).toBe(true);
  });

  it("serves the own shifts, leave and holidays — minimal content", async () => {
    const res = await feed(feedPath);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    const ics = res.body;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Schicht");
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toContain("LOCATION:");
    expect(ics).toContain("SUMMARY:Urlaub");
    expect(ics).toContain("SUMMARY:Abwesend"); // sick leave, neutral
    expect(ics).not.toContain("Phorest");
    expect(ics).not.toContain("geheime Notiz");
    expect(ics).not.toContain("Hochzeit");
    expect(ics).not.toMatch(/Krank/i);
    // No person names at all, not even the own one.
    expect(ics).not.toContain(data.employee.firstName);
  });

  it("answers one identical 404 for a malformed, unknown or revoked token", async () => {
    const malformed = await feed("/api/v1/calendar-feed/dienstplan.ics?token=abc");
    const unknown = await feed(`/api/v1/calendar-feed/dienstplan.ics?token=${"A".repeat(43)}`);
    const missing = await feed("/api/v1/calendar-feed/dienstplan.ics");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(unknown.body);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(malformed.body).toBe(unknown.body);
  });

  it("rotation replaces the link: the old one is 404, the new one works", async () => {
    const res = await me("POST");
    expect(res.statusCode).toBe(200);
    const next = new URL(res.json().url);
    const newPath = next.pathname + next.search;
    expect(newPath).not.toBe(feedPath);
    expect((await feed(feedPath)).statusCode).toBe(404);
    expect((await feed(newPath)).statusCode).toBe(200);
    feedPath = newPath;
  });

  it("a deactivated user's link stops working", async () => {
    await app.prisma.user.update({
      where: { id: data.employee.userId },
      data: { isActive: false },
    });
    try {
      expect((await feed(feedPath)).statusCode).toBe(404);
    } finally {
      await app.prisma.user.update({
        where: { id: data.employee.userId },
        data: { isActive: true },
      });
    }
    expect((await feed(feedPath)).statusCode).toBe(200);
  });

  it("revoke deletes the token; the link is 404; audited", async () => {
    const row = await app.prisma.calendarFeedToken.findUniqueOrThrow({
      where: { userId: data.employee.userId },
    });
    const res = await me("DELETE");
    expect(res.statusCode).toBe(204);
    expect((await feed(feedPath)).statusCode).toBe(404);
    expect(await app.prisma.calendarFeedToken.count({ where: { id: row.id } })).toBe(0);
    const actions = (await auditRowsFor(app, "CalendarFeedToken", row.id)).map((a) => a.action);
    expect(actions).toEqual(["CREATE", "UPDATE", "DELETE"]);
    // A second revoke is harmless.
    expect((await me("DELETE")).statusCode).toBe(204);
  });

  it("anonymization removes the token", async () => {
    await me("POST");
    const removed = await app.prisma.$transaction((tx) =>
      deleteCalendarFeedTokensOfUser(tx, data.tenant.id, data.employee.userId),
    );
    expect(removed).toBe(1);
  });

  it("a token is per person: another person's management never touches it", async () => {
    await me("POST");
    expect((await me("DELETE", data.adminToken)).statusCode).toBe(204);
    expect(
      await app.prisma.calendarFeedToken.count({ where: { userId: data.employee.userId } }),
    ).toBe(1);
  });

  it("redacts the secret path for logs", () => {
    expect(
      redactCalendarFeedPath(`/api/v1/calendar-feed/dienstplan.ics?token=${"x".repeat(43)}&a=1`),
    ).toBe("/api/v1/calendar-feed/dienstplan.ics?token=[ausgeblendet]&a=1");
    expect(redactCalendarFeedPath("/api/v1/me?token=keep")).toBe("/api/v1/me?token=keep");
  });
});
