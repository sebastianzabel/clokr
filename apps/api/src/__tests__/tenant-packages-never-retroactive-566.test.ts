/**
 * Phase 566 (#566), plan 09 — AC-566-03, D-05, D-06: cancelling every module and lowering the salon
 * quota is NEVER retroactive.
 *
 * One fully set-up tenant (three active salons, an API key, a terminal key, a presence source with an
 * assigned device, a Phorest coupling, a closed month with classified time entries, a DATEV Kanzlei)
 * is snapshotted, then the operator cancels every module and sets the quota to 1. Afterwards:
 *
 *   1. no row changed (salons stay active, keys / sources / devices / coupling untouched);
 *   2. every read, report and export answers exactly as before — the summary withholds only
 *      `activityMinutes` (D-05);
 *   3. every existing setup still works (terminal punch, presence ingest, API-key read, deactivating
 *      a salon, recording an activity kind);
 *   4. only NEW set-ups are refused: a further active salon or a re-activation beyond the limit
 *      (SALON_QUOTA_REACHED), a new API key / terminal / presence source / coupling
 *      (MODULE_NOT_BOOKED);
 *   5. booking again restores the room (the stored quota was kept as entered, D-02).
 *
 * The comparisons are deep equality on parsed bodies and full row snapshots, never status-only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  createTestSalon,
  cleanupTestData,
  configureDatevKanzlei,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import {
  SALON_QUOTA_REACHED_MESSAGE,
  moduleNotBookedMessage,
  TENANT_MODULES,
} from "../contexts/platform/tenant-packages";

const MONTH_FROM = "2026-06-01";
const MONTH_TO = "2026-06-30";
const ALL_MODULES = [...TENANT_MODULES];

type Seed = Awaited<ReturnType<typeof seedTestData>>;

let app: FastifyInstance;
let t: Seed;
let operatorId: string;
let operatorToken: string;
let addressCounter = 0;

/** The employee whose June 2026 is closed (hired 2026-06-01 so the month close has no predecessor). */
let closedEmployeeId: string;
let salonA: string; // default salon: uncoupled, stays active, receives the refused new coupling
let salonB: string; // coupled
let salonC: string; // deactivated and re-activated by the scenario

const NFC_CARD_ID = `NFC-566-NR-${randomBytes(6).toString("hex")}`;
const MAC_ASSIGNED = "AA:BB:CC:DD:EE:6A";
const BRANCH = `branch-566-nr-${randomBytes(4).toString("hex")}`;

let terminalKey: string;
let apiKeyRaw: string;
let sourceKey: string;
let sourceId: string;

/** A distinct client address per request, so no per-IP rate limit couples two calls. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.92.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function workdays(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function getJson(url: string, token = t.adminToken): Promise<unknown> {
  const res = await app.inject({
    method: "GET",
    url,
    headers: bearer(token),
    remoteAddress: uniqueAddress(),
  });
  expect(res.statusCode, `${url} -> ${res.body}`).toBe(200);
  return JSON.parse(res.body) as unknown;
}

async function getPdf(
  url: string,
): Promise<{ status: number; contentType: unknown; bytes: number }> {
  const res = await app.inject({
    method: "GET",
    url,
    headers: bearer(t.adminToken),
    remoteAddress: uniqueAddress(),
  });
  return {
    status: res.statusCode,
    contentType: res.headers["content-type"],
    bytes: res.rawPayload.length,
  };
}

/** Every read / report / export the scenario compares before and after. */
async function readSurfaces() {
  const datev = await app.inject({
    method: "GET",
    url: "/api/v1/reports/datev?year=2026&month=6",
    headers: bearer(t.adminToken),
    remoteAddress: uniqueAddress(),
  });
  expect(datev.statusCode, datev.body).toBe(200);
  return {
    timeEntries: await getJson(
      `/api/v1/time-entries?employeeId=${closedEmployeeId}&from=${MONTH_FROM}&to=${MONTH_TO}`,
    ),
    summary: (await getJson(
      `/api/v1/time-entries/summary?employeeId=${closedEmployeeId}&from=${MONTH_FROM}&to=${MONTH_TO}`,
    )) as Record<string, unknown>,
    monthlyReport: await getJson(
      `/api/v1/reports/monthly?employeeId=${closedEmployeeId}&year=2026&month=6`,
    ),
    // Only the movement data: the DATEV header carries a generation timestamp.
    datevMovements: iconv.decode(datev.rawPayload, "win1252").split("[Bewegungsdaten]")[1],
    salons: await getJson("/api/v1/salons"),
    terminals: await getJson("/api/v1/terminals"),
    apiKeys: await getJson("/api/v1/api-keys"),
    presenceSources: await getJson("/api/v1/admin/presence-sources"),
    couplings: await getJson("/api/v1/integrations/phorest/couplings"),
    pdfMonthly: await getPdf(
      `/api/v1/reports/monthly/pdf?employeeId=${closedEmployeeId}&year=2026&month=6`,
    ),
    pdfAll: await getPdf("/api/v1/reports/monthly/pdf/all?year=2026&month=6"),
  };
}

