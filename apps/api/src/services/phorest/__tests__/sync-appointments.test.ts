// Phase 85 Plan 07 (SA-01/SA-02/SA-03) — fetch-mocked fixture test for the Phorest appointment cache sync.
// Reconciled to the REAL v3 /appointment wire-shape: a DATE-RANGE fetch (from_date/to_date, paged),
// items carrying a SEPARATE appointmentDate ("yyyy-MM-dd") + Joda LocalTime "HH:mm:ss" start/end, and the
// full PII payload (clientId/clientName/serviceName/price/notes). The DSGVO drop test feeds those PII fields
// and asserts they never reach the stored row. Mirrors sync-shifts.test.ts's fetch-mock harness
// (afterEach restores global.fetch). Run via `pnpm --filter @clokr/api test -- sync-appointments`
// (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { todayInTz, dateStrInTz } from "../../../utils/timezone";
import { syncPhorestAppointments } from "../sync-appointments";
import {
  seedPhorestTenant,
  cleanupPhorestTenant,
  MAPPED_STAFF_ID,
  UNMAPPED_STAFF_ID,
} from "./helpers";
import appointmentsFixture from "./fixtures/appointments.json";
import appointmentsCancelledFixture from "./fixtures/appointments-cancelled.json";
import appointmentsPagedP1 from "./fixtures/appointments-paged-p1.json";
import appointmentsPagedP2 from "./fixtures/appointments-paged-p2.json";

const originalFetch = global.fetch;
const TZ = "Europe/Berlin";

// The exact five business columns a stored PhorestAppointment row may carry, plus id + createdAt.
// The DSGVO minimization (SA-02) is asserted against this exact set — nothing customer/service/price.
const ALLOWED_KEYS = [
  "createdAt",
  "date",
  "employeeId",
  "endTime",
  "externalId",
  "id",
  "startTime",
];

/**
 * Compute an in-window target date the SAME way the service does (todayInTz + N UTC days). The service
 * fetches a SINGLE date range today..today+horizon, so any date within the window is covered by one request.
 */
function targetDateStr(daysAhead: number): string {
  const day = todayInTz(TZ);
  day.setUTCDate(day.getUTCDate() + daysAhead);
  return dateStrInTz(day, TZ);
}

/** Shape of any of the appointment fixtures (v3 PII-laden items + a page envelope). */
type AppointmentFixture = {
  _embedded: { appointments: { appointmentDate: string; startTime: string; endTime: string }[] };
  page?: unknown;
};

/**
 * Rewrite every fixture item's `appointmentDate` onto `dateStr` (keeping the LocalTime "HH:mm:ss"
 * startTime/endTime + every PII field), so a test runs against a real in-window date regardless of the
 * calendar day the suite executes on. All non-`_embedded` top-level keys (notably `page`) are preserved.
 */
function remapFixtureToDate(fixture: AppointmentFixture, dateStr: string): unknown {
  const items = fixture._embedded.appointments.map((a) => ({ ...a, appointmentDate: dateStr }));
  return { ...fixture, _embedded: { appointments: items } };
}

const EMPTY_PAGE = { _embedded: { appointments: [] } };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** True when the request's [from_date, to_date] range covers `dateStr` (yyyy-MM-dd sorts lexically). */
function rangeCovers(params: URLSearchParams, dateStr: string): boolean {
  const from = params.get("from_date");
  const to = params.get("to_date");
  return !!from && !!to && from <= dateStr && dateStr <= to;
}

// Mock the range /appointment endpoint: return the (remapped, PII-laden) fixture when the requested
// from_date/to_date window covers the target date; otherwise an empty appointment page.
function mockPhorestAppointments(
  dateStr: string,
  fixture: AppointmentFixture = appointmentsFixture,
): void {
  const body = remapFixtureToDate(fixture, dateStr);
  global.fetch = vi.fn(async (url: string | URL) => {
    const params = new URL(url.toString()).searchParams;
    return jsonResponse(rangeCovers(params, dateStr) ? body : EMPTY_PAGE);
  }) as unknown as typeof fetch;
}

// Every appointment fetch fails with a non-ok HTTP status → GATE-1 (fetch-ok) fail-closed.
function mockPhorestAppointments503(): void {
  global.fetch = vi.fn(async () =>
    jsonResponse("upstream unavailable", 503),
  ) as unknown as typeof fetch;
}

