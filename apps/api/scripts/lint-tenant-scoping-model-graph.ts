/**
 * Phase 204 Plan 01 — DMMF-derived model classification for the `lint:tenant-scoping` gate
 * (D-05, D-19): which of the 41 Prisma models are tenant-scoped, and by what path.
 *
 * Mirrors the "Part A: exported pure helpers (DB-free, unit-testable)" split of
 * apps/api/scripts/audit-workdays-vs-day-hours.ts. There is no "Part B" here — no DB, no CLI —
 * but the pure-function discipline is the same: every export below takes its model list as a
 * parameter, so tests never depend on a freshly generated Prisma client.
 *
 * ── Deviation from the plan's assumed DMMF shape (measured, apps/api, Prisma 7.6.0) ──────────
 * The 204-01-PLAN.md interfaces section assumed `Prisma.dmmf.datamodel.models[].fields[]` carries
 * an `isList: boolean`. Measured directly against the real, already-generated `@clokr/db` package
 * (`Object.getOwnPropertyNames` on a live field object returns exactly `["name","kind","type"]`,
 * plus `relationName` on object-kind fields) — this Prisma version's runtime-exported DMMF is a
 * deliberately minimal `runtimeDataModel`, NOT the full introspection DMMF `@prisma/internals`
 * produces. It carries no cardinality (`isList`) and no uniqueness (`isUnique`) information at
 * all. `@prisma/internals` remains explicitly out of scope (D-19) and schema-text parsing remains
 * explicitly forbidden ("Don't Hand-Roll" in 204-RESEARCH.md) — so cardinality has to be derived
 * structurally from the fields Prisma DOES export.
 *
 * `isSingularRelationField()` below does that: an object field on model M is a "belongs-to" edge
 * (safe to traverse looking for a `tenantId`) if EITHER (a) M also declares a scalar field named
 * `${field.name}Id` — the side holding the foreign key is always singular — or, for the inverse
 * ("back-relation") side that carries no FK column of its own, (b) the field's name does not read
 * as a plural collection. (a) alone is not sufficient: `User.employee` is a genuine one-to-one
 * back-relation with NO `employeeId` scalar on `User` (the FK lives on `Employee.userId` instead;
 * `packages/db/prisma/schema.prisma:246`), and both the plan's own required test case
 * (`RefreshToken` -> `["user","employee"]`) and 204-RESEARCH.md's independently measured
 * depth-1/depth-2 table depend on that edge being followed.
 *
 * This two-part rule was verified against every one of this schema's 52 relations and all 104
 * relation fields by cross-checking the DMMF-derived answer against the schema source text
 * (`Type[]` vs `Type`/`Type?`) for every field, and by running the full classification of all 41
 * models and diffing the result against 204-RESEARCH.md's §Schema Derivation table byte-for-byte
 * — exact match, 15 own / 25 relation / 1 none (see the `TENANT_ROOT_MODEL` note below).
 * The rule has exactly two known false positives on this schema — `LeaveRequest.section9AsSick`
 * and `LeaveRequest.section9AsVacation` are `Section9Credit[]` list fields whose names do not read
 * as plural — but both are FK-less back-relations that BFS only ever enqueues as an ADDITIONAL,
 * not the sole, candidate path; per D-19's own stated tolerance, over-inclusion here can only
 * make an unrelated model *more* reachable, never flip an `own`/`relation` model to `none`, and
 * the full byte-for-byte match above confirms neither exception changed any of the 41 verdicts.
 *
 * ── Tenant itself (D-05, D-18, ADR 0001) ──────────────────────────────────────────────────────
 * `Tenant` is excluded from the BFS target set by name, not left to fall out of the algorithm.
 * Reason, measured: `Tenant.config TenantConfig?` (schema.prisma:25) is a genuine singular
 * relation, and `TenantConfig` is itself one of the 15 models with its own `tenantId` scalar —
 * so an unmodified BFS finds `Tenant -> config -> TenantConfig(own)` and reports Tenant as
 * "relation", which is circular nonsense: `TenantConfig.tenantId` is a foreign key POINTING BACK
 * to the very `Tenant` row BFS started from. `Tenant` is the multi-tenancy root (ADR 0001,
 * "Unterbau") — there is exactly one such model in this schema, it will not grow into a
 * hand-maintained list the way D-05 warns against, and 204-RESEARCH.md's own §Schema Derivation
 * table treats it identically: 15 own models plus "the remaining 25 non-Tenant models" BFS-walked,
 * Tenant kept out of the walk by construction.
 */
