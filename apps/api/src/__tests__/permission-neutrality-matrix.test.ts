/**
 * Phase 75b (Issue #75, D-20, D-21, D-25, AC-75-9, AC-75-10, AC-75-11) — the permission
 * neutrality matrix.
 *
 * ── What it proves ──────────────────────────────────────────────────────────────────────────────
 * Issue #75 replaces every `requireRole(...)` and every role comparison in the API with
 * permission checks, and promises that this changes NO access decision. The matrix makes that
 * promise falsifiable: every route of the API (derived from source, `neutrality/route-derivation.ts`)
 * is called by every actor — EMPLOYEE, API key without `admin`, MANAGER, API key with `admin`,
 * ADMIN, in that order (least privileged first), plus three fallback actors (D-21) — on the own
 * person's, a foreign person's or a tenant-level entity, and each response is reduced to a record
 * (`neutrality/cell-runner.ts`: status, error string, fixture-labelled id multiset, content type,
 * masking projections). The records of the UNCHANGED code are recorded once; after the switch the
 * same cells must produce the same records.
 *
 * The five main actors hold stored role assignments (the checked-in migration SQL gives them one,
 * D-25), so after the switch they prove "migration + switched code == old code". The three fallback
 * actors are built AFTER the migration ran and hold no assignment — a test below proves that — so
 * they prove the legacy-role fallback path (D-21).
 *
 * ── RECORD vs VERIFY ────────────────────────────────────────────────────────────────────────────
 *   NEUTRALITY_MATRIX_MODE=record  run the cells and write every record to the recording file
 *                                  (default `neutrality/recorded/matrix.json`, or
 *                                  NEUTRALITY_MATRIX_OUT) in `afterAll`;
 *   (default) VERIFY               compare every cell with the recording (default path, or
 *                                  NEUTRALITY_MATRIX_IN); a cell missing from it fails "not
 *                                  recorded".
 * Both modes build the fixture, then execute the checked-in migration SQL (D-25: the old code
 * ignores stored assignments for every access decision, so a recording with the migration applied
 * is still a recording of the unchanged code), then build the fallback tenants, then run the cells.
 *
 * Re-recording AFTER the switch is forbidden: it would replace the old code's answers with the new
 * code's and prove nothing. The only exception is D-24 — routes that arrive from `origin/main`
 * after the recording get their NEW rows recorded on pre-switch semantics, documented per route.
 *
 * ── Completeness (AC-75-10) ─────────────────────────────────────────────────────────────────────
 * The derived route set must equal ROUTE_SPECS ∪ EXCLUDED_ROUTES in both directions, and every
 * OUTSIDE_DERIVATION route must be registered, so a new route cannot slip past the matrix.
 *
 * ── Discriminating check (anti-vacuity for handler checks) ─────────────────────────────────────
 * A handler that decides by role itself is only covered if the request reaches that decision. For
 * every such GET route (`handlerCheck`) the EMPLOYEE and ADMIN records of the same variant must
 * differ; if they coincided, the request most likely failed before the check (e.g. a 400) and the
 * cell would prove nothing.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────────────────────────
 * Only `Date` is faked (PINNED_NOW). Prisma 7 fills `@default(now())` on the client, so every row
 * the fixture or a cell creates through Prisma carries the pinned time; only raw SQL (the migration
 * file's `now()`) carries the real database time, and no read route compares against that. The
 * ADMIN activity feed also reads global `userId: null` audit rows, which other files leave behind;
 * the fixture's feed pins (`ACTIVITY_FEED_LIMIT` far-future rows per tenant) keep those out of the
 * cell. Known limit: `GET /holidays` falls back to an unordered `tenant.findFirst()` for an API-key
 * caller (`holidays.ts`, pre-existing, recorded as-is), so its API-key cells name the database's
 * first tenant — the matrix's first actor tenant on a freshly provisioned worker database
 * (`test:setup`), which is how every recording and verification of this file is run.
 *
 * ── Side effects ────────────────────────────────────────────────────────────────────────────────
 * Object storage is replaced by an in-memory stub (avatars and § 9 documents are served from it)
 * and `fetch` fails deterministically, so no cell depends on MinIO or on an external API.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, cleanupTestData } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { deriveMatrixRoutes } from "./neutrality/route-derivation";
import {
  ACTOR_ORDER,
  EXCLUDED_ROUTES,
  FALLBACK_ACTORS,
  OUTSIDE_DERIVATION,
  PHASES_ENABLED,
  ROUTE_SPECS,
  type ActorKind,
  type CellPhase,
} from "./neutrality/matrix-config";
import { buildActorTenant, cleanupMatrixExtras, type ActorFixture } from "./neutrality/fixture";
import {
  actorRunsVariant,
  runCell,
  variantsOf,
  type CellResult,
  type LabelContext,
} from "./neutrality/cell-runner";

const MODE = process.env.NEUTRALITY_MATRIX_MODE === "record" ? "record" : "verify";
const DEFAULT_RECORDING = join(__dirname, "neutrality", "recorded", "matrix.json");
const RECORD_OUT = process.env.NEUTRALITY_MATRIX_OUT || DEFAULT_RECORDING;
const VERIFY_IN = process.env.NEUTRALITY_MATRIX_IN || DEFAULT_RECORDING;

/** The frozen "now" of every run: a Wednesday mid-month, not a public holiday, in the past. Only
 * `Date` is faked — full fake timers break the pg connection (vitest.clock-setup.ts). */