/** The full rows of every setup the package change must not touch (updatedAt included). */
async function readRows() {
  const tenantId = t.tenant.id;
  const plain = <T>(rows: T): unknown => JSON.parse(JSON.stringify(rows)) as unknown;
  return {
    salons: plain(await app.prisma.salon.findMany({ where: { tenantId }, orderBy: { id: "asc" } })),
    apiKeys: plain(
      await app.prisma.apiKey.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    ),
    terminalKeys: plain(
      await app.prisma.terminalApiKey.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    ),
    sources: plain(
      await app.prisma.presenceSource.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    ),
    devices: plain(
      await app.prisma.presenceDevice.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    ),
    couplings: plain(
      await app.prisma.salonCoupling.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
    ),
  };
}

function putPackages(body: unknown) {
  return app.inject({
    method: "PUT",
    url: `/api/v1/operator/tenants/${t.tenant.id}/packages`,
    headers: { ...bearer(operatorToken), "user-agent": "vitest-566-never-retroactive" },
    payload: body as object,
    remoteAddress: uniqueAddress(),
  });
}

function expectRefusal(
  res: { statusCode: number; body: string },
  code: "SALON_QUOTA_REACHED" | "MODULE_NOT_BOOKED",
  error: string,
) {
  expect(res.statusCode, res.body).toBe(409);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(["code", "error"]);
  expect(body.code).toBe(code);
  expect(body.error).toBe(error);
}

