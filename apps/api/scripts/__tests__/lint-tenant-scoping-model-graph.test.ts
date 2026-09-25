/**
 * Phase 204 Plan 01 — tests for lint-tenant-scoping-model-graph.ts.
 *
 * DB-free: the live-DMMF assertions import `Prisma` from `@clokr/db` (the already-generated
 * client — no database connection, no `main()` to guard), which is what makes those assertions a
 * live check on the actual schema rather than a restatement of a fixture. `classifyModel`'s
 * algorithmic edge cases (list-relation-is-not-a-path, depth limit, cycle) use small hand-built
 * fixtures instead, independent of schema drift.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "@clokr/db";
import {
  buildModelGraph,
  classifyModel,
  delegateName,
  type DmmfModel,
} from "../lint-tenant-scoping-model-graph";

const liveModels = Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[];

// The 20 models measured directly against schema.prisma (204-RESEARCH.md §Schema Derivation,
// D-19; AccessRole added Phase 73b, Issue #73; Salon added Phase 64b, Issue #64; RoleAssignment
// added Phase 74b, Issue #74; SalonCoupling added Phase 65b, Issue #65; EmployeeSalonAssignment
// added Phase 67b, Issue #67) to carry their own `tenantId` scalar column.
const EXPECTED_OWN_MODELS = [
  "TenantConfig",
  "Employee",
  "LeaveType",
  "SpecialLeaveRule",
  "PublicHoliday",
  "SchoolHolidayPeriod",
  "TerminalApiKey",
  "PresenceSource",
  "PresenceDevice",
  "ApiKey",
  "AccessRole",
  "PhorestStaffMapping",
  "PhorestSyncRun",
  "CompanyShutdown",
  "ShiftTemplate",
  "CoverageRule",
  "Salon",
  "RoleAssignment",
  "SalonCoupling",
  "EmployeeSalonAssignment",
].sort();

describe("delegateName", () => {
  it("lowercases only the first character", () => {
    expect(delegateName("TimeEntry")).toBe("timeEntry");
    expect(delegateName("ApiKey")).toBe("apiKey");
  });
});

describe("classifyModel (live DMMF from @clokr/db)", () => {
  it("classifies a model with its own tenantId scalar as own", () => {
    expect(classifyModel("Employee", liveModels)).toEqual({ kind: "own" });
    expect(classifyModel("TenantConfig", liveModels)).toEqual({ kind: "own" });
    // Phase 64b (issue #64): Salon carries its own tenantId scalar column.
    expect(classifyModel("Salon", liveModels)).toEqual({ kind: "own" });
    // Phase 67b (issue #67): EmployeeSalonAssignment carries its own tenantId scalar column.
    expect(classifyModel("EmployeeSalonAssignment", liveModels)).toEqual({ kind: "own" });
  });

  it("D-18: classifies Shift as relation via employee, NOT own — Issue #204's body is wrong here; schema.prisma:1381-1406 has no Shift.tenantId", () => {
    expect(classifyModel("Shift", liveModels)).toEqual({ kind: "relation", path: ["employee"] });
  });

  // Phase 325 (issue #325): Shift and PhorestAppointment both gained a `salon` relation this
  // phase. `classifyModel` is a first-relation-in-declaration-order BFS (Salon has its own
  // tenantId, so it WOULD short-circuit tenancy classification to `path: ["salon"]` if declared
  // before `employee`) — the `salon` relation field MUST stay declared AFTER `employee` on both
  // models, or every existing `employee: { tenantId }` scoping call in the codebase silently stops
  // counting as scoped. This assertion is the mechanical proof that field order held.
  it("Phase 325: classifies PhorestAppointment as relation via employee, NOT via salon — the new salon relation must stay declared after employee", () => {
    expect(classifyModel("PhorestAppointment", liveModels)).toEqual({
      kind: "relation",
      path: ["employee"],
    });
  });

  // Phase 68b (issue #68): TimeEntry gained a `salon` relation. It must stay declared AFTER
  // `employee`, or Break's two-hop path (timeEntry.employee, checked below) and every existing
  // `employee: { tenantId }` scoping call in the codebase stop counting as scoped.
  it("Phase 68b: classifies TimeEntry as relation via employee, NOT via salon — the new salon relation must stay declared after employee", () => {
    expect(classifyModel("TimeEntry", liveModels)).toEqual({
      kind: "relation",
      path: ["employee"],
    });
  });

  it("classifies Break as relation via timeEntry.employee (two hops, no own tenantId on Break or TimeEntry directly)", () => {
    expect(classifyModel("Break", liveModels)).toEqual({
      kind: "relation",
      path: ["timeEntry", "employee"],
    });
  });

  it("classifies Tenant itself as none — it IS the tenant, and Tenant.config->TenantConfig(own) would otherwise be a circular false positive (see module header)", () => {
    expect(classifyModel("Tenant", liveModels)).toEqual({ kind: "none" });
  });

  it("D-19: classifies RefreshToken as relation via user.employee, deliberately NOT special-cased to none — the over-reach is resolved by the named exception list, never by hand-capping the derivation", () => {
    expect(classifyModel("RefreshToken", liveModels)).toEqual({
      kind: "relation",
      path: ["user", "employee"],
    });
  });

  it("D-19: OtpToken and Notification are ALSO relation-reachable via user.employee, exactly the three models D-07 predicts as named exceptions — this is the exception mechanism at work, not a derivation bug", () => {
    // RefreshToken (not restated here — checked above)
    expect(classifyModel("OtpToken", liveModels)).toEqual({
      kind: "relation",
      path: ["user", "employee"],
    });
    expect(classifyModel("Notification", liveModels)).toEqual({
      kind: "relation",
      path: ["user", "employee"],
    });
  });
});

describe("buildModelGraph (live DMMF from @clokr/db)", () => {
  const graph = buildModelGraph();

  // Merge of Phase 65b (#65: + SalonCoupling, own) and Phase 67b (#67: + EmployeeSalonAssignment,
  // own) — 44 -> 46 models, 18 -> 20 own.
  it("classifies exactly 46 models with no residual category (D-05)", () => {
    expect(graph.size).toBe(46);
    for (const [, tenancy] of graph) {
      expect(["own", "relation", "none"]).toContain(tenancy.kind);
    }
  });

  it("keys the graph by delegate name (camelCase), not the Prisma model name", () => {
    expect(graph.has("shift")).toBe(true);
    expect(graph.has("Shift")).toBe(false);
    expect(graph.has("apiKey")).toBe(true);
  });

  it("marks exactly the 20 measured models as own, by NAME (not just count)", () => {
    const ownDelegateNames = [...graph]
      .filter(([, v]) => v.kind === "own")
      .map(([k]) => k)
      .sort();
    const expectedDelegateNames = EXPECTED_OWN_MODELS.map((n) => delegateName(n)).sort();
    expect(ownDelegateNames).toEqual(expectedDelegateNames);
  });

  it("marks exactly Tenant as none — every other model reaches tenantId directly or via relation", () => {
    const noneNames = [...graph].filter(([, v]) => v.kind === "none").map(([k]) => k);
    expect(noneNames).toEqual(["tenant"]);
  });
});

// ── Hand-built fixtures for classifyModel's algorithmic edge cases ────────────────────────────

function model(name: string, fields: DmmfModel["fields"]): DmmfModel {
  return { name, fields };
}

describe("classifyModel (hand-built fixtures)", () => {
  it("a list relation is NOT a path to a tenant: Root.items[] -> Child(own) does not make Root relation-classified", () => {
    const fixtures: DmmfModel[] = [
      model("Root", [
        { name: "id", kind: "scalar", type: "String" },
        // No matching `itemsId` scalar, and "items" reads as plural -> excluded from traversal.
        { name: "items", kind: "object", type: "Child", relationName: "ChildToRoot" },
      ]),
      model("Child", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "tenantId", kind: "scalar", type: "String" },
      ]),
    ];
    expect(classifyModel("Root", fixtures)).toEqual({ kind: "none" });
  });

  it("a singular back-relation WITHOUT a matching FK scalar is still traversed (the User.employee case)", () => {
    const fixtures: DmmfModel[] = [
      model("Parent", [
        { name: "id", kind: "scalar", type: "String" },
        // No `childId` scalar on Parent — the FK lives on Child — but "child" does not read
        // as plural, so it is treated as the singular inverse side and traversed.
        { name: "child", kind: "object", type: "Child", relationName: "ChildToParent" },
      ]),
      model("Child", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "parentId", kind: "scalar", type: "String" },
        { name: "parent", kind: "object", type: "Parent", relationName: "ChildToParent" },
        { name: "tenantId", kind: "scalar", type: "String" },
      ]),
    ];
    expect(classifyModel("Parent", fixtures)).toEqual({ kind: "relation", path: ["child"] });
  });

  it("respects MAX_RELATION_DEPTH (4): a chain needing a 5th hop to reach an own model classifies as none", () => {
    const fixtures: DmmfModel[] = [
      model("A", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "bId", kind: "scalar", type: "String" },
        { name: "b", kind: "object", type: "B", relationName: "AToB" },
      ]),
      model("B", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "cId", kind: "scalar", type: "String" },
        { name: "c", kind: "object", type: "C", relationName: "BToC" },
      ]),
      model("C", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "dId", kind: "scalar", type: "String" },
        { name: "d", kind: "object", type: "D", relationName: "CToD" },
      ]),
      model("D", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "eId", kind: "scalar", type: "String" },
        { name: "e", kind: "object", type: "E", relationName: "DToE" },
      ]),
      model("E", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "fId", kind: "scalar", type: "String" },
        { name: "f", kind: "object", type: "F", relationName: "EToF" },
      ]),
      model("F", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "tenantId", kind: "scalar", type: "String" },
      ]),
    ];
    // A -> b -> c -> d -> e -> f is 5 hops; MAX_RELATION_DEPTH is 4.
    expect(classifyModel("A", fixtures)).toEqual({ kind: "none" });
  });

  it("reaches an own model at exactly the depth limit (4 hops)", () => {
    const fixtures: DmmfModel[] = [
      model("A", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "bId", kind: "scalar", type: "String" },
        { name: "b", kind: "object", type: "B", relationName: "AToB" },
      ]),
      model("B", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "cId", kind: "scalar", type: "String" },
        { name: "c", kind: "object", type: "C", relationName: "BToC" },
      ]),
      model("C", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "dId", kind: "scalar", type: "String" },
        { name: "d", kind: "object", type: "D", relationName: "CToD" },
      ]),
      model("D", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "tenantId", kind: "scalar", type: "String" },
      ]),
    ];
    // A -> b -> c -> d is exactly 4 hops.
    expect(classifyModel("A", fixtures)).toEqual({ kind: "relation", path: ["b", "c", "d"] });
  });

  it("a mutual cycle between two models with no own tenantId terminates as none, never hangs", () => {
    const fixtures: DmmfModel[] = [
      model("A", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "bId", kind: "scalar", type: "String" },
        { name: "b", kind: "object", type: "B", relationName: "AToB" },
      ]),
      model("B", [
        { name: "id", kind: "scalar", type: "String" },
        { name: "aId", kind: "scalar", type: "String" },
        { name: "a", kind: "object", type: "A", relationName: "AToB" },
      ]),
    ];
    expect(classifyModel("A", fixtures)).toEqual({ kind: "none" });
  });

  it("classifying an unknown model name returns none rather than throwing", () => {
    expect(classifyModel("DoesNotExist", [])).toEqual({ kind: "none" });
  });
});
