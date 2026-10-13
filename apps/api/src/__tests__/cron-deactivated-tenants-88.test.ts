/**
 * Phase 88 (#88, D-05/D-05a/D-07a, AC-88-08) — background jobs and deactivated tenants.
 *
 * A deactivated tenant is a suspended customer: the writing and notifying cron jobs skip it, while
 * data retention keeps running (the lawful deletion duty does not pause with a contract). Each job is
 * proven through its exposed runner with `tenant.findMany` spied and resolved empty, so the proof is
 * the `where` argument the job asks the database with — no fixture data and no wall-clock dependency.
 * The final source scan makes the rule permanent for any future cron loop.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp } from "./setup";

let app: FastifyInstance;

beforeAll(async () => {
  app = await getTestApp();
});

afterAll(async () => {
  await closeTestApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs `run` with `tenant.findMany` resolved empty and returns every `where` it was asked with. */
async function tenantWheresOf(run: () => Promise<unknown>): Promise<unknown[]> {
  const spy = vi.spyOn(app.prisma.tenant, "findMany").mockResolvedValue([] as never);
  await run();
  return spy.mock.calls.map((call) => (call[0] as { where?: unknown } | undefined)?.where);
}

function expectEveryCallFiltered(wheres: unknown[]) {
  expect(wheres.length).toBeGreaterThan(0);
  for (const where of wheres) {
    expect(where).toMatchObject({ deactivatedAt: null });
  }
}

describe("Phase 88 tracer — auto-close-month and the attendance checker skip deactivated tenants", () => {
  it("tryAutoCloseMonth asks only for active tenants", async () => {
    expectEveryCallFiltered(await tenantWheresOf(() => app.tryAutoCloseMonth()));
  });

  const attendanceRunners = [
    "tryAutoInvalidate",
    "tryEndOfMonthGapReminder",
    "tryBeginningOfMonthGapReminder",
    "tryBreakUnconfirmedNudge",
    "tryVacationExpiry",
    "tryMissingEntriesCheck",
    "tryPendingLeaveReminder",
    "tryBreakFindingCheck",
  ] as const;

  for (const name of attendanceRunners) {
    it(`${name} asks only for active tenants`, async () => {
      const runner = (app as unknown as Record<string, (() => Promise<unknown>) | undefined>)[name];
      expect(typeof runner).toBe("function");
      expectEveryCallFiltered(await tenantWheresOf(() => runner!()));
    });
  }
});
