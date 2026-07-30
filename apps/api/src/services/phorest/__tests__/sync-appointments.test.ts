// Phase 86 (SA-01/SA-02/SA-03) — fetch-mocked fixture test for the Phorest appointment cache sync.
// Mirrors sync-shifts.test.ts's fetch-mock harness (afterEach restores global.fetch).
// Run via `pnpm --filter @clokr/api test -- sync-appointments` (pretest db-push) — NOT bare vitest.

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "../../../__tests__/setup";
import { todayInTz, dateStrInTz } from "../../../utils/timezone";
import { syncPhorestAppointments } from "../sync-appointments";
import { seedPhorestTenant, cleanupPhorestTenant } from "./helpers";
import appointmentsFixture from "./fixtures/appointments.json";

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
 * Compute an in-window target date the SAME way the service does (todayInTz + N UTC days), so the
 * service's per-date loop will request exactly this appointmentDate.
 */
function targetDateStr(daysAhead: number): string {
  const day = todayInTz(TZ);
  day.setUTCDate(day.getUTCDate() + daysAhead);
  return dateStrInTz(day, TZ);
}

/**
 * Rewrite the PII-laden fixture's appointment dates onto `dateStr` (keeping the time-of-day and the
 * PII fields), so the drop test runs against a real in-window date regardless of the calendar day
 * the suite executes on.
 */
function remapFixtureToDate(dateStr: string): unknown {
  const items = appointmentsFixture._embedded.appointments.map((a) => ({
    ...a,
    startTime: dateStr + a.startTime.slice(10),
    endTime: dateStr + a.endTime.slice(10),
  }));
  return { _embedded: { appointments: items } };
}

// Mock the appointment endpoint: return the (remapped, PII-laden) fixture ONLY for the target
// appointmentDate; every other forward date in the window returns an empty appointment page.
function mockPhorestAppointments(dateStr: string): void {
  const body = remapFixtureToDate(dateStr);
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const requested = new URL(u).searchParams.get("appointmentDate");
    const payload = requested === dateStr ? body : { _embedded: { appointments: [] } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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

      // SA-01: the busy window is stored with the correct employee + date + start/end.
      const first = rows[0];
      expect(first.employeeId).toBe(seed.mappedEmployeeId);
      expect(dateStrInTz(first.date, TZ)).toBe(dateStr);
      expect(first.startTime).toBe("09:00");
      expect(first.endTime).toBe("10:30");
      expect(rows[1].startTime).toBe("11:00");
      expect(rows[1].endTime).toBe("11:45");

      // SA-02 (load-bearing): the stored row carries ONLY the five allowed columns (+ id/createdAt).
      // The fixture item ALSO carried clientId/clientName/serviceName/price — none reached the row.
      expect(Object.keys(first).sort()).toEqual(ALLOWED_KEYS);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain("Jane Doe");
      expect(serialized).not.toContain("Haircut");
      expect(serialized).not.toContain("cust-abc-123");
      expect(serialized).not.toContain("89.5");
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
});
