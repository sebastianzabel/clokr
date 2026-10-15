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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

describe("Phase 88 — school holidays sync", () => {
  it("runSchoolHolidaysSync asks only for active tenants", async () => {
    expectEveryCallFiltered(await tenantWheresOf(() => app.runSchoolHolidaysSync!()));
  });
});

describe("Phase 88 — data retention keeps running for deactivated tenants (D-05a, legal duty)", () => {
  it("runRetention queries every tenant and looks at the deactivated tenant's employees", async () => {
    await app.prisma.tenant.update({
      where: { id: tenantId },
      data: { deactivatedAt: new Date() },
    });
    app.invalidateTenantState(tenantId);
    const tenantSpy = vi.spyOn(app.prisma.tenant, "findMany");
    const employeeSpy = vi.spyOn(app.prisma.employee, "findMany");
    try {
      await app.runRetention!();
      expect(tenantSpy).toHaveBeenCalled();
      for (const call of tenantSpy.mock.calls) {
        expect(
          JSON.stringify((call[0] as { where?: unknown } | undefined)?.where ?? {}),
        ).not.toContain("deactivatedAt");
      }
      // Positive control: the loop really reached the deactivated tenant.
      const reached = employeeSpy.mock.calls.some(
        (call) =>
          (call[0] as { where?: { tenantId?: string } } | undefined)?.where?.tenantId === tenantId,
      );
      expect(reached).toBe(true);
    } finally {
      await app.prisma.tenant.update({ where: { id: tenantId }, data: { deactivatedAt: null } });
      app.invalidateTenantState(tenantId);
    }
  });
});

describe("Phase 88 — the daily purge enforces the operator audit retention (D-07a)", () => {
  function monthsAgo(months: number): Date {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
  }
  async function insertRow(action: string, createdAt: Date): Promise<string> {
    const row = await app.prisma.operatorAuditLog.create({
      data: { action, entity: "OperatorAccount", createdAt },
      select: { id: true },
    });
    return row.id;
  }
  const exists = async (id: string) =>
    (await app.prisma.operatorAuditLog.findUnique({ where: { id } })) !== null;

  it("deletes an expired authentication event and keeps a young one and an old lifecycle action", async () => {
    const expiredAuth = await insertRow("OPERATOR_LOGIN_FAILED", monthsAgo(13));
    const oldLifecycle = await insertRow("TENANT_CREATED", monthsAgo(13));
    const youngAuth = await insertRow("OPERATOR_LOGIN", monthsAgo(1));

    await app.runPurgeableAuditLogs!();

    expect(await exists(expiredAuth)).toBe(false);
    expect(await exists(oldLifecycle)).toBe(true);
    expect(await exists(youngAuth)).toBe(true);
  });
});

describe("Phase 88 — source scan: every tenant loop is filtered or on the named allowlist", () => {
  const SRC_ROOT = resolve(__dirname, "..");
  /**
   * The only tenant-list reads allowed to see deactivated tenants, each with the reason. `count` is
   * the exact number of calls in the file, so a second unfiltered call in an allowlisted file is
   * still a finding.
   */
  const ALLOWLIST: Record<string, { count: number; reason: string }> = {
    "composition/data-retention.ts": {
      count: 2,
      reason:
        "the lawful deletion duty does not pause with a contract (DSGVO Art. 17, § 147 AO); the second call only computes the global audit purge window",
    },
    "contexts/platform/api/operator/tenants.ts": {
      count: 1,
      reason: "the operator tenant list must show deactivated tenants",
    },
    "contexts/platform/api/operator/dashboard.ts": {
      count: 1,
      reason:
        "the operator dashboard lists deactivated tenants next to the active ones (Issue #90); its totals exclude them in the body builder",
    },
    "contexts/platform/facade/operator-metrics.ts": {
      count: 1,
      reason:
        "the metrics facade keys one row per tenant including deactivated ones, so the dashboard can show them (Issue #90)",
    },
  };
  /** Floor of filtered calls at the time of writing: 10 attendance loops + 6 other jobs. */
  const FILTERED_FLOOR = 16;
  const CALL = /\.(tenant|tenantConfig)\.findMany\(/g;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        out.push(...walk(full));
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  /** The argument text of the call that opens at `open` (the index of its `(`), paren-balanced. */
  function argumentText(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
  }

  const files = walk(SRC_ROOT).map((full) => ({
    rel: relative(SRC_ROOT, full).split("\\").join("/"),
    text: readFileSync(full, "utf8"),
  }));
  const calls = files.flatMap(({ rel, text }) =>
    [...text.matchAll(CALL)].map((m) => ({
      rel,
      filtered: argumentText(text, (m.index ?? 0) + m[0].length - 1).includes(
        "ACTIVE_TENANT_WHERE",
      ),
    })),
  );

  it("is not vacuous: finds the filtered calls and every allowlisted file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.filtered).length).toBeGreaterThanOrEqual(FILTERED_FLOOR);
    for (const [rel, { count }] of Object.entries(ALLOWLIST)) {
      expect(calls.filter((c) => c.rel === rel).length, rel).toBe(count);
    }
  });

  it("has no unfiltered tenant loop outside the allowlist", () => {
    const offenders = calls.filter((c) => !c.filtered && !(c.rel in ALLOWLIST)).map((c) => c.rel);
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlisted data-retention calls free of an active-tenant filter", () => {
    const retention = calls.filter((c) => c.rel === "composition/data-retention.ts");
    expect(retention.every((c) => !c.filtered)).toBe(true);
  });
});