// Paginated: when the range covers the target date, dispatch on the `page` query param — page 0 → p1
// (has-more), page 1 → p2 (final). A range that does not cover the target date returns a single empty page.
function mockPhorestAppointmentsPaged(dateStr: string): void {
  const p1 = remapFixtureToDate(appointmentsPagedP1, dateStr);
  const p2 = remapFixtureToDate(appointmentsPagedP2, dateStr);
  global.fetch = vi.fn(async (url: string | URL) => {
    const params = new URL(url.toString()).searchParams;
    if (!rangeCovers(params, dateStr)) return jsonResponse(EMPTY_PAGE);
    return jsonResponse(params.get("page") === "1" ? p2 : p1);
  }) as unknown as typeof fetch;
}

// Return an inline appointment body when the requested range covers the target date.
function mockPhorestAppointmentsBody(dateStr: string, body: unknown): void {
  global.fetch = vi.fn(async (url: string | URL) => {
    const params = new URL(url.toString()).searchParams;
    return jsonResponse(rangeCovers(params, dateStr) ? body : EMPTY_PAGE);
  }) as unknown as typeof fetch;
}

describe("phorest sync-appointments", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("SA-01/SA-02: reads mapped-staff appointments, stores DSGVO-minimal rows, drops all PII", async () => {
    const seed = await seedPhorestTenant(app, "appt");
    try {
      const dateStr = targetDateStr(3);
      mockPhorestAppointments(dateStr);

      const res = await syncPhorestAppointments(app, seed.tenantId, {});
      expect(res.status).toBe("SUCCESS");
      expect(res.appointmentsStored).toBe(2); // two mapped appointment items → two rows

      const rows = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
        orderBy: { startTime: "asc" },
      });
      expect(rows.length).toBe(2);

      // SA-01: the busy window is stored with the correct employee + date + start/end. The date comes
      // from appointmentDate; start/end from the LocalTime "HH:mm:ss" sliced to "HH:mm".
      const first = rows[0];
      expect(first.employeeId).toBe(seed.mappedEmployeeId);
      expect(dateStrInTz(first.date, TZ)).toBe(dateStr);
      expect(first.startTime).toBe("09:00");
      expect(first.endTime).toBe("10:30");
      expect(rows[1].startTime).toBe("11:00");
      expect(rows[1].endTime).toBe("11:45");
      // externalId is the Phorest appointmentId.
      expect(first.externalId).toBe("appt-mapped-1");
      expect(rows[1].externalId).toBe("appt-mapped-2");

      // SA-02 (load-bearing): the stored row carries ONLY the five allowed columns (+ id/createdAt).
      // The fixture item ALSO carried clientId/clientName/serviceName/price/notes — none reached the row.
      expect(Object.keys(first).sort()).toEqual(ALLOWED_KEYS);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain("Jane Doe");
      expect(serialized).not.toContain("Haircut");
      expect(serialized).not.toContain("cust-abc-123");
      expect(serialized).not.toContain("89.5");
      expect(serialized).not.toContain("Allergie: PPD");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SA-03: appointment counters are recorded onto the shared PhorestSyncRun (opts.runId)", async () => {
    const seed = await seedPhorestTenant(app, "apptrun");
    try {
      const dateStr = targetDateStr(2);
      mockPhorestAppointments(dateStr);

      // Simulate the shift run the shift sync creates; the appointment sync must record onto it.
      const run = await app.prisma.phorestSyncRun.create({
        data: { tenantId: seed.tenantId, status: "SUCCESS" },
      });

      const res = await syncPhorestAppointments(app, seed.tenantId, { runId: run.id });
      expect(res.status).toBe("SUCCESS");
      expect(res.appointmentsStored).toBe(2);

      const reloaded = await app.prisma.phorestSyncRun.findUnique({ where: { id: run.id } });
      expect(reloaded?.appointmentsStored).toBe(2);
      expect(reloaded?.appointmentsRemoved).toBe(0);
      // Shift-owned status is NOT touched by the appointment sync.
      expect(reloaded?.status).toBe("SUCCESS");
      expect(reloaded?.appointmentError).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SA-02 hard-replace: a cancelled/moved slot is HARD-DELETED on re-sync (appointmentsRemoved counted)", async () => {
    const seed = await seedPhorestTenant(app, "hardreplace");
    try {
      const dateStr = targetDateStr(3);

      // First sync: the full two-slot window → two rows.
      mockPhorestAppointments(dateStr, appointmentsFixture);
      const first = await syncPhorestAppointments(app, seed.tenantId, {});
      expect(first.status).toBe("SUCCESS");
      expect(first.appointmentsStored).toBe(2);

      // Re-sync against the same window MINUS the appt-mapped-2 slot → it must be gone (hard delete).
      mockPhorestAppointments(dateStr, appointmentsCancelledFixture);
      const second = await syncPhorestAppointments(app, seed.tenantId, {});
      expect(second.status).toBe("SUCCESS");
      expect(second.appointmentsStored).toBe(1);
      expect(second.appointmentsRemoved).toBeGreaterThanOrEqual(1);

      const rows = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
      });
      expect(rows.length).toBe(1);
      // The surviving slot is the 09:00 one; the cancelled 11:00 slot is GONE (hard delete, not soft).
      expect(rows[0].startTime).toBe("09:00");
      expect(rows.some((r) => r.startTime === "11:00")).toBe(false);
      // externalId of the removed slot is truly gone (globally unique key freed, not soft-deleted).
      const orphan = await app.prisma.phorestAppointment.findUnique({
        where: { externalId: "appt-mapped-2" },
      });
      expect(orphan).toBeNull();
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("GATE-1 fail-closed: a 503 fetch → status ERROR, pre-existing rows byte-for-byte unchanged, appointmentError set", async () => {
    const seed = await seedPhorestTenant(app, "failclosed");
    try {
      const dateStr = targetDateStr(4);
      const run = await app.prisma.phorestSyncRun.create({
        data: { tenantId: seed.tenantId, status: "SUCCESS" },
      });

      // Seed two rows via a successful sync so a false-wipe would have something to destroy.
      mockPhorestAppointments(dateStr, appointmentsFixture);
      const seededRes = await syncPhorestAppointments(app, seed.tenantId, { runId: run.id });
      expect(seededRes.appointmentsStored).toBe(2);

      const before = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
        orderBy: { startTime: "asc" },
      });
      expect(before.length).toBe(2);

      // Now every appointment fetch 503s → GATE-1: status ERROR, ZERO deletes/inserts.
      mockPhorestAppointments503();
      const res = await syncPhorestAppointments(app, seed.tenantId, { runId: run.id });
      expect(res.status).toBe("ERROR");
      expect(res.appointmentsRemoved).toBe(0);
      expect(res.appointmentsStored).toBe(0);

      // Pre-existing rows are byte-for-byte unchanged (same ids + createdAt — no delete+recreate).
      const after = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
        orderBy: { startTime: "asc" },
      });
      expect(after.length).toBe(2);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after.map((r) => r.createdAt.getTime())).toEqual(
        before.map((r) => r.createdAt.getTime()),
      );

      // The error is recorded onto the shared run's appointmentError (shift-owned status untouched).
      const reloaded = await app.prisma.phorestSyncRun.findUnique({ where: { id: run.id } });
      expect(reloaded?.appointmentError).toBeTruthy();
      expect(reloaded?.status).toBe("SUCCESS");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SA-03 horizon-bound: the fetch window is today..today+horizon; an appointment beyond to_date is never stored", async () => {
    const seed = await seedPhorestTenant(app, "horizon");
    try {
      // horizonDays=2 → the range fetch is from_date=today, to_date=today+2. Place the fixture on
      // today+5 (OUT of window) → the mock returns an empty page, nothing is stored.
      const outOfWindow = targetDateStr(5);
      mockPhorestAppointments(outOfWindow, appointmentsFixture);

      const res = await syncPhorestAppointments(app, seed.tenantId, { horizonDays: 2 });
      expect(res.status).toBe("SUCCESS");
      expect(res.appointmentsStored).toBe(0);

      const rows = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
      });
      expect(rows.length).toBe(0);

      // The request window bounds are exactly today..today+horizon (a single date-range fetch, no
      // per-day loop). The out-of-window date lies beyond to_date, so it is never covered.
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      const rangeParams = fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams);
      expect(rangeParams.length).toBeGreaterThanOrEqual(1);
      const first = rangeParams[0];
      expect(first.get("from_date")).toBe(targetDateStr(0));
      expect(first.get("to_date")).toBe(targetDateStr(2));
      // No request ever carried a to_date reaching the out-of-window date.
      expect(rangeParams.every((p) => (p.get("to_date") ?? "") < outOfWindow)).toBe(true);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("SA-01 unmapped-skip: an UNMAPPED_STAFF_ID appointment is never stored", async () => {
    const seed = await seedPhorestTenant(app, "unmapped");
    try {
      const dateStr = targetDateStr(2);
      // A branch-wide appointment for a staff member with NO explicit mapping — must be skipped.
      mockPhorestAppointmentsBody(dateStr, {
        _embedded: {
          appointments: [
            {
              appointmentId: "appt-unmapped-1",
              staffId: UNMAPPED_STAFF_ID,
              appointmentDate: dateStr,
              startTime: "09:00:00",
              endTime: "10:00:00",
              clientName: "Walk In",
              serviceName: "Cut",
              price: 20,
            },
          ],
        },
      });

      const res = await syncPhorestAppointments(app, seed.tenantId, {});
      expect(res.status).toBe("SUCCESS");
      expect(res.appointmentsStored).toBe(0);

      // Neither the unmapped employee nor anyone else in the tenant got a row.
      const unmappedRows = await app.prisma.phorestAppointment.count({
        where: { employeeId: seed.unmappedEmployeeId },
      });
      expect(unmappedRows).toBe(0);
      const anyRows = await app.prisma.phorestAppointment.count({
        where: { employee: { tenantId: seed.tenantId } },
      });
      expect(anyRows).toBe(0);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("WR-01 dedupe: two items sharing an externalId → ONE stored row, run stays SUCCESS (no ERROR)", async () => {
    const seed = await seedPhorestTenant(app, "dupextid");
    try {
      const dateStr = targetDateStr(3);
      const run = await app.prisma.phorestSyncRun.create({
        data: { tenantId: seed.tenantId, status: "SUCCESS" },
      });

      // Two mapped-staff appointments that collapse to the SAME externalId: a genuinely
      // double-booked identical window (same appointmentId here; the composite fallback key would
      // collide too). An unfiltered createMany inside the $transaction would throw on the @unique
      // externalId, roll back the deleteMany, and flip the run to ERROR — this must NOT happen.
      mockPhorestAppointmentsBody(dateStr, {
        _embedded: {
          appointments: [
            {
              appointmentId: "appt-dup-1",
              staffId: MAPPED_STAFF_ID,
              appointmentDate: dateStr,
              startTime: "09:00:00",
              endTime: "10:00:00",
              clientName: "Jane Doe",
              serviceName: "Haircut",
              price: 42,
            },
            {
              appointmentId: "appt-dup-1", // SAME externalId → must collapse to one stored row
              staffId: MAPPED_STAFF_ID,
              appointmentDate: dateStr,
              startTime: "09:00:00",
              endTime: "10:00:00",
              clientName: "John Smith",
              serviceName: "Beard Trim",
              price: 25,
            },
          ],
        },
      });

      const res = await syncPhorestAppointments(app, seed.tenantId, { runId: run.id });
      // The duplicate did NOT abort the hard-replace: run is SUCCESS, not ERROR.
      expect(res.status).toBe("SUCCESS");
      // appointmentsStored counts rows actually written (deduped), not the two fetched items.
      expect(res.appointmentsStored).toBe(1);

      const rows = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
      });
      expect(rows.length).toBe(1);
      expect(rows[0].externalId).toBe("appt-dup-1");

      // The shared run recorded the deduped count and NO appointmentError.
      const reloaded = await app.prisma.phorestSyncRun.findUnique({ where: { id: run.id } });
      expect(reloaded?.appointmentsStored).toBe(1);
      expect(reloaded?.appointmentError).toBeNull();
      expect(reloaded?.status).toBe("SUCCESS");
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });

  it("GATE-2 pagination: a two-page range is fully read before the hard-replace → both pages' slots stored", async () => {
    const seed = await seedPhorestTenant(app, "paged");
    try {
      const dateStr = targetDateStr(3);
      mockPhorestAppointmentsPaged(dateStr);

      const res = await syncPhorestAppointments(app, seed.tenantId, {});
      expect(res.status).toBe("SUCCESS");
      // Page 1 (09:00) + page 2 (14:00) → BOTH stored (page-2 slot not lost).
      expect(res.appointmentsStored).toBe(2);

      const rows = await app.prisma.phorestAppointment.findMany({
        where: { employeeId: seed.mappedEmployeeId },
        orderBy: { startTime: "asc" },
      });
      expect(rows.map((r) => r.startTime)).toEqual(["09:00", "14:00"]);
    } finally {
      await cleanupPhorestTenant(app, seed.tenantId);
    }
  });
});