import { Prisma } from "@clokr/db";

// ── Local, narrow DMMF types (see the deviation note above for why `isList` is absent) ────────

export type DmmfField = {
  name: string;
  kind: "scalar" | "object" | "enum" | "unsupported";
  type: string;
  relationName?: string;
};

export type DmmfModel = {
  name: string;
  fields: readonly DmmfField[];
};

/** The multi-tenancy root itself. See the header comment for why it is excluded from BFS. */
const TENANT_ROOT_MODEL = "Tenant";

/** D-05/D-19: how far BFS may walk singular relations before giving up (stated in the plan). */
const MAX_RELATION_DEPTH = 4;

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────

/** "TimeEntry" -> "timeEntry". Prisma's own delegate-name rule: lowercase the first character. */
export function delegateName(modelName: string): string {
  return modelName.length === 0 ? modelName : modelName[0].toLowerCase() + modelName.slice(1);
}

function findModel(modelName: string, models: readonly DmmfModel[]): DmmfModel | undefined {
  return models.find((m) => m.name === modelName);
}

function hasOwnTenantId(model: DmmfModel): boolean {
  return model.fields.some((f) => f.kind === "scalar" && f.name === "tenantId");
}

/** Does `model` declare a scalar foreign-key field for this object field, e.g. `employeeId` for `employee`? */
function hasMatchingForeignKey(model: DmmfModel, field: DmmfField): boolean {
  const fkName = `${field.name}Id`;
  return model.fields.some((f) => f.kind === "scalar" && f.name === fkName);
}

/** Plural-collection heuristic for FK-less back-relation fields — see the header comment. */
function looksLikePluralCollection(fieldName: string): boolean {
  return /s$/i.test(fieldName) && !/ss$/i.test(fieldName);
}

/**
 * Is this object field safe to traverse as a "belongs-to-one" edge? True when the field's own
 * model holds the foreign-key scalar for it (always singular), or — for the FK-less inverse side
 * of a relation — when the field's name does not look like a plural collection.
 */
function isSingularRelationField(model: DmmfModel, field: DmmfField): boolean {
  if (hasMatchingForeignKey(model, field)) return true;
  return !looksLikePluralCollection(field.name);
}

export type ModelTenancy =
  | { kind: "own" }
  | { kind: "relation"; path: readonly string[] }
  | { kind: "none" };

/**
 * Classify one model given the full model list (D-05/D-18/D-19). Pure — no DMMF import, no I/O.
 * BFS over singular object fields only, each model visited at most once, depth-limited to
 * `MAX_RELATION_DEPTH`. BFS guarantees the shortest path is returned.
 */
export function classifyModel(modelName: string, models: readonly DmmfModel[]): ModelTenancy {
  if (modelName === TENANT_ROOT_MODEL) return { kind: "none" };

  const root = findModel(modelName, models);
  if (!root) return { kind: "none" };
  if (hasOwnTenantId(root)) return { kind: "own" };

  const visited = new Set<string>([modelName]);
  let frontier: Array<{ model: string; path: readonly string[] }> = [
    { model: modelName, path: [] },
  ];

  for (let depth = 0; depth < MAX_RELATION_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ model: string; path: readonly string[] }> = [];
    for (const node of frontier) {
      const current = findModel(node.model, models);
      if (!current) continue;
      for (const field of current.fields) {
        if (field.kind !== "object") continue;
        if (field.type === TENANT_ROOT_MODEL) continue; // never re-enter the tenant root
        if (!isSingularRelationField(current, field)) continue;
        if (visited.has(field.type)) continue;
        visited.add(field.type);

        const newPath = [...node.path, field.name];
        const target = findModel(field.type, models);
        if (target && hasOwnTenantId(target)) {
          return { kind: "relation", path: newPath };
        }
        next.push({ model: field.type, path: newPath });
      }
    }
    frontier = next;
  }

  return { kind: "none" };
}

export type ModelGraph = ReadonlyMap<string, ModelTenancy>;

/**
 * Builds the full classification graph, keyed by DELEGATE name (camelCase), for every model.
 * Defaults to the live `Prisma.dmmf.datamodel.models` when no argument is given; accepts an
 * injected list so tests never depend on the generated client being fresh.
 */
export function buildModelGraph(models?: readonly DmmfModel[]): ModelGraph {
  const source = models ?? (Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[]);
  const graph = new Map<string, ModelTenancy>();
  for (const model of source) {
    graph.set(delegateName(model.name), classifyModel(model.name, source));
  }
  return graph;
}
