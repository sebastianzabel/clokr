/**
 * Issue #85 (Phase 85b-09, D-10, AC-7) — ONE cross-salon Springer, every read path, three managers.
 *
 * The issue states three things and this file proves each of them on every read path a manager can
 * reach, for the same two Springers:
 *   (a) the Stammsalon manager of B sees ALL entries of the Springer and their sums,
 *   (b) the Einsatzsalon manager of A sees ONLY the A entries and A-only sums, and nothing from
 *       which the B part could be computed (no sum of both, no saldo, no difference),
 *   (c) a manager of neither salon sees nothing of the person.
 * The check hangs on the ENTRY (Phase 91b per-entry rule, widened by 85b), never on the person.
 *
 * Fixture (June 2026, fake clock Wed 2026-06-17T10:00Z, Date only, installed before the app boots;
 * all entries closed, breakMinutes 0, so working minutes = presence minutes):
 *   Salons A, B, C. Springer X is homed in B, has no deployment, and worked Mon 15.06 in A
 *   (08:00-10:17 = 137 min), Tue 16.06 in B (08:00-12:11 = 251 min) and today Wed 17.06 in A
 *   (06:00-07:00 = 60 min). Springer Y is homed in B with a DEPLOYMENT in A valid today and worked
 *   Mon 15.06 in A (08:00-10:29 = 149 min) and Tue 16.06 in B (08:00-12:23 = 263 min).
 *   MB = Salonmanager SALONS [B] = (a), MA = Salonmanager SALONS [A] = (b), MC = Salonmanager
 *   SALONS [C] = (c); plus the tenant admin, an Inhaber, a Personalabteilung and X themself.
 * No person names, no uuid literals.
 *
 * Why the minute values are distinctive: the B part of the Springers (251, 263) and every figure
 * that adds it (X 137+251 = 388, Y 149+263 = 412, together 800, with today's 60 min 448) has to
 * be recognisable inside any response. The final test walks EVERY numeric leaf of EVERY response
 * collected for (b) and finds none of them, in minutes nor in hours (4.18, 4.38, 6.47, 6.87, ...),
 * so the total cannot be derived as a difference either. It also scans the raw bodies for the ids
 * and the end clock times of the two B entries.
 *
 * Mutation proofs on `scopedTimeEntryIds` in `contexts/platform/scope-filter.ts`, recorded here
 * (not re-run by CI; each change restored from a `cp` backup, `cmp` and `git diff --quiet` clean):
 * M1 "person-level, too much" - the entry-salon branch matches EVERY entry of an employee who has
 *    ANY entry in a reach salon: 6 red - "(b) ... sees only the two A entries of X, never the B
 *    entry", "(b) the same holds for Y: only the A entry, with the A minutes", "(b) ... gets the
 *    A-only sum of X: 137", "(b) the X row carries only the A hours: ...", "(b) ... gets the
 *    in-scope sum 137 + 149 = 286, ..." and the numeric leak scan "(b) never receives a B-derived
 *    number, a B entry id or a B end time".
 * M2 "person-level, too little" - the entry-salon branch is dropped (Stammsalon and persons only):
 *    7 red - the same five (b) cases as M1 minus the scan, plus "(b) salonId A lists the A entries
 *    of X and Y, never a B entry" and "(b) X is listed present by the A entry of today, without an
 *    employee number" (the A part is lost on every path: too little).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

// The day-check leg needs a day with two entries, which the partial unique index forbids for real
// rows (#70 open). The range read of closed WORK entries is wrapped: it delegates to the original
// UNLESS the flag below holds rows, and only the day-check describe ever fills the flag, so no
// other leg (holiday reads, account Ist) sees a synthetic row.
const synthetic = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../contexts/time-tracking/facade/time-entries", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../contexts/time-tracking/facade/time-entries")>();
  return {
    ...original,
    getWorkedEntriesInRange: (async (
      ...args: Parameters<typeof original.getWorkedEntriesInRange>
    ) => {
      const real = await original.getWorkedEntriesInRange(...args);
      const [, scope, from, to] = args;
      if (synthetic.rows.length === 0 || scope.kind !== "employee") return real;
      const extra = synthetic.rows.filter(
        (r) =>
          r.employeeId === scope.employeeId && (r.date as Date) >= from && (r.date as Date) <= to,
      );
      return [...real, ...extra] as typeof real;
    }) as typeof original.getWorkedEntriesInRange,
  };
});

const PASSWORD = "test1234";
const FAKE_NOW = "2026-06-17T10:00:00.000Z";
const DAY_CHECK_DAY = "2025-11-12";

// Every B-derived figure the fixture creates, in minutes and in hours (two and one decimal).
const B_DERIVED_NUMBERS = [
  251, 263, 388, 412, 448, 800, 4.18, 4.38, 6.47, 6.87, 7.47, 13.33, 4.2, 4.4, 6.5, 6.9, 7.5,
];

interface PersonRow {
  id: string;
  salonId: string;
  date: string;
  employeeId: string;
  workingMinutes: number | null;
  presenceMinutes: number | null;
}
interface WeekDay {
  date: string;
  status: string;
  workedHours: number;
  workedElsewhere?: boolean;
  isWorkday: boolean;
  expectedHours: number;
  reason: string | null;
  leaveTypeCode: string | null;
  absenceType: string | null;
  shift: unknown;
}
interface WeekRow {
  id: string;
  name: string;
  employeeNumber: string | null;
  days: WeekDay[];
}
interface Trend {
  workedBasis: string;
  sollUnavailableReason: string | null;
  months: Array<{ month: string; workedMinutes: number; shouldMinutes: number | null }>;
}
interface Attendance {
  employees: Array<{ id: string; status: string; employeeNumber: string | null }>;
}
interface DayCheck {
  date: string;
  detail: "full" | "redacted";
  netWorkedMinutes: number | null;
  warnings: Array<{ code: string; hint?: true }>;
  entries: Array<{ id: string; salonId: string }> | null;
}
interface EmployeeListRow {
  id: string;
  overtimeAccount: { balanceHours: unknown } | null;
}

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Every number anywhere in a JSON value, with its path. */
function numericLeaves(value: unknown, path = "$"): Array<{ path: string; value: number }> {
  if (typeof value === "number") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericLeaves(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numericLeaves(v, `${path}.${k}`));
  }
  return [];
}

