/**
 * Phase 113b (AC4, D-09/D-18) — golden-output runner for the four saldo calculation paths.
 *
 * WHAT THIS IS: one command that seeds a fixed fixture, runs it through all four saldo paths
 * (cron auto-close, manual HTTP close, retroactive recalc, live balance) plus the pure
 * `closeEmployeeMonth` core, and writes the results as a stably-sorted JSON document. Run again
 * after the #99 rebuild and `diff` the two files (or pass `--check`, see below) — the diff names
 * exactly which number moved. That is "reproducible" in the literal sense AC4 asks for.
 *
 * WHAT THIS IS NOT (D-10): a correctness check. The golden saldo matrix
 * (`src/__tests__/golden-matrix.test.ts`, `src/__tests__/golden-azubi-jan2026.test.ts`) answers
 * "is the saldo calculation correct". This script answers "did the four paths stay equal across
 * the rebuild" — a different question. Neither golden test file is edited by this script or by
 * this plan; the four-path orchestration below is LIFTED from
 * `src/__tests__/golden-azubi-jan2026.test.ts` (D-18), not a second, independent one.
 *
 * WHY worker database 1, always: `resolveTargetDatabaseUrl()` below deliberately targets
 * per-worker database 1 (via `workerDatabaseName(1, ...)`, `apps/api/src/utils/test-database.ts`
 * — the one place that name pattern is allowed to live), never the TEMPLATE and never a database
 * this script invents itself. Writing fixture rows into the template would poison every later
 * `test:setup` clone. Do not run this script while `pnpm --filter @clokr/api test` is running —
 * worker 1 is then in active use by the suite.
 *
 * WHY a Proxy over `Date`, not Vitest's fake-timer helper: see `withFixedNow` below and
 * `apps/api/vitest.clock-setup.ts`'s header, which this technique is copied from. Faking timers
 * intercepts `setTimeout`/`setInterval` and breaks the live Postgres connection this script
 * depends on (`pg`/Prisma pool timers, keep-alives). The Proxy shifts only the zero-arg `Date`
 * constructor and `Date.now`; timers are never touched.
 *
 * Run:
 *   pnpm --filter @clokr/api run test:setup
 *   pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts             # write
 *   pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check     # gate
 *
 * Exit codes:
 *   0 — success (write mode: file written; check mode: matches the committed baseline)
 *   1 — DATABASE_URL/TEST_DATABASE_URL problem, DB error, or any other unexpected failure
 *   2 — `--check` found a difference between the committed baseline and a fresh run
 */
import { config } from "dotenv";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import bcrypt from "bcryptjs";
import { assertTestDatabaseMarker } from "./test-database-guard";
// `apps/api/src/utils/test-database.ts` itself has zero imports and no module-evaluation side
// effect (see that module's own header) — unlike `config.ts`/`app.ts`/the routes and utils
// listed in `run()` below, which validate the whole environment or touch Postgres at import
// time. That is why this import is a plain static one, exactly like every other script that
// reaches this module (`test-database-guard.ts`, `vitest.worker-setup.ts`): it needs to be
// synchronously available before `DATABASE_URL` is assigned, for `resolveTargetDatabaseUrl()`
// below to be a synchronous, unit-testable `(): URL` function. (A `createRequire`-based
// synchronous dynamic load was tried instead, to keep every `../src/*` reference behind
// `await import(...)`/`require(...)` — it broke under Vitest, whose transform does not give a
// `require()` call inside an ESM module the same `.ts`-aware resolution `tsx`'s loader gives it,
// so the module failed to import under `vitest run`. A plain static import is correct here.)
import {
  assertTestDatabaseUrlShape,
  databaseNameOf,
  resolveTestNamespace,
  workerDatabaseName,
  isWorkerDatabaseName,
} from "../src/utils/test-database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

export const SCHEMA_VERSION = "113b-1";

export interface ScenarioSpec {
  id: string;
  /** ISO instant passed to `app.tryAutoCloseMonth()` via `withFixedNow` (P2, cron). */
  cronNowIso: string;
  /** ISO instant passed to the live/manual-close/recalc steps (P1, P3, P4). */
  liveNowIso: string;
  year: number;
  month: number;
}

