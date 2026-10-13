/**
 * Issue #543 — `createTestSalon` assigns a strictly increasing `createdAt`.
 *
 * Root cause: `Salon.createdAt` is generated from the Node clock at millisecond resolution, so
 * salons created back-to-back in a fixture often shared a timestamp and `findDefaultSalon()` fell
 * to its `id asc` tie-break over random UUIDs. The fix lives in the fixture helper only — the
 * production rule "oldest active salon, then id" is correct and unchanged; this file proves the
 * helper never lets that tie-break be reached, using the real `findDefaultSalon` / `listSalons`.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  nextSalonCreatedAtMs,
  waitForClockPast,
} from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, findDefaultSalon, listSalons } from "../contexts/platform";

describe("nextSalonCreatedAtMs (pure)", () => {
  it("returns the larger input plus one", () => {
    expect(nextSalonCreatedAtMs(0, 1000)).toBe(1001);
    expect(nextSalonCreatedAtMs(1005, 1000)).toBe(1006);
    expect(nextSalonCreatedAtMs(1000, 1000)).toBe(1001);
  });

  it("is strictly greater than both inputs", () => {
    for (const [last, now] of [
      [0, 0],
      [5, 9],
      [9, 5],
      [7, 7],
    ] as const) {
      const next = nextSalonCreatedAtMs(last, now);
      expect(next).toBeGreaterThan(last);
      expect(next).toBeGreaterThan(now);
    }
  });
});

describe("waitForClockPast (pure, injected clock)", () => {
  it("resolves true without sleeping when the clock is already past the target", async () => {
    let sleeps = 0;
    const ok = await waitForClockPast(1000, {
      now: () => 1001,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(true);
    expect(sleeps).toBe(0);
  });

  it("resolves true after exactly three sleeps for a clock advancing 1 ms per sleep", async () => {
    let clock = 998;
    let sleeps = 0;
    const ok = await waitForClockPast(1000, {
      now: () => clock,
      sleep: async () => {
        sleeps++;
        clock += 1;
      },
    });
    expect(ok).toBe(true);
    expect(sleeps).toBe(3);
  });

  it("gives up after exactly three sleeps on a frozen clock instead of hanging", async () => {
    let sleeps = 0;
    const ok = await waitForClockPast(1000, {
      now: () => 1000,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(false);
    expect(sleeps).toBe(3);
  });

  it("gives up with zero sleeps when the target lies more than 50 ms ahead of the clock", async () => {
    let sleeps = 0;
    const ok = await waitForClockPast(1_000_000, {
      now: () => 1_000_000 - 51,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(ok).toBe(false);
    expect(sleeps).toBe(0);
  });
});

describe("createTestSalon createdAt ordering (Issue #543)", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  async function rawSalon(tenantId: string, name: string) {
    return app.prisma.salon.create({
      data: {
        tenantId,
        name,
        federalState: "NIEDERSACHSEN",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const id of tenantIds) await cleanupTestData(app, id);
  });

  it("25 back-to-back salons get strictly increasing createdAt and the seed salon stays the default", async () => {
    const seed = await seedTestData(app, "cts-543-seq");
    tenantIds.push(seed.tenant.id);

    const created = [];
    for (let i = 0; i < 25; i++) {
      created.push(await createTestSalon(app.prisma, seed.tenant.id, { name: `S${i}` }));
    }
    // Anti-vacuity: the loop above must really have produced the salons asserted on below.
    expect(created).toHaveLength(25);

    const seedSalon = await app.prisma.salon.findUniqueOrThrow({ where: { id: seed.salonId } });
    expect(seedSalon.createdAt.getTime()).toBeLessThan(created[0].createdAt.getTime());
    for (let i = 1; i < created.length; i++) {
      expect(created[i].createdAt.getTime()).toBeGreaterThan(created[i - 1].createdAt.getTime());
    }

    const def = await findDefaultSalon(app.prisma, seed.tenant.id);
    expect(def?.id).toBe(seed.salonId);

    const listed = await listSalons(app.prisma, seed.tenant.id, { includeInactive: false });
    expect(listed.map((s) => s.id)).toEqual([seed.salonId, ...created.map((s) => s.id)]);
  });

  it("a fresh salon has createdAt equal to updatedAt", async () => {
    const seed = await seedTestData(app, "cts-543-upd");
    tenantIds.push(seed.tenant.id);
    const salon = await createTestSalon(app.prisma, seed.tenant.id);
    expect(salon.updatedAt.getTime()).toBe(salon.createdAt.getTime());
  });

  it("concurrent calls never share a createdAt and the oldest one is the default", async () => {
    const seed = await seedTestData(app, "cts-543-par", { withDefaultSalon: false });
    tenantIds.push(seed.tenant.id);

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createTestSalon(app.prisma, seed.tenant.id, { name: `P${i}` }),
      ),
    );
    expect(created).toHaveLength(10);
    expect(new Set(created.map((s) => s.createdAt.getTime())).size).toBe(10);

    const oldest = created.reduce((a, b) =>
      a.createdAt.getTime() < b.createdAt.getTime() ? a : b,
    );
    const def = await findDefaultSalon(app.prisma, seed.tenant.id);
    expect(def?.id).toBe(oldest.id);
  });

  it("orders strictly against raw Node-clock creates in both directions", async () => {
    const seed = await seedTestData(app, "cts-543-mix", { withDefaultSalon: false });
    tenantIds.push(seed.tenant.id);

    let pairs = 0;
    for (let i = 0; i < 20; i++) {
      // raw first, helper right after: the helper salon is strictly younger
      const raw1 = await rawSalon(seed.tenant.id, `raw-a-${i}`);
      const helper1 = await createTestSalon(app.prisma, seed.tenant.id, { name: `help-a-${i}` });
      expect(helper1.createdAt.getTime()).toBeGreaterThan(raw1.createdAt.getTime());

      // helper first, raw right after: the raw salon is strictly younger
      const helper2 = await createTestSalon(app.prisma, seed.tenant.id, { name: `help-b-${i}` });
      const raw2 = await rawSalon(seed.tenant.id, `raw-b-${i}`);
      expect(raw2.createdAt.getTime()).toBeGreaterThan(helper2.createdAt.getTime());
      pairs++;
    }
    expect(pairs).toBe(20);
  });

  it("stores an explicit createdAt verbatim and keeps the automatic sequence intact", async () => {
    const seed = await seedTestData(app, "cts-543-ovr", { withDefaultSalon: false });
    tenantIds.push(seed.tenant.id);

    const before = await createTestSalon(app.prisma, seed.tenant.id, { name: "before" });
    const explicit = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "explicit",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const after = await createTestSalon(app.prisma, seed.tenant.id, { name: "after" });

    expect(explicit.createdAt.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(after.createdAt.getTime()).toBeGreaterThan(before.createdAt.getTime());
  });

  it("does not hang under a frozen Date and still orders helper salons strictly", async () => {
    const seed = await seedTestData(app, "cts-543-frz", { withDefaultSalon: false });
    tenantIds.push(seed.tenant.id);

    // Frozen far in the past relative to the real-time salons above (real timers stay available).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-01T12:00:00.000Z") });
    const startedAt = performance.now();
    const first = await createTestSalon(app.prisma, seed.tenant.id, { name: "frozen-1" });
    const second = await createTestSalon(app.prisma, seed.tenant.id, { name: "frozen-2" });
    const elapsedMs = performance.now() - startedAt;
    vi.useRealTimers();

    expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
    expect(elapsedMs).toBeLessThan(2000);
  });
});