async function createClosedMonthEmployee(): Promise<string> {
  const prisma = app.prisma;
  const user = await prisma.user.create({
    data: {
      email: `nr566-${randomUUID().slice(0, 8)}@example.invalid`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId: t.tenant.id,
      userId: user.id,
      employeeNumber: `NR566-${randomUUID().slice(0, 6)}`,
      firstName: "Abschluss",
      lastName: "Monat",
      hireDate: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
  const days = workdays(MONTH_FROM, MONTH_TO);
  for (const [i, day] of days.entries()) {
    await prisma.timeEntry.create({
      data: {
        employeeId: emp.id,
        salonId: salonA,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T07:00:00Z`),
        endTime: new Date(`${day}T15:30:00Z`),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
        // A classified month: one PRODUCTIVE entry with a share, one SETUP_CLEANING entry.
        ...(i === 2
          ? {
              activityKind: "PRODUCTIVE" as const,
              activityShares: { create: [{ kind: "SETUP_CLEANING" as const, minutes: 60 }] },
            }
          : i === 3
            ? { activityKind: "SETUP_CLEANING" as const }
            : {}),
      },
    });
  }
  return emp.id;
}

beforeAll(async () => {
  app = await getTestApp();
  // The shared fixture books every module; the quota is set to 5 explicitly (the scenario builds
  // three active salons, so a Grundversion start would not be able to represent it).
  t = await seedTestData(app, "nr566");
  await app.prisma.tenant.update({
    where: { id: t.tenant.id },
    data: { bookedModules: ALL_MODULES, salonQuota: 5 },
  });
  await configureDatevKanzlei(app, t.tenant.id);
  const operator = await seedOperator(app);
  operatorId = operator.id;
  operatorToken = signOperatorToken(app, operator.id, "access", operator.tokenVersion);

  // Three active salons: the default one plus two more.
  salonA = t.salonId;
  salonB = (await createTestSalon(app.prisma, t.tenant.id, { name: "Salon B" })).id;
  salonC = (await createTestSalon(app.prisma, t.tenant.id, { name: "Salon C" })).id;

  // Closed month with classified entries.
  closedEmployeeId = await createClosedMonthEmployee();
  const close = await app.inject({
    method: "POST",
    url: "/api/v1/overtime/close-month",
    headers: bearer(t.adminToken),
    payload: { employeeId: closedEmployeeId, year: 2026, month: 6 },
  });
  expect(close.statusCode, close.body).toBe(201);

  // The employee of the existing-setup cases has an NFC card.
  await app.prisma.employee.update({
    where: { id: t.employee.id },
    data: { nfcCardId: NFC_CARD_ID },
  });

  // Every setup is created while the packages ARE booked.
  const term = await app.inject({
    method: "POST",
    url: "/api/v1/terminals",
    headers: bearer(t.adminToken),
    payload: { name: "Bestandsterminal" },
  });
  expect(term.statusCode, term.body).toBe(200);
  terminalKey = JSON.parse(term.body).rawKey;

  const key = await app.inject({
    method: "POST",
    url: "/api/v1/api-keys",
    headers: bearer(t.adminToken),
    payload: { name: "Bestandsschluessel", scopes: ["read:employees"] },
  });
  expect(key.statusCode, key.body).toBe(200);
  apiKeyRaw = JSON.parse(key.body).rawKey;

  const src = await app.inject({
    method: "POST",
    url: "/api/v1/admin/presence-sources",
    headers: bearer(t.adminToken),
    payload: { name: "Bestandsquelle" },
  });
  expect(src.statusCode, src.body).toBe(201);
  sourceId = JSON.parse(src.body).id;
  sourceKey = JSON.parse(src.body).rawKey;
  const assign = await app.inject({
    method: "POST",
    url: `/api/v1/admin/presence-sources/${sourceId}/devices/${MAC_ASSIGNED}/assign`,
    headers: bearer(t.adminToken),
    payload: { employeeId: t.employee.id },
  });
  expect(assign.statusCode, assign.body).toBe(200);

  const coupling = await app.inject({
    method: "POST",
    url: "/api/v1/integrations/phorest/couplings",
    headers: bearer(t.adminToken),
    payload: { salonId: salonB, externalBranchId: BRANCH },
  });
  expect(coupling.statusCode, coupling.body).toBe(201);
});

afterAll(async () => {
  try {
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employee: { tenantId: t.tenant.id } } },
    });
    await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId: t.tenant.id } } });
    await app.prisma.presenceDevice.deleteMany({ where: { tenantId: t.tenant.id } });
    await app.prisma.presenceSource.deleteMany({ where: { tenantId: t.tenant.id } });
    await app.prisma.apiKey.deleteMany({ where: { tenantId: t.tenant.id } });
    await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: t.tenant.id } });
    await cleanupTestData(app, t.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
  await closeTestApp();
});

describe("Phase 566 AC-3 — cancelling every module and lowering the quota deactivates and locks nothing", () => {
  let surfacesBefore: Awaited<ReturnType<typeof readSurfaces>>;
  let rowsBefore: Awaited<ReturnType<typeof readRows>>;

  it("the fixture is the full scenario (non-vacuity of everything compared below)", async () => {
    surfacesBefore = await readSurfaces();
    rowsBefore = await readRows();

    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id, isActive: true } })).toBe(
      3,
    );
    const stored = await app.prisma.tenant.findUniqueOrThrow({ where: { id: t.tenant.id } });
    expect(stored.bookedModules).toEqual(expect.arrayContaining(ALL_MODULES));
    expect(stored.salonQuota).toBe(5);
    expect((rowsBefore.apiKeys as unknown[]).length).toBe(1);
    expect((rowsBefore.terminalKeys as unknown[]).length).toBe(1);
    expect((rowsBefore.sources as unknown[]).length).toBe(1);
    expect((rowsBefore.devices as unknown[]).length).toBe(1);
    expect((rowsBefore.couplings as unknown[]).length).toBe(1);
    // The closed month carries real working time and classified minutes.
    expect(surfacesBefore.summary.workingMinutes).toBe(22 * 480);
    expect(surfacesBefore.summary.activityMinutes).toEqual({
      PRODUCTIVE: 420,
      SETUP_CLEANING: 540,
      UNSPECIFIED: 20 * 480,
    });
    expect(surfacesBefore.datevMovements.length).toBeGreaterThan(0);
    expect(surfacesBefore.pdfMonthly.bytes).toBeGreaterThan(0);
    expect(surfacesBefore.pdfAll.bytes).toBeGreaterThan(0);
    const closed = await app.prisma.saldoSnapshot.count({
      where: { employeeId: closedEmployeeId },
    });
    expect(closed).toBeGreaterThan(0);
  });

  it("(1, 2) the operator cancels every module and sets the quota to 1: no row changes and every read, report and export answers as before", async () => {
    const res = await putPackages({ bookedModules: [], salonQuota: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const dto = JSON.parse(res.body) as {
      packages: { bookedModules: string[]; salonQuota: number; activeSalonCount: number };
    };
    expect(dto.packages).toEqual({ bookedModules: [], salonQuota: 1, activeSalonCount: 3 });

    // 1. Rows: deep equality of the full snapshots, updatedAt included.
    expect(await readRows()).toEqual(rowsBefore);
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id, isActive: true } })).toBe(
      3,
    );

    // 2. Reads, reports, exports.
    const after = await readSurfaces();
    const { summary: summaryBefore, ...restBefore } = surfacesBefore;
    const { summary: summaryAfter, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(after.pdfMonthly.status).toBe(200);
    expect(after.pdfAll.status).toBe(200);

    // The summary withholds only activityMinutes (and says why).
    expect(summaryAfter.activityMinutes).toBeNull();
    expect(summaryAfter.activityMinutesUnavailableReason).toBe("MODULE_NOT_BOOKED");
    const {
      activityMinutes: _a,
      activityMinutesUnavailableReason: _r,
      ...summaryRest
    } = summaryAfter;
    const { activityMinutes: _b, ...summaryBeforeRest } = summaryBefore;
    expect(summaryRest).toEqual(summaryBeforeRest);

    // The tenant sees the operator's change in its own audit page.
    const audit = (await getJson("/api/v1/audit-logs?entity=TenantPackages")) as {
      logs: Array<{
        entity: string;
        action: string;
        entityId: string;
        newValue: { actor?: { type?: string; operatorId?: string } } | null;
      }>;
    };
    const row = audit.logs.find((l) => l.entityId === t.tenant.id);
    expect(row, "the package change is missing from the tenant audit page").toBeDefined();
    expect(row?.action).toBe("UPDATE");
    expect(row?.newValue?.actor).toMatchObject({ type: "OPERATOR", operatorId });
  });

  it("(3) every existing setup still works", async () => {
    // Terminal punch with the existing key.
    const punch = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: bearer(terminalKey),
      payload: { nfcCardId: NFC_CARD_ID },
      remoteAddress: uniqueAddress(),
    });
    expect(punch.statusCode, punch.body).toBe(200);
    expect(JSON.parse(punch.body).action).toBe("IN");

    // Presence ingest with the existing source key.
    const ingest = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: bearer(sourceKey),
      payload: {
        mac: MAC_ASSIGNED.toLowerCase(),
        eventType: "connected",
        timestamp: "2026-01-15T08:05:00.000Z",
        adapter: "fritzbox",
      },
      remoteAddress: uniqueAddress(),
    });
    expect(ingest.statusCode, ingest.body).toBe(200);
    expect(JSON.parse(ingest.body)).toEqual({ ok: true });

    // The existing API key reads the resource it is scoped for.
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: bearer(apiKeyRaw),
      remoteAddress: uniqueAddress(),
    });
    expect(read.statusCode, read.body).toBe(200);

    // Recording an activity kind and a share stays free (only the evaluation is a package).
    const day = "2026-09-10";
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: t.employee.id,
        salonId: salonA,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T08:00:00Z`),
        endTime: new Date(`${day}T16:30:00Z`),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
      },
    });
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: bearer(t.adminToken),
      payload: {
        activityKind: "PRODUCTIVE",
        activityShares: [{ kind: "SETUP_CLEANING", minutes: 30 }],
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    const stored = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { activityShares: { select: { kind: true, minutes: true } } },
    });
    expect(stored.activityKind).toBe("PRODUCTIVE");
    expect(stored.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 30 }]);

    // Deactivating a salon always works (3 -> 2 active salons, still over the limit of 1).
    const deactivate = await app.inject({
      method: "POST",
      url: `/api/v1/salons/${salonC}/deactivate`,
      headers: bearer(t.adminToken),
    });
    expect(deactivate.statusCode, deactivate.body).toBe(200);
    expect(JSON.parse(deactivate.body).isActive).toBe(false);

    // Using a key records `lastUsedAt` (and the source's `updatedAt`); nothing else about the
    // setups changed, and none of them is revoked or deleted.
    const rows = await readRows();
    const withoutUsage = (list: unknown) =>
      (list as Array<Record<string, unknown>>).map(
        ({ lastUsedAt: _used, updatedAt: _updated, ...rest }) => rest,
      );
    expect(withoutUsage(rows.apiKeys)).toEqual(withoutUsage(rowsBefore.apiKeys));
    expect(withoutUsage(rows.terminalKeys)).toEqual(withoutUsage(rowsBefore.terminalKeys));
    expect(withoutUsage(rows.sources)).toEqual(withoutUsage(rowsBefore.sources));
    expect(rows.devices).toEqual(rowsBefore.devices);
    expect(rows.couplings).toEqual(rowsBefore.couplings);
    for (const list of [rows.apiKeys, rows.terminalKeys, rows.sources] as Array<
      Array<{ revokedAt: unknown }>
    >) {
      expect(list.every((k) => k.revokedAt === null)).toBe(true);
    }
    const stillActive = await app.prisma.salon.findMany({
      where: { tenantId: t.tenant.id, isActive: true },
      select: { id: true },
    });
    expect(stillActive.map((s) => s.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [salonA, salonB].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("(4) only NEW set-ups are refused", async () => {
    const stateBefore = await readRows();
    const salonsBefore = await app.prisma.salon.count({ where: { tenantId: t.tenant.id } });
    const name = `Vierter Salon ${randomUUID().slice(0, 8)}`;

    // A further active salon: SALON_QUOTA_REACHED.
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: bearer(t.adminToken),
      payload: { name, openingHours: DEFAULT_SALON_OPENING_HOURS },
    });
    expectRefusal(create, "SALON_QUOTA_REACHED", SALON_QUOTA_REACHED_MESSAGE);
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id } })).toBe(salonsBefore);

    // Re-activating the just-deactivated salon (2 active, limit 1).
    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/salons/${salonC}/activate`,
      headers: bearer(t.adminToken),
    });
    expectRefusal(activate, "SALON_QUOTA_REACHED", SALON_QUOTA_REACHED_MESSAGE);
    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: salonC } })).isActive).toBe(
      false,
    );

    // New API key, terminal, presence source and coupling: MODULE_NOT_BOOKED.
    expectRefusal(
      await app.inject({
        method: "POST",
        url: "/api/v1/api-keys",
        headers: bearer(t.adminToken),
        payload: { name: "Neuer Schluessel", scopes: ["read:employees"] },
      }),
      "MODULE_NOT_BOOKED",
      moduleNotBookedMessage("INTEGRATIONS"),
    );
    expectRefusal(
      await app.inject({
        method: "POST",
        url: "/api/v1/terminals",
        headers: bearer(t.adminToken),
        payload: { name: "Neues Terminal" },
      }),
      "MODULE_NOT_BOOKED",
      moduleNotBookedMessage("HARDWARE_CLOCK"),
    );
    expectRefusal(
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/presence-sources",
        headers: bearer(t.adminToken),
        payload: { name: "Neue Quelle" },
      }),
      "MODULE_NOT_BOOKED",
      moduleNotBookedMessage("HARDWARE_CLOCK"),
    );
    expectRefusal(
      await app.inject({
        method: "POST",
        url: "/api/v1/integrations/phorest/couplings",
        headers: bearer(t.adminToken),
        payload: { salonId: salonA, externalBranchId: `${BRANCH}-neu` },
      }),
      "MODULE_NOT_BOOKED",
      moduleNotBookedMessage("INTEGRATIONS"),
    );

    // The refusals persisted nothing.
    expect(await readRows()).toEqual(stateBefore);
  });

  it("(5) booking again restores the room: the stored quota was kept as entered", async () => {
    const res = await putPackages({ bookedModules: ALL_MODULES, salonQuota: 5 });
    expect(res.statusCode, res.body).toBe(200);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/salons/${salonC}/activate`,
      headers: bearer(t.adminToken),
    });
    expect(activate.statusCode, activate.body).toBe(200);
    expect(JSON.parse(activate.body).isActive).toBe(true);
    expect(await app.prisma.salon.count({ where: { tenantId: t.tenant.id, isActive: true } })).toBe(
      3,
    );

    // And the evaluation is back in the summary.
    const summary = (await getJson(
      `/api/v1/time-entries/summary?employeeId=${closedEmployeeId}&from=${MONTH_FROM}&to=${MONTH_TO}`,
    )) as Record<string, unknown>;
    expect(summary.activityMinutes).toEqual(surfacesBefore.summary.activityMinutes);
    expect(Object.keys(summary)).not.toContain("activityMinutesUnavailableReason");
  });
});