/**
 * An array, not a single constant — a second scenario can be added here later without anyone
 * building a second orchestration of the four paths (the state the milestone abort-point table
 * calls "zwei Rechenwege für dasselbe parallel aktiv"). Today it has exactly one entry, lifted
 * from `src/__tests__/golden-azubi-jan2026.test.ts`'s own CRON_NOW/LIVE_NOW constants.
 */
export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: "golden-azubi-jan2026",
    cronNowIso: "2026-02-16T06:00:00.000Z",
    liveNowIso: "2026-02-16T10:00:00.000Z",
    year: 2026,
    month: 1,
  },
];

/** The four-path result shape for one scenario (mirrors ParitySnap in the golden test). */
export interface FourPathSnap {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}

export interface LiveSnap {
  balanceHours: number;
}

export interface ScenarioResult {
  cron: FourPathSnap;
  manualClose: FourPathSnap;
  recalc: FourPathSnap;
  pureCore: FourPathSnap;
  live: LiveSnap;
}

export interface BaselineDocument {
  schemaVersion: string;
  scenarios: Record<string, ScenarioResult>;
}

/**
 * `JSON.stringify` with every object's keys sorted (recursively, at every depth), 2-space indent,
 * trailing newline. Two structurally equal inputs built with different key insertion orders
 * serialize to the identical string — that determinism is the whole reason a `diff` against this
 * file means anything.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortKeysDeep(input[key]);
    }
    return out;
  }
  return value;
}

/**
 * Assembles the checked-in document from a per-scenario results map. Every leaf value is either
 * a number or one of this script's own labels (schema version, scenario id, path name) — never a
 * database id, employee name, tenant name or e-mail (D-11). No timestamp, hostname, git sha or
 * duration is ever added here: any one of those would make the file differ on every re-run and
 * destroy the diff, which is the file's only purpose (D-09).
 */
export function buildBaselineDocument(results: Record<string, ScenarioResult>): BaselineDocument {
  return { schemaVersion: SCHEMA_VERSION, scenarios: results };
}

/**
 * Runs `fn` with `new Date()` and `Date.now()` reporting `iso`, everywhere in the process, for
 * the duration of the call — then restores the real `Date` in a `finally`, even if `fn` throws.
 *
 * This is the same `Proxy`-over-`Date` technique as `apps/api/vitest.clock-setup.ts` (construct
 * trap for the zero-arg case, `get` trap for `.now`) — cited there as the reason not to fake
 * timers against a live Postgres connection: doing so intercepts `setTimeout`/`setInterval`,
 * which `pg`/Prisma's connection-pool keep-alives depend on. This function never touches
 * timers — only the zero-arg `Date` constructor and `Date.now`.
 */
export async function withFixedNow<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = new RealDate(iso).getTime();
  if (Number.isNaN(fixedMs)) {
    throw new Error(`withFixedNow: "${iso}" is not a valid ISO date string.`);
  }

  const proxy = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      args.length === 0
        ? Reflect.construct(target, [fixedMs], newTarget)
        : Reflect.construct(target, args, newTarget),
    get: (target, prop, receiver) =>
      prop === "now" ? () => fixedMs : Reflect.get(target, prop, receiver),
  }) as DateConstructor;

  const g = globalThis as typeof globalThis & { Date: DateConstructor };
  g.Date = proxy;
  try {
    return await fn();
  } finally {
    g.Date = RealDate;
  }
}

/**
 * The single database this script may ever write to: per-worker database 1 (see
 * `apps/api/src/utils/test-database.ts` for the exact name, namespaced per working directory),
 * never the TEMPLATE and never an invented name.
 *
 * Mirrors `apps/api/vitest.worker-setup.ts` steps 1-4: shape-assert the raw
 * `TEST_DATABASE_URL` (throws for unset/empty, for a database outside the test namespace, and
 * for a `?schema=`-carrying URL — every one of `assertTestDatabaseUrlShape`'s own checks),
 * rewrite the pathname to worker 1's database name, then re-assert shape and worker-ness on the
 * result. Pure URL construction — no network I/O, no filesystem access.
 */