const PINNED_NOW = new Date("2026-06-17T08:00:00.000Z");

const PHASE_ORDER: readonly CellPhase[] = ["read", "mutate", "self-destructive"];

/** The shortest acceptable written reason of an exclusion or a coinciding handler-check pair. */
const MIN_REASON_LENGTH = 20;

const derivedRoutes = deriveMatrixRoutes();

/** Enabled routes in cell order: read first, then mutate, then self-destructive (Pitfall 4). */
const orderedRoutes = PHASE_ORDER.flatMap((phase) =>
  Object.keys(ROUTE_SPECS)
    .filter((route) => ROUTE_SPECS[route].phase === phase && PHASES_ENABLED.has(phase))
    .sort(),
);

function cellKey(actor: ActorKind, route: string, variant: string): string {
  return `${actor} | ${route} | ${variant}`;
}

const GLOBAL_LABELS: ReadonlyMap<string, string> = new Map([
  [SYSTEM_ROLE_IDS.ADMIN, "system.role.admin"],
  [SYSTEM_ROLE_IDS.MANAGER, "system.role.manager"],
  [SYSTEM_ROLE_IDS.EMPLOYEE, "system.role.employee"],
]);

describe("permission neutrality matrix (Issue #75)", () => {
  let app: FastifyInstance;
  let originalStorage: FastifyInstance["storage"] | undefined;
  const fixtures = new Map<ActorKind, ActorFixture>();
  const collected = new Map<string, CellResult>();
  let recording: Record<string, CellResult> | undefined;

  /** Registers the rows the migration SQL created for this tenant's users. */
  async function registerMigrationRows(fixture: ActorFixture): Promise<void> {
    const assignments = await app.prisma.roleAssignment.findMany({
      where: { tenantId: fixture.tenantId, accessRole: { tenantId: null } },
      select: { id: true, userId: true },
    });
    for (const assignment of assignments) {
      const userLabel = fixture.registry.labelOf(assignment.userId);
      if (userLabel === undefined) {
        throw new Error(`matrix: migration assigned a role to an unregistered user`);
      }
      const label = `${userLabel.replace(/\.user$/, "")}.roleAssignment.migrated`;
      fixture.registry.register(label, assignment.id);
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "RoleAssignment", entityId: assignment.id },
        select: { id: true },
      });
      audits.forEach((audit, i) => fixture.registry.register(`${label}.audit.${i}`, audit.id));
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    vi.useFakeTimers({ now: PINNED_NOW, toFake: ["Date"] });

    originalStorage = app.storage;
    const stored = new Map<string, Buffer>();
    app.storage = {
      upload: async (path, buffer) => {
        stored.set(path, buffer);
      },
      getBuffer: async (path) => stored.get(path) ?? Buffer.from("matrix-fixture-object"),
      delete: async (path) => {
        stored.delete(path);
      },
    };
    vi.stubGlobal("fetch", async () => {
      throw new Error("network access is disabled in the neutrality matrix");
    });

    for (const actor of ACTOR_ORDER.filter((a) => !FALLBACK_ACTORS.has(a))) {
      fixtures.set(actor, await buildActorTenant(app, actor));
    }
    // D-25: the checked-in migration SQL runs on the fixture before any cell, in both modes.
    await executeLegacyRoleMigration(app.prisma);
    for (const fixture of fixtures.values()) await registerMigrationRows(fixture);
    // D-21: the fallback actors exist only after the migration, so they hold no assignment.
    for (const actor of ACTOR_ORDER.filter((a) => FALLBACK_ACTORS.has(a))) {
      fixtures.set(actor, await buildActorTenant(app, actor));
    }

    if (MODE === "verify") {
      if (!existsSync(VERIFY_IN)) {
        throw new Error(
          `matrix: no recording at ${VERIFY_IN} — run with NEUTRALITY_MATRIX_MODE=record first`,
        );
      }
      recording = (
        JSON.parse(readFileSync(VERIFY_IN, "utf8")) as { cells: Record<string, CellResult> }
      ).cells;
    }
  }, 600_000);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalStorage) app.storage = originalStorage;
    if (MODE === "record") {
      const cells = Object.fromEntries(
        [...collected.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      mkdirSync(dirname(RECORD_OUT), { recursive: true });
      writeFileSync(RECORD_OUT, `${JSON.stringify({ cells }, null, 2)}\n`);
      const serverErrors = [...collected.entries()].filter(([, r]) => r.status >= 500);
      if (serverErrors.length > 0) {
        console.warn(
          `matrix: ${serverErrors.length} cell(s) answered 5xx — findings, not harness noise:\n` +
            serverErrors.map(([key, r]) => `  ${key} -> ${r.status} ${r.error ?? ""}`).join("\n"),
        );
      }
    }
    for (const fixture of fixtures.values()) {
      try {
        await cleanupMatrixExtras(app, fixture.tenantId);
        await cleanupTestData(app, fixture.tenantId);
      } catch (err) {
        console.error(`matrix: cleanup of the ${fixture.actor} tenant failed:`, err);
      }
    }
  });

  describe("route set completeness (AC-75-10)", () => {
    it("derives a non-empty route set from source", () => {
      expect(derivedRoutes.length).toBeGreaterThan(0);
    });

    it("gives every derived route a spec or a written exclusion", () => {
      const covered = new Set([
        ...Object.keys(ROUTE_SPECS),
        ...EXCLUDED_ROUTES.map((e) => e.route),
      ]);
      expect(derivedRoutes.filter((route) => !covered.has(route))).toEqual([]);
    });

    it("has no spec or exclusion for a route that no longer exists", () => {
      const derived = new Set(derivedRoutes);
      const stale = [...Object.keys(ROUTE_SPECS), ...EXCLUDED_ROUTES.map((e) => e.route)].filter(
        (route) => !derived.has(route),
      );
      expect(stale).toEqual([]);
    });

    it("never lists a route both as spec and as exclusion", () => {
      expect(EXCLUDED_ROUTES.map((e) => e.route).filter((route) => route in ROUTE_SPECS)).toEqual(
        [],
      );
    });

    it("proves every route declared in app.ts itself is registered", () => {
      const missing = OUTSIDE_DERIVATION.filter(({ route }) => {
        const [method, url] = route.split(" ");
        return !app.hasRoute({ method: method as "GET", url });
      });
      expect(missing).toEqual([]);
      expect(OUTSIDE_DERIVATION.length).toBeGreaterThan(0);
    });

    it("gives every exclusion, every app.ts route and every coinciding pair a written reason", () => {
      const short = [
        ...EXCLUDED_ROUTES.filter((e) => e.reason.trim().length < MIN_REASON_LENGTH),
        ...OUTSIDE_DERIVATION.filter((e) => e.reason.trim().length < MIN_REASON_LENGTH),
        ...Object.entries(ROUTE_SPECS)
          .filter(
            ([, spec]) =>
              typeof spec.handlerCheck === "string" &&
              spec.handlerCheck.trim().length < MIN_REASON_LENGTH,
          )
          .map(([route]) => ({ route, reason: "" })),
      ].map((e) => e.route);
      expect(short).toEqual([]);
    });
  });

  describe("fallback actors (D-21)", () => {
    it("hold zero stored role assignments at run start, so every cell of theirs uses the legacy-role fallback", async () => {
      const fallbackUsers = ACTOR_ORDER.filter((a) => FALLBACK_ACTORS.has(a)).map((actor) => {
        const userId = fixtures.get(actor)?.actorUserId;
        if (!userId) throw new Error(`matrix: fallback actor ${actor} has no user`);
        return { actor, userId };
      });
      expect(fallbackUsers).toHaveLength(3);
      const counts = await Promise.all(
        fallbackUsers.map(async ({ actor, userId }) => ({
          actor,
          assignments: await app.prisma.roleAssignment.count({ where: { userId } }),
        })),
      );
      expect(counts).toEqual(fallbackUsers.map(({ actor }) => ({ actor, assignments: 0 })));
    });

    it("the five main actors' users DO hold a migrated assignment (the contrast the fallback proof needs)", async () => {
      const mainUsers = ACTOR_ORDER.filter((a) => !FALLBACK_ACTORS.has(a))
        .map((actor) => fixtures.get(actor)?.actorUserId)
        .filter((userId): userId is string => userId !== undefined);
      expect(mainUsers).toHaveLength(3);
      for (const userId of mainUsers) {
        expect(await app.prisma.roleAssignment.count({ where: { userId } })).toBe(1);
      }
    });
  });

  for (const [actorIndex, actor] of ACTOR_ORDER.entries()) {
    describe(`actor ${actor}`, () => {
      for (const route of orderedRoutes) {
        const spec = ROUTE_SPECS[route];
        it(route, async () => {
          const fixture = fixtures.get(actor);
          if (!fixture) throw new Error(`matrix: no fixture for ${actor}`);
          const ctx: LabelContext = {
            self: fixture,
            others: [...fixtures.values()].filter((f) => f !== fixture),
            global: GLOBAL_LABELS,
          };
          for (const variant of variantsOf(route, spec)) {
            if (!actorRunsVariant(fixture, variant)) continue;
            const key = cellKey(actor, route, variant.name);
            const result = await runCell({
              app,
              ctx,
              actorSlot: actorIndex + 1,
              route,
              spec,
              variant,
            });
            collected.set(key, result);
            if (MODE === "verify") {
              const expected = recording?.[key];
              expect.soft(expected, `${key}: not recorded`).toBeDefined();
              if (expected !== undefined) expect.soft(result, key).toEqual(expected);
            }
          }
        });
      }
    });
  }

  describe("discriminating check", () => {
    it("every handler-check GET route separates the EMPLOYEE from the ADMIN record, or names why not", () => {
      const checked = Object.entries(ROUTE_SPECS).filter(
        ([, spec]) => spec.handlerCheck !== undefined && PHASES_ENABLED.has(spec.phase),
      );
      expect(checked.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const [route, spec] of checked) {
        const variant = spec.checkVariant ?? "foreign";
        const employee = collected.get(cellKey("EMPLOYEE", route, variant));
        const admin = collected.get(cellKey("ADMIN", route, variant));
        if (!employee || !admin) {
          problems.push(`${route} [${variant}]: cell not collected in this run`);
          continue;
        }
        if (spec.handlerCheck === true && JSON.stringify(employee) === JSON.stringify(admin)) {
          problems.push(
            `${route} [${variant}]: EMPLOYEE and ADMIN coincide (${JSON.stringify(admin)}) — ` +
              `the ownership branch is not reached; fix the query or write a reason`,
          );
        }
      }
      expect(problems).toEqual([]);
    });
  });
});
