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
import cron from "node-cron";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

// The Phorest orchestrator is the observable of "a sync started": the callback guard is proven by it
// not being entered for a deactivated tenant, with the active tenant as the positive control.
const syncPhorestForTenant = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../services/phorest/sync-tenant", () => ({ syncPhorestForTenant }));

let app: FastifyInstance;
let tenantId: string;

beforeAll(async () => {
  app = await getTestApp();
  tenantId = (await seedTestData(app, "cron88")).tenant.id;
});

afterAll(async () => {
  await app.prisma.tenant.update({ where: { id: tenantId }, data: { deactivatedAt: null } });
  await cleanupTestData(app, tenantId);
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

describe("Phase 88 — the remaining writing jobs skip deactivated tenants", () => {
  it("remindDeferredMonthClose asks only for active tenants", async () => {
    expectEveryCallFiltered(await tenantWheresOf(() => app.remindDeferredMonthClose()));
  });

  it("runCarryoverWarningOnce asks only for active tenants", async () => {
    expectEveryCallFiltered(await tenantWheresOf(() => app.runCarryoverWarningOnce()));
  });

  it("runCarryoverWarningOnce keeps the active filter next to an onlyTenantId narrowing", async () => {
    const wheres = await tenantWheresOf(() =>
      app.runCarryoverWarningOnce({ onlyTenantId: tenantId }),
    );
    expectEveryCallFiltered(wheres);
    expect(wheres[0]).toMatchObject({ id: tenantId });
  });

  it("runVocationalSchoolGeneration asks only for active tenants", async () => {
    expectEveryCallFiltered(await tenantWheresOf(() => app.runVocationalSchoolGeneration!()));
  });
});

describe("Phase 88 — the Phorest scheduler", () => {
  it("registers cron tasks only for auto-sync tenants that are active", async () => {
    const spy = vi.spyOn(app.prisma.tenantConfig, "findMany").mockResolvedValue([] as never);
    await app.refreshScheduler!();
    const where = (spy.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    expect(where).toMatchObject({ phorestAutoSync: true, tenant: { deactivatedAt: null } });
  });

  it("a task registered before the deactivation does not start a sync afterwards", async () => {
    vi.spyOn(app.prisma.tenantConfig, "findMany").mockResolvedValue([
      { tenantId, phorestSyncCron: "0 3 * * *" },
    ] as never);
    const callbacks: Array<() => void> = [];
    vi.spyOn(cron, "schedule").mockImplementation(((_expr: string, fn: () => void) => {
      callbacks.push(fn);
      return { stop: vi.fn() };
    }) as never);
    await app.refreshScheduler!();
    expect(callbacks).toHaveLength(1);
    const fire = callbacks[0]!;

    // Positive control: the active tenant's callback does start a sync.
    syncPhorestForTenant.mockClear();
    app.invalidateTenantState(tenantId);
    fire();
    await vi.waitFor(() => expect(syncPhorestForTenant).toHaveBeenCalledTimes(1));

    // Deactivated after registration: the same callback must not reach the orchestrator.
    await app.prisma.tenant.update({
      where: { id: tenantId },
      data: { deactivatedAt: new Date() },
    });
    app.invalidateTenantState(tenantId);
    syncPhorestForTenant.mockClear();
    const isActive = vi.spyOn(app, "tenantIsActive");
    try {
      fire();
      await vi.waitFor(() => expect(isActive).toHaveBeenCalledWith(tenantId));
      await isActive.mock.results[0].value;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(syncPhorestForTenant).not.toHaveBeenCalled();
    } finally {
      await app.prisma.tenant.update({ where: { id: tenantId }, data: { deactivatedAt: null } });
      app.invalidateTenantState(tenantId);
    }
  });
});