export function resolveTargetDatabaseUrl(): URL {
  const templateUrl = assertTestDatabaseUrlShape(
    process.env.TEST_DATABASE_URL,
    "TEST_DATABASE_URL",
  );

  const namespace = resolveTestNamespace();
  const workerName = workerDatabaseName(1, namespace);

  const workerUrl = new URL(templateUrl.toString());
  workerUrl.pathname = `/${workerName}`;

  const asserted = assertTestDatabaseUrlShape(
    workerUrl.toString(),
    "resolved worker-1 DATABASE_URL",
  );
  if (!isWorkerDatabaseName(databaseNameOf(asserted))) {
    throw new Error(
      `resolveTargetDatabaseUrl: resolved "${databaseNameOf(asserted)}", which is not a ` +
        `per-worker test database. Refusing to target anything but worker 1.`,
    );
  }
  return asserted;
}

// ── Part B: fixture (lifted from golden-azubi-jan2026.test.ts, D-18) ──────────

const TZ = "Europe/Berlin";

interface ScenarioFixture {
  tenantId: string;
  empId: string;
  adminToken: string;
  tz: string;
  /** carryOverIn for the pure-core call — 0 here because the fixture anchors a Dec-2025
   *  zero-snapshot immediately before the measured month (see below). */
  pureCoreCarryOverIn: number;
  holidayDateStrings: Set<string>;
}

// Rostered shifts (17 total) — verbatim from golden-azubi-jan2026.test.ts.
// All shifts start at 08:00; end = 08:00 + brutto. break override = 0 → brutto = netto.
const SHIFTS_576 = [
  "2026-01-02",
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-12",
  "2026-01-13",
  "2026-01-15",
  "2026-01-22",
  "2026-01-26",
  "2026-01-27",
  "2026-01-28",
]; // 12 × 576 min
const SHIFTS_480 = ["2026-01-09", "2026-01-16", "2026-01-23", "2026-01-29", "2026-01-30"]; // 5 × 480 min

/** Seed a Shift record. Shift starts at 08:00; end is computed from netto (breakOverride=0). */
async function seedShift(
  app: FastifyApp,
  empId: string,
  dateStr: string,
  netto: number,
): Promise<void> {
  const totalH = Math.floor(netto / 60);
  const totalM = netto % 60;
  const endHHMM = `${String(8 + totalH).padStart(2, "0")}:${String(totalM).padStart(2, "0")}`;
  await app.prisma.shift.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: "08:00",
      endTime: endHHMM,
      deletedAt: null,
    },
  });
}

/** Seed a WORK TimeEntry matching the given shift (breakMinutes=0). */
async function seedEntry(
  app: FastifyApp,
  empId: string,
  dateStr: string,
  netto: number,
): Promise<void> {
  const start = new Date(dateStr + "T08:00:00Z");
  const end = new Date(start.getTime() + netto * 60_000);
  await app.prisma.timeEntry.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: start,
      endTime: end,
      breakMinutes: 0,
      type: "WORK",
    },
  });
}

/**
 * Loose structural type for the app instance this script's helpers need — deliberately not
 * `import type { FastifyInstance } from "fastify"` typed narrower than that, to keep this file
 * free of any dependency on `../src/*` type declarations beyond the one already-imported
 * `test-database` module. `getTestApp()` (dynamically imported inside `run()`) returns the real
 * Fastify instance; this type only needs to describe the surface used below.
 */
type FastifyApp = Awaited<ReturnType<typeof import("../src/__tests__/setup").getTestApp>>;

/**
 * Seeds the SHIFT_BASED Azubi January-2026 fixture — lifted from
 * `src/__tests__/golden-azubi-jan2026.test.ts`'s own `beforeAll` (D-18): its own tenant, its own
 * admin, its own Azubi employee, 17 rostered shifts matched by 17 identical TimeEntries, one
 * VOCATIONAL_SCHOOL absence, three approved Urlaubstage, one PublicHoliday row, and a Dec-2025
 * zero-snapshot anchor. No real personal data anywhere (D-11): every name/email is a fixed
 * placeholder plus a per-run random suffix, never traceable to a real employee or tenant.
 */
