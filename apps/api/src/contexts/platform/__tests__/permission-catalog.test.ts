/**
 * Phase 72b (Issue #72) — the invariants of the permission catalog.
 *
 * `permission-catalog.ts` is the ONE machine-enumerable list of permissions that #73 (roles),
 * #75 (call-site switch) and #83 (role UI) bundle, switch to and display. Once #75 binds the
 * call sites to it, a wrong catalog entry becomes a wrong grant — so every structural promise the
 * issue's acceptance criteria make about the catalog is pinned here:
 *
 * - "reach vocabulary" (AK-72-3, D-03): the reach dimension knows exactly `EIGENE` and
 *   `ZUGEWIESEN`, and no entry carries a third value.
 * - "unique triple" (AK-72-2, D-02): every permission is identified by resource × action × reach,
 *   and no triple occurs twice in the flat list.
 * - "MANDANT has no EIGENE" (AK-72-4, D-04): every resource carries relation PERSON or MANDANT,
 *   and a tenant-wide resource never has an own-data (`EIGENE`) permission.
 * - "one resource per permission" (AK-72-7): every entry names exactly one known resource and
 *   carries no other keys; contract, overtime and month-close are resources distinct from
 *   time-entry.
 * - "catalog equals the issue #72 table" (AK-72-5, D-12): the catalog holds every resource and
 *   every action of the issue table and nothing beyond it, checked in both directions.
 * - "export surface" (AK-72-1): the catalog is reachable through `contexts/platform/index.ts` as
 *   the very same objects, not as copies.
 *
 * `ISSUE_72_TABLE` below is transcribed BY HAND from the resource table in the body of GitHub
 * issue #72 (the table that groups today's call sites into resources) — German context labels and
 * relation words verbatim, only the backticked action keys of the "Aktionen" column. It must NEVER
 * be derived from the catalog (D-12): an expected list computed from the thing under test cannot
 * fail. Extending the catalog beyond the issue table means extending `ISSUE_72_TABLE` deliberately,
 * together with the ticket that justifies the new resource or action.
 *
 * What this file does NOT check: which reach each action gets. That assignment is checked by
 * `src/__tests__/permission-site-mapping.test.ts` against `docs/permissions.md`, where every
 * catalog permission has exactly one described row.
 *
 * DB-free: no Prisma client, no app build (D-13).
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  PERMISSION_REACHES,
  PERMISSION_RELATIONS,
  permissionKey,
} from "../permission-catalog";
import * as platform from "../index";

// ── Independent expected list (transcribed from issue #72, never from the catalog) ──────────

type IssueContextLabel =
  | "Unterbau"
  | "Zeiterfassung"
  | "Abwesenheiten"
  | "Arbeitszeitkonto"
  | "Schichtplanung"
  | "Komposition";

interface IssueTableRow {
  readonly resource: string;
  readonly context: IssueContextLabel;
  readonly relation: "Person" | "Mandant";
  readonly actions: readonly string[];
}

const ISSUE_72_TABLE: readonly IssueTableRow[] = [
  {
    resource: "employee",
    context: "Unterbau",
    relation: "Person",
    actions: ["read", "create", "update", "manage-access", "anonymize", "import", "update-avatar"],
  },
  { resource: "contract", context: "Unterbau", relation: "Person", actions: ["read", "update"] },
  {
    resource: "tenant-settings",
    context: "Unterbau",
    relation: "Mandant",
    actions: ["read", "update"],
  },
  { resource: "api-key", context: "Unterbau", relation: "Mandant", actions: ["manage"] },
  { resource: "audit-log", context: "Unterbau", relation: "Mandant", actions: ["read"] },
  { resource: "holiday", context: "Unterbau", relation: "Mandant", actions: ["manage"] },
  { resource: "salon", context: "Unterbau", relation: "Mandant", actions: ["read", "manage"] },
  { resource: "role", context: "Unterbau", relation: "Mandant", actions: ["read", "manage"] },
  { resource: "role-assignment", context: "Unterbau", relation: "Mandant", actions: ["manage"] },
  {
    resource: "time-entry",
    context: "Zeiterfassung",
    relation: "Person",
    actions: ["read", "create", "update", "delete", "revalidate", "import"],
  },
  {
    resource: "retro-request",
    context: "Zeiterfassung",
    relation: "Person",
    actions: ["read", "create", "approve"],
  },
  {
    resource: "presence-source",
    context: "Zeiterfassung",
    relation: "Mandant",
    actions: ["manage"],
  },
  { resource: "terminal", context: "Zeiterfassung", relation: "Mandant", actions: ["manage"] },
  {
    resource: "leave-request",
    context: "Abwesenheiten",
    relation: "Person",
    actions: ["read", "create", "approve", "correct", "attest", "cancel"],
  },
  {
    resource: "section9",
    context: "Abwesenheiten",
    relation: "Person",
    actions: ["read", "upload", "decide"],
  },
  {
    resource: "leave-entitlement",
    context: "Abwesenheiten",
    relation: "Person",
    actions: ["read", "update"],
  },
  {
    resource: "leave-config",
    context: "Abwesenheiten",
    relation: "Mandant",
    actions: ["read", "manage"],
  },
  {
    resource: "company-shutdown",
    context: "Abwesenheiten",
    relation: "Mandant",
    actions: ["manage"],
  },
  {
    resource: "vocational-school",
    context: "Abwesenheiten",
    relation: "Person",
    actions: ["read", "manage"],
  },
  {
    resource: "overtime",
    context: "Arbeitszeitkonto",
    relation: "Person",
    actions: ["read", "settle", "set-opening-balance"],
  },
  {
    resource: "month-close",
    context: "Arbeitszeitkonto",
    relation: "Person",
    actions: ["read", "close", "unlock", "close-year"],
  },
  { resource: "shift", context: "Schichtplanung", relation: "Person", actions: ["read", "plan"] },
  { resource: "shift-config", context: "Schichtplanung", relation: "Mandant", actions: ["manage"] },
  {
    resource: "shift-pattern",
    context: "Schichtplanung",
    relation: "Person",
    actions: ["read", "update"],
  },
  {
    resource: "availability",
    context: "Schichtplanung",
    relation: "Person",
    actions: ["read", "update"],
  },
  { resource: "integration", context: "Schichtplanung", relation: "Mandant", actions: ["manage"] },
  {
    resource: "report",
    context: "Komposition",
    relation: "Person",
    actions: ["read", "export", "notify"],
  },
  { resource: "team-overview", context: "Komposition", relation: "Person", actions: ["read"] },
];

/** The issue's German context label → the code directory name the catalog uses (D-05). */
const CONTEXT_DIRECTORY: Readonly<Record<IssueContextLabel, string>> = {
  Unterbau: "platform",
  Zeiterfassung: "time-tracking",
  Abwesenheiten: "absence",
  Arbeitszeitkonto: "working-time-account",
  Schichtplanung: "scheduling",
  Komposition: "composition",
};