describe("Issue #85 D-10 — one cross-salon Springer, every read path, three managers", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let salonC: string;
  let empX = "";
  let empY = "";
  let empN = "";
  let tokenMA = "";
  let tokenMB = "";
  let tokenMC = "";
  let tokenOwner = "";
  let tokenHr = "";
  let tokenX = "";
  const entryIds: Record<"X_A1" | "X_B" | "X_A2" | "Y_A" | "Y_B", string> = {
    X_A1: "",
    X_B: "",
    X_A2: "",
    Y_A: "",
    Y_B: "",
  };
  // Every parsed body answered to the Einsatzsalon manager (b), for the numeric leak scan.
  const bResponses: unknown[] = [];

  async function createPerson(label: string, opts: { schedule?: boolean } = {}) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: `${label}-Xs85`,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    if (opts.schedule) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
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
          validFrom: new Date("2024-01-01T00:00:00Z"),
        },
      });
    }
    return { user, employee };
  }

  function assignment(
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    from: string,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${from}T00:00:00Z`),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function entry(
    employeeId: string,
    salonId: string,
    date: string,
    start: string,
    end: string,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function manager(label: string, salonId: string): Promise<string> {
    const m = await createPerson(label);
    await assignment(m.employee.id, salonId, "HOME", "2024-01-01");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonId],
        employeeIds: [],
      },
    });
    return login(m.user.email);
  }

  async function tenantWide(label: string, accessRoleId: string): Promise<string> {
    const m = await createPerson(label);
    await assignment(m.employee.id, salonA, "HOME", "2024-01-01");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    return login(m.user.email);
  }

  /** One GET; a body answered to (b) is collected for the numeric leak scan. */
  async function get(token: string, url: string) {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    if (token === tokenMA) {
      try {
        bResponses.push(JSON.parse(res.body));
      } catch {
        bResponses.push(res.body);
      }
    }
    return res;
  }
  async function json<T>(token: string, url: string, status = 200): Promise<T> {
    const res = await get(token, url);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(status);
    return JSON.parse(res.body) as T;
  }

  const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
  const sortedIds = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "xs85t");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Xs85 B" })).id;
    salonC = (await createTestSalon(app.prisma, data.tenant.id, { name: "Xs85 C" })).id;

    const x = await createPerson("SpringerX", { schedule: true });
    empX = x.employee.id;
    await assignment(empX, salonB, "HOME", "2024-01-01");
    entryIds.X_A1 = (await entry(empX, salonA, "2026-06-15", "08:00", "10:17")).id;
    entryIds.X_B = (await entry(empX, salonB, "2026-06-16", "08:00", "12:11")).id;
    entryIds.X_A2 = (await entry(empX, salonA, "2026-06-17", "06:00", "07:00")).id;
    tokenX = await login(x.user.email);

    const y = await createPerson("SpringerY", { schedule: true });
    empY = y.employee.id;
    await assignment(empY, salonB, "HOME", "2024-01-01");
    await assignment(empY, salonA, "DEPLOYMENT", "2026-06-01");
    entryIds.Y_A = (await entry(empY, salonA, "2026-06-15", "08:00", "10:29")).id;
    entryIds.Y_B = (await entry(empY, salonB, "2026-06-16", "08:00", "12:23")).id;

    // N: a person of B with no entry at all - the control for "nothing of X" answers.
    const n = await createPerson("NoEntries");
    empN = n.employee.id;
    await assignment(empN, salonB, "HOME", "2024-01-01");

    // Stored balances, so that "no balance" is not vacuous.
    await app.prisma.overtimeAccount.create({ data: { employeeId: empX, balanceHours: 5 } });
    await app.prisma.overtimeAccount.create({ data: { employeeId: empY, balanceHours: 5 } });

    tokenMA = await manager("MgrA", salonA);
    tokenMB = await manager("MgrB", salonB);
    tokenMC = await manager("MgrC", salonC);
    tokenOwner = await tenantWide("Owner", SYSTEM_ROLE_IDS.OWNER);
    tokenHr = await tenantWide("Hr", SYSTEM_ROLE_IDS.HR);

    // The day-check leg: a real A entry of X on a day in the past; the B row is the synthetic one.
    await entry(empX, salonA, DAY_CHECK_DAY, "08:00", "12:00");
  });

  afterAll(async () => {
    vi.useRealTimers();
    synthetic.rows.length = 0;
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("cross-salon-springer-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── the person list: GET /time-entries?employeeId= ─────────────────────────────────────────

  describe("person list GET /time-entries?employeeId=", () => {
    const query = (id: string) =>
      `/api/v1/time-entries?employeeId=${id}&from=2026-06-01&to=2026-06-30`;

    it("(a) the Stammsalon manager of B sees every entry of X, the A entries included", async () => {
      const rows = await json<PersonRow[]>(tokenMB, query(empX));
      expect(idsOf(rows)).toEqual(sortedIds(entryIds.X_A1, entryIds.X_B, entryIds.X_A2));
    });

    it("(b) the Einsatzsalon manager of A sees only the two A entries of X, never the B entry", async () => {
      const rows = await json<PersonRow[]>(tokenMA, query(empX));
      expect(idsOf(rows)).toEqual(sortedIds(entryIds.X_A1, entryIds.X_A2));
      for (const row of rows) expect(row.salonId).toBe(salonA);
      expect(rows.map((r) => r.workingMinutes).sort((p, q) => (p ?? 0) - (q ?? 0))).toEqual([
        60, 137,
      ]);
    });

    it("(b) the same holds for Y: only the A entry, with the A minutes", async () => {
      const rows = await json<PersonRow[]>(tokenMA, query(empY));
      expect(idsOf(rows)).toEqual([entryIds.Y_A]);
      expect(rows[0].workingMinutes).toBe(149);
    });

    it("(c) a manager of neither salon gets nothing of X", async () => {
      const rows = await json<PersonRow[]>(tokenMC, query(empX));
      expect(rows).toEqual([]);
    });
  });

  // ── the summary: GET /time-entries/summary ─────────────────────────────────────────────────

  describe("summary GET /time-entries/summary", () => {
    const query = (id: string) =>
      `/api/v1/time-entries/summary?employeeId=${id}&from=2026-06-01&to=2026-06-16`;
    type Summary = { employeeId?: string; workingMinutes: number; presenceMinutes: number };

    it("(a) the Stammsalon manager of B gets the full sum of X: 137 + 251 = 388", async () => {
      expect((await json<Summary>(tokenMB, query(empX))).workingMinutes).toBe(388);
    });

    it("(b) the Einsatzsalon manager of A gets the A-only sum of X: 137", async () => {
      const body = await json<Summary>(tokenMA, query(empX));
      expect(body.workingMinutes).toBe(137);
      expect(body.presenceMinutes).toBe(137);
    });

    it("(c) a manager of neither salon gets no minute of X, the answer of a person without entries", async () => {
      const forX = await get(tokenMC, query(empX));
      const forN = await get(tokenMC, query(empN));
      expect(forX.statusCode).toBe(forN.statusCode);
      const strip = (body: string) => ({ ...JSON.parse(body), employeeId: "<id>" });
      expect(strip(forX.body)).toEqual(strip(forN.body));
      expect((JSON.parse(forX.body) as Summary).workingMinutes).toBe(0);
    });
  });

  // ── the salon view: GET /time-entries?salonId= ─────────────────────────────────────────────

  describe("salon view GET /time-entries?salonId=", () => {
    const query = (salonId: string) =>
      `/api/v1/time-entries?salonId=${salonId}&from=2026-06-01&to=2026-06-30`;

    it("(b) salonId A lists the A entries of X and Y, never a B entry", async () => {
      const rows = await json<PersonRow[]>(tokenMA, query(salonA));
      expect(idsOf(rows)).toEqual(sortedIds(entryIds.X_A1, entryIds.X_A2, entryIds.Y_A));
      for (const row of rows) expect(row.salonId).toBe(salonA);
    });

    it("(a) salonId B lists the B entries of X and Y", async () => {
      const rows = await json<PersonRow[]>(tokenMB, query(salonB));
      expect(idsOf(rows)).toEqual(sortedIds(entryIds.X_B, entryIds.Y_B));
    });

    it("(a) salonId A and (c) salonId A answer the identical 404 of a random salon id", async () => {
      const random = await get(tokenMB, query(randomUUID()));
      expect(random.statusCode).toBe(404);
      for (const token of [tokenMB, tokenMC]) {
        const res = await get(token, query(salonA));
        expect(res.statusCode).toBe(random.statusCode);
        expect(res.body).toBe(random.body);
      }
    });

    it("(c) salonId C lists nothing of X or Y", async () => {
      const rows = await json<PersonRow[]>(tokenMC, query(salonC));
      expect(rows).toEqual([]);
    });
  });

  // ── the employee list: GET /employees (#547) ───────────────────────────────────────────────

  describe("employee list GET /employees (547-AC4)", () => {
    it("(a) the Stammsalon manager of B lists X and Y", async () => {
      const ids = idsOf(await json<EmployeeListRow[]>(tokenMB, "/api/v1/employees"));
      expect(ids).toContain(empX);
      expect(ids).toContain(empY);
    });

    it("(b) the Einsatzsalon manager of A lists Y (active A deployment), not X", async () => {
      const rows = await json<EmployeeListRow[]>(tokenMA, "/api/v1/employees");
      const ids = idsOf(rows);
      expect(ids).toContain(empY);
      expect(ids).not.toContain(empX);
      expect(ids).not.toContain(empN);
    });

    it("(c) the manager of C lists neither X nor Y", async () => {
      const ids = idsOf(await json<EmployeeListRow[]>(tokenMC, "/api/v1/employees"));
      expect(ids).not.toContain(empX);
      expect(ids).not.toContain(empY);
    });

    it("no Salonmanager receives a balance: every balanceHours is null (stored balances are 5)", async () => {
      for (const token of [tokenMA, tokenMB, tokenMC]) {
        const rows = await json<EmployeeListRow[]>(token, "/api/v1/employees");
        for (const row of rows) {
          if (row.overtimeAccount !== null) expect(row.overtimeAccount.balanceHours).toBeNull();
        }
      }
      const control = await json<EmployeeListRow[]>(data.adminToken, "/api/v1/employees");
      const x = control.find((r) => r.id === empX);
      expect(Number(x?.overtimeAccount?.balanceHours)).toBe(5);
    });
  });

  // ── by id: PUT /time-entries/:id (there is no GET /time-entries/:id) ───────────────────────

  describe("by-id request of the B entry (85-AC6)", () => {
    it("(b) and (c) answer the identical 404 of a random uuid, status and body", async () => {
      const put = (token: string, id: string) =>
        app.inject({
          method: "PUT",
          url: `/api/v1/time-entries/${id}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { breakMinutes: 30 },
        });
      for (const token of [tokenMA, tokenMC]) {
        const random = await put(token, randomUUID());
        const res = await put(token, entryIds.X_B);
        if (token === tokenMA) bResponses.push(JSON.parse(res.body));
        expect(res.statusCode).toBe(404);
        expect(res.statusCode).toBe(random.statusCode);
        expect(res.body).toBe(random.body);
      }
      const stored = await app.prisma.timeEntry.findUnique({ where: { id: entryIds.X_B } });
      expect(stored?.breakMinutes).toBe(0);
    });
  });

  // ── the total saldo: GET /overtime/:employeeId (85-AC4) ────────────────────────────────────

  describe("total saldo GET /overtime/:employeeId (85-AC4)", () => {
    it("is refused for both Salonmanagers (no overtime:read)", async () => {
      for (const token of [tokenMA, tokenMB]) {
        expect((await get(token, `/api/v1/overtime/${empX}`)).statusCode).toBe(403);
      }
    });

    it("is answered for Inhaber, Personalabteilung and the Springer themself", async () => {
      for (const token of [tokenOwner, tokenHr, tokenX]) {
        expect((await get(token, `/api/v1/overtime/${empX}`)).statusCode).toBe(200);
      }
    });
  });

  // ── the dashboard: team-week, team-trend, today-attendance ─────────────────────────────────

  describe("team-week GET /dashboard/team-week", () => {
    const url = "/api/v1/dashboard/team-week?date=2026-06-17";
    type Week = { team: WeekRow[] };
    const day = (row: WeekRow | undefined, date: string) => row?.days.find((d) => d.date === date);

    it("(a) the X row carries every hour: Mon 2.28, Tue 4.18, Wed 1", async () => {
      const x = (await json<Week>(tokenMB, url)).team.find((r) => r.id === empX);
      expect(day(x, "2026-06-15")?.workedHours).toBe(2.28);
      expect(day(x, "2026-06-16")?.workedHours).toBe(4.18);
      expect(day(x, "2026-06-17")?.workedHours).toBe(1);
    });

    it("(b) the X row carries only the A hours: Mon 2.28, Tue 0, Wed 1, no worked-elsewhere mark, no planning data", async () => {
      const team = (await json<Week>(tokenMA, url)).team;
      const x = team.find((r) => r.id === empX);
      expect(x).toBeDefined();
      expect(day(x, "2026-06-15")?.workedHours).toBe(2.28);
      expect(day(x, "2026-06-16")?.workedHours).toBe(0);
      expect(day(x, "2026-06-17")?.workedHours).toBe(1);
      expect(day(x, "2026-06-16")?.status).toBe("none");
      for (const d of x?.days ?? []) {
        expect(d.workedElsewhere, d.date).not.toBe(true);
        expect(d.isWorkday, d.date).toBe(false);
        expect(d.expectedHours, d.date).toBe(0);
        expect(d.leaveTypeCode, d.date).toBeNull();
        expect(d.absenceType, d.date).toBeNull();
        expect(d.shift, d.date).toBeNull();
      }
      const y = team.find((r) => r.id === empY);
      expect(day(y, "2026-06-15")?.workedHours).toBe(2.48);
      expect(day(y, "2026-06-16")?.workedHours).toBe(0);
    });

    it("(c) the manager of C has no X row and no Y row", async () => {
      const team = (await json<Week>(tokenMC, url)).team;
      expect(team.some((r) => r.id === empX || r.id === empY)).toBe(false);
    });
  });

  describe("team-trend GET /dashboard/team-trend", () => {
    const url = "/api/v1/dashboard/team-trend";
    const june = (t: Trend) => t.months.find((m) => m.month === "2026-06");

    it("(a) the Stammsalon manager of B gets the account Ist of X and Y through yesterday: 388 + 412 = 800", async () => {
      expect(june(await json<Trend>(tokenMB, url))?.workedMinutes).toBe(800);
    });

    it("(b) the Einsatzsalon manager of A gets the in-scope sum 137 + 149 = 286, basis SCOPE_ENTRIES, no Soll", async () => {
      const body = await json<Trend>(tokenMA, url);
      expect(body.workedBasis).toBe("SCOPE_ENTRIES");
      expect(june(body)?.workedMinutes).toBe(286);
      for (const m of body.months) expect(m.shouldMinutes, m.month).toBeNull();
    });

    it("(c) the manager of C gets 0 from X and Y", async () => {
      const body = await json<Trend>(tokenMC, url);
      expect(june(body)?.workedMinutes).toBe(0);
    });
  });

  describe("today-attendance GET /dashboard/today-attendance", () => {
    const url = "/api/v1/dashboard/today-attendance";
    const rowOf = (body: Attendance, id: string) => body.employees.find((r) => r.id === id);

    it("(a) X is listed present, with the employee number", async () => {
      const x = rowOf(await json<Attendance>(tokenMB, url), empX);
      expect(x?.status).toBe("present");
      expect(x?.employeeNumber).not.toBeNull();
    });

    it("(b) X is listed present by the A entry of today, without an employee number", async () => {
      const x = rowOf(await json<Attendance>(tokenMA, url), empX);
      expect(x?.status).toBe("present");
      expect(x?.employeeNumber).toBeNull();
    });

    it("(c) X is not listed", async () => {
      expect(rowOf(await json<Attendance>(tokenMC, url), empX)).toBeUndefined();
    });
  });

  // ── the day checks: GET /day-breaks/checks ─────────────────────────────────────────────────

  describe("day-break checks GET /day-breaks/checks (constructed A+B day)", () => {
    const url = `/api/v1/day-breaks/checks?employeeId=${"%ID%"}&from=2025-11-01&to=2025-11-30`;

    async function checks(token: string): Promise<DayCheck[]> {
      synthetic.rows.push({
        id: randomUUID(),
        employeeId: empX,
        date: new Date(`${DAY_CHECK_DAY}T00:00:00.000Z`),
        startTime: new Date(`${DAY_CHECK_DAY}T12:30:00.000Z`),
        endTime: new Date(`${DAY_CHECK_DAY}T16:30:00.000Z`),
        breakMinutes: 0,
        breakStatus: "CONFIRMED",
        isLocked: false,
        salonId: salonB,
      });
      try {
        return (await json<{ days: DayCheck[] }>(token, url.replace("%ID%", empX))).days;
      } finally {
        synthetic.rows.length = 0;
      }
    }

    it("(a) the Stammsalon manager of B sees the day in full detail with both rows", async () => {
      const days = await checks(tokenMB);
      expect(days).toHaveLength(1);
      expect(days[0].detail).toBe("full");
      expect(days[0].netWorkedMinutes).toBe(480);
      expect(days[0].entries?.map((e) => e.salonId).sort()).toEqual([salonA, salonB].sort());
    });

    it("(b) the Einsatzsalon manager of A sees the day redacted: the neutral hint and no number", async () => {
      const days = await checks(tokenMA);
      expect(days).toHaveLength(1);
      expect(days[0].detail).toBe("redacted");
      expect(days[0].netWorkedMinutes).toBeNull();
      expect(days[0].entries).toBeNull();
      expect(days[0].warnings).toHaveLength(1);
      expect(days[0].warnings[0].hint).toBe(true);
      expect(numericLeaves(days[0])).toEqual([]);
    });

    it("(c) the manager of C does not see the day", async () => {
      expect(await checks(tokenMC)).toEqual([]);
    });
  });

  // ── the numeric leak scan over everything (b) received ─────────────────────────────────────

  describe("85-AC3 / AC5: nothing B-derived reaches the Einsatzsalon manager", () => {
    it("(b) never receives a B-derived number, a B entry id or a B end time", () => {
      // Anti-vacuity: the scan runs over a non-empty, non-trivial collection.
      expect(bResponses.length).toBeGreaterThanOrEqual(12);
      const leaves = bResponses.flatMap((b) => numericLeaves(b));
      expect(leaves.length).toBeGreaterThan(50);

      const hits = leaves.filter((l) =>
        B_DERIVED_NUMBERS.some((f) => Math.abs(l.value - f) < 1e-9),
      );
      expect(hits).toEqual([]);

      const raw = JSON.stringify(bResponses);
      expect(raw).not.toContain(entryIds.X_B);
      expect(raw).not.toContain(entryIds.Y_B);
      expect(raw).not.toMatch(/T12:11|T12:23/);
    });
  });
});