async function seedGoldenAzubiJan2026(app: FastifyApp): Promise<ScenarioFixture> {
  const prisma = app.prisma;
  const s = `t22-parity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

  const tenant = await prisma.tenant.create({
    data: { name: `T22 Parity ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
  });
  const tenantId = tenant.id;

  // Default-config tenant (vocationalSchoolMinutesPerDay stays at its DB default, bsSlot*
  // fields null) — FIRST_LONG_DAY resolves to the individual daily Soll (§15 Abs. 2 Nr. 2 BBiG),
  // matching the golden fixture exactly.
  await prisma.tenantConfig.create({
    data: { tenantId, defaultVacationDays: 30, timezone: TZ },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@t22.test`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "ADMIN",
      isActive: true,
    },
  });
  const adminEmp = await prisma.employee.create({
    data: {
      tenantId,
      userId: adminUser.id,
      employeeNumber: `ADM-${s}`,
      firstName: "Admin",
      lastName: "Parity",
      hireDate: new Date("2024-01-01T00:00:00Z"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmp.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `admin-${s}@t22.test`, password: "test1234" },
  });
  if (loginRes.statusCode !== 200) {
    throw new Error(
      `seedGoldenAzubiJan2026: admin login failed: ${loginRes.statusCode} ${loginRes.body}`,
    );
  }
  const adminToken = (JSON.parse(loginRes.body) as { accessToken: string }).accessToken;

  const empUser = await prisma.user.create({
    data: {
      email: `azubi-${s}@t22.test`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId,
      userId: empUser.id,
      employeeNumber: `AZU-${s}`,
      firstName: "Azubi",
      lastName: "Parity",
      hireDate: new Date("2025-12-01T00:00:00Z"),
      classification: "AZUBI",
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  const empId = emp.id;

  await prisma.workSchedule.create({
    data: {
      employeeId: empId,
      type: "SHIFT_BASED",
      weeklyHours: 38,
      mondayHours: 7.6,
      tuesdayHours: 7.6,
      wednesdayHours: 7.6,
      thursdayHours: 7.6,
      fridayHours: 7.6,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2025-12-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: empId, balanceHours: 0 } });

  // Dec-2025 zero-snapshot anchor — makes the Jan-2026 close start with carryOverIn=0, and is
  // what the sequential-close guard needs to accept the Jan close at all.
  const decStart = new Date("2025-12-01T00:00:00Z");
  const decEnd = new Date("2026-01-01T00:00:00Z");
  await prisma.saldoSnapshot.create({
    data: {
      employeeId: empId,
      periodType: "MONTHLY",
      periodStart: decStart,
      periodEnd: decEnd,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
      closedBy: "measure-saldo-path-parity",
    },
  });

  for (const d of SHIFTS_576) await seedShift(app, empId, d, 576);
  for (const d of SHIFTS_480) await seedShift(app, empId, d, 480);
  for (const d of SHIFTS_576) await seedEntry(app, empId, d, 576);
  for (const d of SHIFTS_480) await seedEntry(app, empId, d, 480);

  // VOCATIONAL_SCHOOL absence — sole BS day in its ISO week → FIRST_LONG_DAY slot.
  await prisma.absence.create({
    data: {
      employeeId: empId,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: new Date("2026-01-14T00:00:00Z"),
      endDate: new Date("2026-01-14T00:00:00Z"),
      days: 1,
      createdBy: empId,
    },
  });

  // Approved LeaveRequest — 3 Urlaubstage Mon–Wed Jan 19–21.
  const lt = await prisma.leaveType.create({
    data: { tenantId, code: "VACATION", name: "Urlaub Parity", isPaid: true },
  });
  await prisma.leaveRequest.create({
    data: {
      employeeId: empId,
      leaveTypeId: lt.id,
      status: "APPROVED",
      startDate: new Date("2026-01-19T00:00:00Z"),
      endDate: new Date("2026-01-21T00:00:00Z"),
      days: 3,
      halfDay: false,
    },
  });

  // PublicHoliday — Neujahr 2026-01-01 NIEDERSACHSEN.
  await prisma.publicHoliday.create({
    data: {
      tenantId,
      date: new Date("2026-01-01T00:00:00Z"),
      name: "Neujahr",
      federalState: "NIEDERSACHSEN",
      year: 2026,
    },
  });

  return {
    tenantId,
    empId,
    adminToken,
    tz: TZ,
    pureCoreCarryOverIn: 0,
    holidayDateStrings: new Set(["2026-01-01"]),
  };
}

const FIXTURE_BUILDERS: Record<string, (app: FastifyApp) => Promise<ScenarioFixture>> = {
  "golden-azubi-jan2026": seedGoldenAzubiJan2026,
};

// ── Part C: `run()` — the script entry point ───────────────────────────────────

const BASELINE_PATH = resolvePath(__dirname, "../baselines/saldo-path-parity-baseline.json");

function diffLines(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      out.push(`  line ${i + 1}:`);
      out.push(`    - ${o ?? "<missing>"}`);
      out.push(`    + ${n ?? "<missing>"}`);
    }
  }
  return out.join("\n");
}

export async function run(): Promise<number> {
  try {
    // Step 1: load apps/api/.env.test exactly as vitest.setup.ts does. override:false — a real
    // ambient environment wins, and is then rejected below by the namespace guard if it points
    // outside the test namespace. That rejection is the correct outcome, not a bug to work around.
    config({ path: resolvePath(__dirname, "../.env.test"), override: false });

    // Step 2-3: resolve + possession-check worker database 1. Fail closed before any write.
    const url = resolveTargetDatabaseUrl();
    await assertTestDatabaseMarker(url.toString(), databaseNameOf(url));

    // Step 4: only now assign DATABASE_URL.
    process.env.DATABASE_URL = url.toString();

    // Step 5: only now reach app-side modules — config.ts validates the whole environment
    // (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ...) at module-evaluation time, so importing
    // any of these before step 4 would run that validation against nothing.
    const { getTestApp, cleanupTestData } = await import("../src/__tests__/setup");
    const { recalculateSnapshots } = await import("../src/utils/recalculate-snapshots");
    const { updateOvertimeAccount } = await import("../src/routes/time-entries");
    const { closeEmployeeMonth } = await import("../src/utils/close-employee-month");
    const { monthRangeUtc, monthDayBounds } = await import("../src/utils/timezone");

    type CloseMonthInput = Parameters<typeof closeEmployeeMonth>[0];

    const app = await getTestApp();

    // getTestApp() builds the full Fastify app, which registers cron-job plugins
    // (auto-close-month, attendance-checker, data-retention, ...) holding open timers, plus the
    // Prisma connection pool. None of that is closed on its own — without an explicit
    // `app.close()` the process never exits by itself once run() returns (measured: every
    // invocation during development left an orphaned node process behind). `app.close()` runs
    // every plugin's `onClose` hook (stopping cron timers) and disconnects Prisma, so wrapping
    // everything below in try/finally is what lets this script actually terminate.
    try {
      const scenarioResults: Record<string, ScenarioResult> = {};

      for (const scenario of SCENARIOS) {
        const buildFixture = FIXTURE_BUILDERS[scenario.id];
        if (!buildFixture) {
          throw new Error(
            `run(): no fixture builder registered for scenario "${scenario.id}" — add one in ` +
              `FIXTURE_BUILDERS instead of building a second orchestration (D-18).`,
          );
        }

        const fixture = await buildFixture(app);
        const { tenantId, empId, adminToken, tz, pureCoreCarryOverIn, holidayDateStrings } =
          fixture;

        try {
          const { start: monthStart, end: monthEnd } = monthRangeUtc(
            scenario.year,
            scenario.month,
            tz,
          );

          const fetchSnap = () =>
            app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: empId,
                periodType: "MONTHLY",
                superseded: false,
                periodEnd: monthEnd,
              },
            });

          const toParitySnap = (snap: {
            workedMinutes: number;
            expectedMinutes: number;
            balanceMinutes: number;
            carryOver: number;
          }): FourPathSnap => ({
            workedMinutes: snap.workedMinutes,
            expectedMinutes: snap.expectedMinutes,
            balanceMinutes: snap.balanceMinutes,
            carryOver: snap.carryOver,
          });

          // ── P2: cron auto-close ────────────────────────────────────────────
          await withFixedNow(scenario.cronNowIso, () => app.tryAutoCloseMonth());
          const cronSnapRow = await fetchSnap();
          if (!cronSnapRow) {
            throw new Error(`scenario "${scenario.id}": no snapshot after cron close`);
          }
          const cron = toParitySnap(cronSnapRow);

          // ── P4: live balance (post cron-close) ──────────────────────────────
          const live: LiveSnap = await withFixedNow(scenario.liveNowIso, async () => {
            await updateOvertimeAccount(app, empId);
            const acc = await app.prisma.overtimeAccount.findUnique({
              where: { employeeId: empId },
            });
            return { balanceHours: Number(acc?.balanceHours ?? 0) };
          });

          // ── P1: unlock + manual HTTP close ──────────────────────────────────
          const unlock1 = await app.inject({
            method: "POST",
            url: "/api/v1/overtime/unlock-month",
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {
              employeeId: empId,
              year: scenario.year,
              month: scenario.month,
              reason: "measure-saldo-path-parity",
            },
          });
          if (unlock1.statusCode !== 200) {
            throw new Error(
              `scenario "${scenario.id}": unlock (pre-manual-close) failed: ` +
                `${unlock1.statusCode} ${unlock1.body}`,
            );
          }

          const closeRes = await withFixedNow(scenario.liveNowIso, () =>
            app.inject({
              method: "POST",
              url: "/api/v1/overtime/close-month",
              headers: { authorization: `Bearer ${adminToken}` },
              payload: {
                employeeId: empId,
                year: scenario.year,
                month: scenario.month,
                confirmGaps: true,
              },
            }),
          );
          if (closeRes.statusCode !== 201) {
            throw new Error(
              `scenario "${scenario.id}": manual close failed: ${closeRes.statusCode} ${closeRes.body}`,
            );
          }
          const manualSnapRow = await fetchSnap();
          if (!manualSnapRow) {
            throw new Error(`scenario "${scenario.id}": no snapshot after manual close`);
          }
          const manualClose = toParitySnap(manualSnapRow);

          // ── P3: unlock + retroactive recalc ─────────────────────────────────
          // `recalculateSnapshots()` only UPDATES an existing active (superseded:false)
          // snapshot — it never creates one (its own docstring: "does not create new ones") —
          // and it skips any month whose TimeEntries are still locked (`isSnapshotLocked`,
          // Phase 99 D-09 immutability-after-lock). A manual close both activates the snapshot
          // AND re-locks its entries, so recalc needs a fresh unlock+close cycle immediately
          // before it, exactly like golden-azubi-jan2026.test.ts's own step 4 (D-18 — lifted,
          // not reinvented): unlock, close again (unlabeled — only sets up recalc's
          // precondition), then recalc reads back whatever state that leaves behind. In this
          // fixture nothing about the underlying data changed, so recalc is expected to
          // reproduce the same numbers either way (by actually recomputing them, or — since the
          // entries are locked again by the second close — by correctly refusing to touch a
          // locked month and leaving it exactly as the second close left it). Both outcomes are
          // legitimate production behavior and either way the written number is what "recalc"
          // means here: what a caller reading the snapshot after `recalculateSnapshots()` runs
          // actually sees.
          const unlock2 = await app.inject({
            method: "POST",
            url: "/api/v1/overtime/unlock-month",
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {
              employeeId: empId,
              year: scenario.year,
              month: scenario.month,
              reason: "measure-saldo-path-parity",
            },
          });
          if (unlock2.statusCode !== 200) {
            throw new Error(
              `scenario "${scenario.id}": unlock (pre-recalc) failed: ` +
                `${unlock2.statusCode} ${unlock2.body}`,
            );
          }
          const reCloseRes = await withFixedNow(scenario.liveNowIso, () =>
            app.inject({
              method: "POST",
              url: "/api/v1/overtime/close-month",
              headers: { authorization: `Bearer ${adminToken}` },
              payload: {
                employeeId: empId,
                year: scenario.year,
                month: scenario.month,
                confirmGaps: true,
              },
            }),
          );
          if (reCloseRes.statusCode !== 201) {
            throw new Error(
              `scenario "${scenario.id}": pre-recalc re-close failed: ` +
                `${reCloseRes.statusCode} ${reCloseRes.body}`,
            );
          }
          await recalculateSnapshots(app, empId, monthStart);
          const recalcSnapRow = await fetchSnap();
          if (!recalcSnapRow) {
            throw new Error(`scenario "${scenario.id}": no snapshot after recalc`);
          }
          const recalc = toParitySnap(recalcSnapRow);

          // ── pure core: closeEmployeeMonth() called directly ─────────────────
          const schedule = await app.prisma.workSchedule.findFirst({
            where: { employeeId: empId },
          });
          const employee = await app.prisma.employee.findUnique({ where: { id: empId } });
          if (!employee)
            throw new Error(`scenario "${scenario.id}": employee vanished before pure-core call`);

          const entries = await app.prisma.timeEntry.findMany({
            where: { employeeId: empId, deletedAt: null },
            select: { date: true, startTime: true, endTime: true, breakMinutes: true },
          });
          const shifts = await app.prisma.shift.findMany({
            where: { employeeId: empId, deletedAt: null },
            select: { date: true, startTime: true, endTime: true },
          });
          const absences = await app.prisma.absence.findMany({
            where: { employeeId: empId, deletedAt: null },
            select: { startDate: true, endDate: true, type: true, source: true },
          });
          const approvedLeave = await app.prisma.leaveRequest.findMany({
            where: { employeeId: empId, status: "APPROVED", deletedAt: null },
            select: { startDate: true, endDate: true, halfDay: true },
          });
          const closeTenantConfig = await app.prisma.tenantConfig.findFirst({
            where: { tenantId },
          });

          const { firstDay, lastDay } = monthDayBounds(monthStart, monthEnd, tz);
          const coreResult = closeEmployeeMonth({
            employeeId: empId,
            monthStart,
            monthEnd,
            monthFirstDay: firstDay,
            monthLastDay: lastDay,
            tz,
            carryOverIn: pureCoreCarryOverIn,
            schedule: schedule as unknown as Record<string, unknown>,
            hireDate: employee.hireDate,
            exitDate: null,
            isTimeTrackingExempt: false,
            breakOver6hOverride: 0,
            breakOver9hOverride: 0,
            entries: entries as CloseMonthInput["entries"],
            shifts: shifts as CloseMonthInput["shifts"],
            approvedLeave: approvedLeave as CloseMonthInput["approvedLeave"],
            absences: absences as CloseMonthInput["absences"],
            holidayDateStrings,
            tenantConfig: closeTenantConfig
              ? {
                  defaultBreakOver6h: closeTenantConfig.defaultBreakOver6h,
                  defaultBreakOver9h: closeTenantConfig.defaultBreakOver9h,
                  monthlyHoursHolidayDeduction:
                    closeTenantConfig.monthlyHoursHolidayDeduction ?? undefined,
                  vocationalSchoolMinutesPerDay:
                    closeTenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
                  vocationalSchoolBlockMinutesPerWeek:
                    closeTenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
                  bsSlotFirstLongDayMinutes:
                    closeTenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
                  bsSlotSecondLongDayMinutes:
                    closeTenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
                  bsSlotShortDayMinutes: closeTenantConfig.bsSlotShortDayMinutes ?? undefined,
                  bsSlotBlockWeekMinutes: closeTenantConfig.bsSlotBlockWeekMinutes ?? undefined,
                }
              : null,
          });

          const pureCore: FourPathSnap = {
            workedMinutes: coreResult.workedMinutes,
            expectedMinutes: coreResult.expectedMinutes,
            balanceMinutes: coreResult.balanceMinutes,
            carryOver: coreResult.carryOverOut,
          };

          scenarioResults[scenario.id] = { cron, manualClose, recalc, pureCore, live };
        } finally {
          try {
            await cleanupTestData(app, tenantId);
          } catch (cleanupErr) {
            console.error(`scenario "${scenario.id}": cleanup failed (non-fatal):`, cleanupErr);
          }
        }
      }

      const doc = buildBaselineDocument(scenarioResults);
      const serialized = stableStringify(doc);

      const checkMode = process.argv.includes("--check");
      if (checkMode) {
        if (!existsSync(BASELINE_PATH)) {
          console.error(`--check: no baseline file at ${BASELINE_PATH}`);
          return 2;
        }
        const existing = readFileSync(BASELINE_PATH, "utf8");
        if (existing === serialized) {
          console.log(`OK: ${BASELINE_PATH} matches a freshly computed run.`);
          return 0;
        }
        console.error(`MISMATCH: ${BASELINE_PATH} differs from a freshly computed run:`);
        console.error(diffLines(existing, serialized));
        return 2;
      }

      writeFileSync(BASELINE_PATH, serialized);
      console.log(`Wrote ${BASELINE_PATH}`);
      return 0;
    } finally {
      await app.close();
    }
  } catch (err) {
    console.error(err);
    return 1;
  }
}

// Run-guard (#203 binding): only bootstrap + execute when invoked as a script, so importing this
// module for unit tests never opens a database connection, never writes a file, and never calls
// process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
