// Issue #583 / #854 (D-854-10, D-854-23) - coverage of the audit vocabulary.
//
// The API writes audit rows with an `action` and an `entity` code. Every code it can write needs a
// German label in `packages/types/audit-labels.json` (the ONE vocabulary, read by the web accessor
// `lib/audit/labels.ts` and by the API's CSV), so a new writer without a label fails here instead of
// showing a raw code in the Protokoll.
//
// How the writers are found: every non-test `.ts` file below `apps/api/src` is parsed with the
// TypeScript compiler API; every object literal that has both an `action` and an `entity` property is
// a writer site. Resolved to strings: a string literal, both branches of a conditional, a `const`
// of the same file that holds one of those, and `OPERATOR_AUDIT_ACTIONS.X` (read from
// `operator-audit.ts`). Anything else is a dynamic site and must be named in `DYNAMIC_AUDIT_SITES`
// with a reason. Stated blind spot: a code that only ever travels through such a dynamic site and is
// never written as a literal next to an `entity` is not seen; the register lists those codes by hand.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import auditLabels from "@clokr/types/audit-labels.json";
import { actionLabel, actorKindLabel, entityLabel, exportTypeLabel, fieldLabel } from "../labels";

function webSrcRoot(): string {
  try {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const API_SRC = resolve(webSrcRoot(), "..", "..", "api", "src");
const OPERATOR_AUDIT = join(API_SRC, "contexts", "platform", "operator-audit.ts");

const MIN_FILES = 300;
const MIN_ACTIONS = 90;
const MIN_ENTITIES = 50;

type DynamicSite = {
  /** Path below apps/api/src. */
  file: string;
  /** How many dynamic writer sites the file holds; a change in either direction fails. */
  count: number;
  /** A quoted piece of source that must still occur in the file (stale entries fail). */
  anchor: string;
  reason: string;
  /** Codes the site can pass on that are not guaranteed to be found as literals elsewhere. */
  codes?: { actions?: string[]; entities?: string[] };
};

/**
 * Writer sites whose action or entity is not a literal. Most are relays: a typed `entry` object of
 * a helper whose callers write the literal (those callers are scanned themselves).
 */
const DYNAMIC_AUDIT_SITES: DynamicSite[] = [
  {
    file: "contexts/platform/audit-log-read.ts",
    count: 1,
    anchor: "...(action ? { action } : {}),",
    reason:
      "the read filter of GET /audit-logs and its CSV export (a Prisma where built from the query); no row is written",
  },
  {
    file: "composition/operator-support-ports.ts",
    count: 2,
    anchor: "entity: row.entity",
    reason:
      "a Prisma select (`action: true`) and the read-through of stored rows for the operator support read; no row is written",
  },
  {
    file: "contexts/absence/api/leave.ts",
    count: 2,
    anchor: "action: entry.action",
    reason:
      "audit callback handed to supersedeSection9CreditsOfCancelledRequest(); the entry literal lives in section9-supersede.ts",
    codes: { actions: ["SECTION9_CREDIT_SUPERSEDED"] },
  },
  {
    file: "contexts/absence/entitlement-audit.ts",
    count: 1,
    anchor: 'entity: "LeaveEntitlement"',
    reason: "writeEntitlementAudit(): the action is typed CREATE | UPDATE, callers pass no entity",
    codes: { actions: ["CREATE", "UPDATE"] },
  },
  {
    file: "contexts/absence/leave-days.ts",
    count: 1,
    anchor: 'action: { in: ["CREATE", "UPDATE"] }',
    reason: "a read filter on the audit table, not a writer",
  },
  {
    file: "contexts/platform/api/audit-logs.ts",
    count: 1,
    anchor: "action: filters.action ?? null",
    reason:
      "the EXPORT row of GET /audit-logs/export records the caller's action filter inside newValue; the row's own action is the literal EXPORT",
  },
  {
    file: "contexts/platform/api/employees.ts",
    count: 6,
    anchor: "action: entry.action",
    reason:
      "employment-exit and entitlement audit callbacks; the entry literals live in employment-exit.ts and entitlement-audit.ts",
    codes: { actions: ["CREATE", "UPDATE", "CANCEL", "DELETE", "LEAVE_CORRECTED"] },
  },
  {
    file: "contexts/platform/api/salons.ts",
    count: 1,
    anchor: 'entity: "Salon"',
    reason:
      "auditSalon(): the callers pass literal actions (CREATE, UPDATE, DEACTIVATE, ACTIVATE, END)",
    codes: { actions: ["CREATE", "UPDATE", "DEACTIVATE", "ACTIVATE", "END"] },
  },
  {
    file: "contexts/platform/api/settings.ts",
    count: 3,
    anchor: "action: entry.action",
    reason: "entitlement audit callbacks; the entry literals live in entitlement-audit.ts",
    codes: { actions: ["CREATE", "UPDATE"] },
  },
  {
    file: "contexts/platform/operator-audit.ts",
    count: 2,
    anchor: "action: entry.action",
    reason:
      "the generic operator writers (OperatorAuditLog and its refusal window); callers pass OPERATOR_AUDIT_ACTIONS",
  },
  {
    file: "contexts/platform/operator-tenant-audit.ts",
    count: 1,
    anchor: "action: entry.action",
    reason: "the generic writer of operator-actor rows in the tenant log; callers are scanned",
  },
  {
    file: "contexts/platform/plugins/audit.ts",
    count: 1,
    anchor: "action: params.action",
    reason: "app.audit() itself; every caller is scanned",
  },
  {
    file: "contexts/platform/role-assignment-audit.ts",
    count: 1,
    anchor: 'entity: "RoleAssignment"',
    reason: "auditRoleAssignment(): the action is typed CREATE | UPDATE | DELETE",
    codes: { actions: ["CREATE", "UPDATE", "DELETE"] },
  },
  {
    file: "contexts/platform/salon-assignment-audit.ts",
    count: 1,
    anchor: "action: entry.action",
    reason: "auditSalonAssignment(): callers pass literal actions (CREATE, UPDATE, DELETE, END)",
    codes: { actions: ["CREATE", "UPDATE", "DELETE", "END"] },
  },
  {
    file: "contexts/platform/tenant-provisioning.ts",
    count: 2,
    anchor: "action: entry.action",
    reason: "the provisioning audit port forwards entries of the employee-creation and role code",
    codes: { actions: ["CREATE", "UPDATE", "DELETE"] },
  },
  {
    file: "services/clock/audit-actor.ts",
    count: 1,
    anchor: "action: params.action",
    reason: "emitClockAudit(): the generic clock writer; callers pass literal CLOCK_* codes",
    codes: { actions: ["CLOCK_IN", "CLOCK_OUT", "CLOCK_REOPEN"] },
  },
];

/** Export types written next to `action: "EXPORT"`, plus the one plan 854-06 adds with the CSV route. */
const COMING_EXPORT_TYPES = ["AUDIT_LOG_CSV"];

// ── The scanner ───────────────────────────────────────────────────────────────────────────────

type Collected = {
  actions: Set<string>;
  entities: Set<string>;
  exportTypes: Set<string>;
  /** Dynamic sites per file: line + the source text of the action and entity values. */
  dynamic: { file: string; line: number; action: string; entity: string }[];
};

function emptyCollected(): Collected {
  return { actions: new Set(), entities: new Set(), exportTypes: new Set(), dynamic: [] };
}

/** The string values of `OPERATOR_AUDIT_ACTIONS` (key -> value), read from its const object. */
function operatorActionMap(source: string): Record<string, string> {
  const start = source.indexOf("OPERATOR_AUDIT_ACTIONS = {");
  const end = source.indexOf("} as const;", start);
  const map: Record<string, string> = {};
  if (start === -1 || end === -1) return map;
  for (const m of source.slice(start, end).matchAll(/^\s+([A-Z0-9_]+): "([A-Z0-9_]+)",$/gm)) {
    map[m[1]] = m[2];
  }
  return map;
}

function resolveStrings(
  node: ts.Expression,
  sf: ts.SourceFile,
  operator: Record<string, string>,
  seen: Set<string> = new Set(),
): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return resolveStrings(node.expression, sf, operator, seen);
  }
  if (ts.isConditionalExpression(node)) {
    const a = resolveStrings(node.whenTrue, sf, operator, seen);
    const b = resolveStrings(node.whenFalse, sf, operator, seen);
    return a && b ? [...a, ...b] : null;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "OPERATOR_AUDIT_ACTIONS"
  ) {
    const value = operator[node.name.text];
    return value ? [value] : null;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    let found: string[] | null = null;
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === node.text &&
        n.initializer &&
        ts.isVariableDeclarationList(n.parent) &&
        (n.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        found = resolveStrings(n.initializer, sf, operator, seen);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }
  return null;
}

function collectFromSource(
  text: string,
  fileName: string,
  operator: Record<string, string>,
  out: Collected = emptyCollected(),
): Collected {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, ts.Expression>();
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.text, p.name);
      }
      const actionNode = props.get("action");
      const entityNode = props.get("entity");
      if (actionNode && entityNode) {
        const actions = resolveStrings(actionNode, sf, operator);
        const entities = resolveStrings(entityNode, sf, operator);
        actions?.forEach((a) => out.actions.add(a));
        entities?.forEach((e) => out.entities.add(e));
        if (!actions || !entities) {
          out.dynamic.push({
            file: fileName,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            action: actionNode.getText(sf),
            entity: entityNode.getText(sf),
          });
        }
        if (actions?.length === 1 && actions[0] === "EXPORT") {
          const newValue = props.get("newValue");
          if (newValue && ts.isObjectLiteralExpression(newValue)) {
            for (const p of newValue.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "type") {
                resolveStrings(p.initializer, sf, operator)?.forEach((t) => out.exportTypes.add(t));
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (extname(full) === ".ts" && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = walk(API_SRC);
const operator = operatorActionMap(readFileSync(OPERATOR_AUDIT, "utf8"));
const collected = emptyCollected();
const fileText = new Map<string, string>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(API_SRC, file);
  fileText.set(rel, text);
  collectFromSource(text, rel, operator, collected);
}

const labels = auditLabels as {
  fallback: string;
  fieldFallback: string;
  actions: Record<string, string>;
  entities: Record<string, string>;
  exportTypes: Record<string, string>;
  actors: Record<string, string>;
  fields: Record<string, Record<string, string>>;
};

// ── The scanner itself (controls) ─────────────────────────────────────────────────────────────

describe("audit writer scanner (controls)", () => {
  const ops = { SOME_ACTION: "SOME_ACTION" };

  it("reads literals, conditionals, same-file consts and operator constants", () => {
    const out = collectFromSource(
      `const decided = ok ? "A_ONE" : "A_TWO";
       app.audit({ action: decided, entity: "E_ONE" });
       app.audit({ action: "B", entity: flag ? "E_TWO" : "E_THREE" });
       record({ action: OPERATOR_AUDIT_ACTIONS.SOME_ACTION, entity: "E_FOUR" });`,
      "fixture.ts",
      ops,
    );
    expect([...out.actions].sort()).toEqual(["A_ONE", "A_TWO", "B", "SOME_ACTION"]);
    expect([...out.entities].sort()).toEqual(["E_FOUR", "E_ONE", "E_THREE", "E_TWO"]);
    expect(out.dynamic).toEqual([]);
  });

  it("reports a non-literal site as dynamic and ignores objects without both keys", () => {
    const out = collectFromSource(
      `app.audit({ action: entry.action, entity: "X" });
       const perm = { action: "approve", resource: "leave" };`,
      "fixture.ts",
      ops,
    );
    expect(out.dynamic).toHaveLength(1);
    expect(out.dynamic[0].action).toBe("entry.action");
    expect(out.actions.has("approve")).toBe(false);
  });

  it("collects the type of an EXPORT writer", () => {
    const out = collectFromSource(
      `app.audit({ action: "EXPORT", entity: "Report", newValue: { type: csv ? "ONE_CSV" : "TWO_PDF", year } });`,
      "fixture.ts",
      ops,
    );
    expect([...out.exportTypes].sort()).toEqual(["ONE_CSV", "TWO_PDF"]);
  });

  it("reads the operator action map from its const object only", () => {
    const map = operatorActionMap(
      `export const OPERATOR_AUDIT_ACTIONS = {\n  FIRST: "FIRST",\n  SECOND: "SECOND",\n} as const;\nconst CLASS = {\n  FIRST: "AUTH_EVENT",\n};`,
    );
    expect(map).toEqual({ FIRST: "FIRST", SECOND: "SECOND" });
  });
});

// ── The walk is not vacuous ───────────────────────────────────────────────────────────────────

describe("audit writer walk (anti-vacuity)", () => {
  it(`walked at least ${MIN_FILES} files and found the known code floors`, () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(collected.actions.size).toBeGreaterThanOrEqual(MIN_ACTIONS);
    expect(collected.entities.size).toBeGreaterThanOrEqual(MIN_ENTITIES);
    expect(Object.keys(operator).length).toBeGreaterThan(20);
    expect(collected.exportTypes.size).toBeGreaterThanOrEqual(6);
  });

  it("knows every dynamic site (register has no gaps and no stale entries)", () => {
    const perFile = new Map<string, number>();
    for (const site of collected.dynamic) {
      perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);
    }
    const registered = new Map(DYNAMIC_AUDIT_SITES.map((s) => [s.file, s]));
    for (const [file, count] of perFile) {
      const entry = registered.get(file);
      expect(
        entry,
        `${file}: ${count} dynamic audit site(s) not in DYNAMIC_AUDIT_SITES`,
      ).toBeDefined();
      expect(count, `${file}: dynamic site count changed`).toBe(entry!.count);
    }
    for (const entry of DYNAMIC_AUDIT_SITES) {
      expect(perFile.has(entry.file), `${entry.file}: stale DYNAMIC_AUDIT_SITES entry`).toBe(true);
      const text = fileText.get(entry.file) ?? "";
      expect(text.includes(entry.anchor), `${entry.file}: anchor no longer occurs`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });
});

// ── Coverage: every code has a label ──────────────────────────────────────────────────────────

describe("audit vocabulary covers the API's writers", () => {
  const registeredActions = DYNAMIC_AUDIT_SITES.flatMap((s) => s.codes?.actions ?? []);
  const registeredEntities = DYNAMIC_AUDIT_SITES.flatMap((s) => s.codes?.entities ?? []);

  it("labels every action the API writes", () => {
    const missing = [...new Set([...collected.actions, ...registeredActions])].filter(
      (code) => !(code in labels.actions),
    );
    expect(missing, `actions without a label in packages/types/audit-labels.json`).toEqual([]);
  });

  it("labels every entity the API writes", () => {
    const missing = [...new Set([...collected.entities, ...registeredEntities])].filter(
      (code) => !(code in labels.entities),
    );
    expect(missing, `entities without a label in packages/types/audit-labels.json`).toEqual([]);
  });

  it("labels every EXPORT type (including the coming Protokoll CSV)", () => {
    const missing = [...new Set([...collected.exportTypes, ...COMING_EXPORT_TYPES])].filter(
      (code) => !(code in labels.exportTypes),
    );
    expect(missing, `export types without a label`).toEqual([]);
  });

  it("has no label that is a raw code in disguise", () => {
    const all: [string, Record<string, string>][] = [
      ["actions", labels.actions],
      ["entities", labels.entities],
      ["exportTypes", labels.exportTypes],
      ["actors", labels.actors],
      ...Object.entries(labels.fields).map(
        ([entity, f]) => [`fields.${entity}`, f] as [string, Record<string, string>],
      ),
    ];
    for (const [group, map] of all) {
      for (const [code, label] of Object.entries(map)) {
        expect(label.trim().length, `${group}.${code} is empty`).toBeGreaterThan(0);
        // A plain capitalised word ("Salon") is its own German label; every other code must differ.
        if (!/^[A-Z][a-z]+$/.test(code)) {
          expect(label, `${group}.${code} equals its code`).not.toBe(code);
        }
        expect(
          /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/.test(label),
          `${group}.${code}: UPPER_SNAKE token in "${label}"`,
        ).toBe(false);
      }
    }
  });

  it("states the fallbacks and the two non-user actors", () => {
    expect(labels.fallback).toBe("Sonstige Änderung");
    expect(labels.fieldFallback.length).toBeGreaterThan(0);
    expect(labels.actors.operator).toBe("Betreiber");
    expect(labels.actors.system).toBe("System");
  });

  it("labels the fields of the main entities", () => {
    for (const entity of [
      "TimeEntry",
      "LeaveRequest",
      "Employee",
      "WorkSchedule",
      "TenantConfig",
      "Salon",
      "RoleAssignment",
      "LeaveEntitlement",
      "Absence",
      "Shift",
    ]) {
      expect(Object.keys(labels.fields[entity] ?? {}).length, `fields.${entity}`).toBeGreaterThan(
        0,
      );
    }
    expect(Object.keys(labels.fields["*"]).length).toBeGreaterThan(10);
    expect(Object.keys(labels.fields.TenantConfig).length).toBeGreaterThan(100);
  });
});

// ── The web accessor is total ────────────────────────────────────────────────────────────────

describe("audit label accessors", () => {
  it("pass known codes through", () => {
    expect(actionLabel("CREATE")).toBe("Angelegt");
    expect(actionLabel("EXPORT")).toBe("Exportiert");
    expect(entityLabel("TimeEntry")).toBe("Zeiteintrag");
    expect(exportTypeLabel("DATEV")).toBe("DATEV-Export");
    expect(actorKindLabel("operator")).toBe("Betreiber");
    expect(actorKindLabel("system")).toBe("System");
  });

  it("never show an unknown code raw: they read the fallback", () => {
    expect(actionLabel("SOME_NEW_ACTION")).toBe("Sonstige Änderung");
    expect(entityLabel("SomeNewEntity")).toBe("Sonstige Änderung");
    expect(exportTypeLabel("SOME_NEW_EXPORT")).toBe("Sonstige Änderung");
    expect(actionLabel("")).toBe("Sonstige Änderung");
  });

  it("does not read inherited object members as codes", () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(actionLabel(code)).toBe("Sonstige Änderung");
      expect(entityLabel(code)).toBe("Sonstige Änderung");
      expect(fieldLabel(code, code)).toBe(labels.fieldFallback);
    }
  });

  it("resolves a field from its entity, then from the common fields, then neutrally", () => {
    expect(fieldLabel("TimeEntry", "breakMinutes")).toBe("Pause in Minuten");
    expect(fieldLabel("TimeEntry", "note")).toBe("Notiz");
    expect(fieldLabel("UnknownEntity", "note")).toBe("Notiz");
    expect(fieldLabel("TimeEntry", "someNewColumn")).toBe(labels.fieldFallback);
    expect(fieldLabel("UnknownEntity", "someNewColumn")).toBe("Weiteres Feld");
  });
});