/** The issue's "Bezug" word → the catalog's relation identifier (D-04). */
const RELATION_VALUE: Readonly<Record<IssueTableRow["relation"], string>> = {
  Person: "PERSON",
  Mandant: "MANDANT",
};

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const RESOURCE_TABLE: Readonly<Record<string, { context: string; relation: string }>> =
  PERMISSION_RESOURCES;

function isOwnKey(obj: object, key: unknown): boolean {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

describe("Phase 72b — permission catalog (Issue #72)", () => {
  it("reach vocabulary: exactly EIGENE and ZUGEWIESEN, no third value (AK-72-3, D-03)", () => {
    expect([...PERMISSION_REACHES]).toEqual(["EIGENE", "ZUGEWIESEN"]);
    expect(PERMISSIONS.length).toBeGreaterThan(0);

    const reaches: readonly string[] = PERMISSION_REACHES;
    const violations = PERMISSIONS.filter((p) => !reaches.includes(p.reach)).map(
      (p) => `${p.resource}:${p.action}: reach "${String(p.reach)}" is not in PERMISSION_REACHES`,
    );
    expect(violations).toEqual([]);

    const used = [...new Set(PERMISSIONS.map((p) => p.reach))].sort();
    expect(used).toEqual(["EIGENE", "ZUGEWIESEN"]);
  });

  it("unique triple: no resource × action × reach occurs twice (AK-72-2)", () => {
    const keys = PERMISSIONS.map((p) => permissionKey(p));
    expect(keys.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    expect([...duplicates]).toEqual([]);

    const malformed = keys.filter((k) => !/^[a-z0-9-]+:[a-z0-9-]+:(EIGENE|ZUGEWIESEN)$/.test(k));
    expect(malformed).toEqual([]);
  });

  it("MANDANT has no EIGENE: tenant-wide resources carry ZUGEWIESEN only (AK-72-4, D-04)", () => {
    expect([...PERMISSION_RELATIONS]).toEqual(["PERSON", "MANDANT"]);

    const relations: readonly string[] = PERMISSION_RELATIONS;
    const badRelation = Object.entries(RESOURCE_TABLE)
      .filter(([, r]) => !relations.includes(r.relation))
      .map(([key, r]) => `${key}: relation "${r.relation}" is not in PERMISSION_RELATIONS`);
    expect(badRelation).toEqual([]);

    const ownOnTenant = PERMISSIONS.filter(
      (p) => RESOURCE_TABLE[p.resource]?.relation === "MANDANT" && p.reach === "EIGENE",
    ).map((p) => `${permissionKey(p)}: MANDANT resource with reach EIGENE`);
    expect(ownOnTenant).toEqual([]);
  });

  it("one resource per permission: exactly one known resource, no other keys (AK-72-7)", () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);

    const violations: string[] = [];
    PERMISSIONS.forEach((p, i) => {
      const keys = Object.keys(p).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["action", "reach", "resource"])) {
        violations.push(`PERMISSIONS[${i}]: keys ${JSON.stringify(keys)}`);
      }
      if (typeof p.resource !== "string" || !isOwnKey(PERMISSION_RESOURCES, p.resource)) {
        violations.push(
          `PERMISSIONS[${i}]: resource ${JSON.stringify(p.resource)} is not one key of PERMISSION_RESOURCES`,
        );
      }
    });
    expect(violations).toEqual([]);

    // Contracts, saldo and month close stay separable from daily times (#76, DSGVO Art. 5 (1) c).
    for (const key of ["contract", "overtime", "month-close", "time-entry"]) {
      expect(isOwnKey(PERMISSION_RESOURCES, key), `${key} is a resource`).toBe(true);
    }
  });

  it("catalog equals the issue #72 table: every resource and action, both directions (AK-72-5, D-12)", () => {
    const violations: string[] = [];
    const tableByResource = new Map(ISSUE_72_TABLE.map((row) => [row.resource, row]));
    const catalogResources = Object.keys(RESOURCE_TABLE);

    for (const row of ISSUE_72_TABLE) {
      if (!isOwnKey(RESOURCE_TABLE, row.resource)) {
        violations.push(`${row.resource}: in the issue table but not in PERMISSION_RESOURCES`);
      }
    }
    for (const key of catalogResources) {
      if (!tableByResource.has(key)) {
        violations.push(`${key}: in PERMISSION_RESOURCES but not in the issue table`);
      }
    }

    for (const row of ISSUE_72_TABLE) {
      const entry = RESOURCE_TABLE[row.resource];
      if (!entry) continue;
      if (entry.context !== CONTEXT_DIRECTORY[row.context]) {
        violations.push(
          `${row.resource}: context "${entry.context}" but the issue table says "${row.context}" (${CONTEXT_DIRECTORY[row.context]})`,
        );
      }
      if (entry.relation !== RELATION_VALUE[row.relation]) {
        violations.push(
          `${row.resource}: relation "${entry.relation}" but the issue table says "${row.relation}"`,
        );
      }

      const catalogActions = new Set(
        PERMISSIONS.filter((p) => p.resource === row.resource).map((p) => p.action),
      );
      for (const action of row.actions) {
        if (!catalogActions.has(action)) {
          violations.push(
            `${row.resource}: action "${action}" in the issue table but not in PERMISSIONS`,
          );
        }
      }
      for (const action of catalogActions) {
        if (!row.actions.includes(action)) {
          violations.push(
            `${row.resource}: action "${action}" in PERMISSIONS but not in the issue table`,
          );
        }
      }
    }

    // A permission whose resource is missing from both lists would slip past the loops above.
    for (const p of PERMISSIONS) {
      if (!tableByResource.has(p.resource)) {
        violations.push(`${permissionKey(p)}: resource not in the issue table`);
      }
    }

    expect(ISSUE_72_TABLE.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("export surface: contexts/platform/index.ts re-exports the same objects (AK-72-1)", () => {
    expect(platform.PERMISSIONS).toBe(PERMISSIONS);
    expect(platform.PERMISSION_RESOURCES).toBe(PERMISSION_RESOURCES);
    expect(platform.PERMISSION_REACHES).toBe(PERMISSION_REACHES);
    expect(platform.PERMISSION_RELATIONS).toBe(PERMISSION_RELATIONS);
    expect(platform.permissionKey).toBe(permissionKey);
  });
});
