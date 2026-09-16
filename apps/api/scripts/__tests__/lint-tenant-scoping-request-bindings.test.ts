/**
 * Phase 204 Plan 01 — tests for lint-tenant-scoping-request-bindings.ts.
 *
 * DB-free: every fixture is an inline source string parsed by THIS test file — the module under
 * test never calls the parser itself (it consumes an AST handed to it by the caller). Keeping
 * fixtures inline (rather than importing real route files) keeps these tests independent of the
 * real routes drifting.
 */
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import {
  enclosingHandler,
  collectRequestBindings,
  isPrincipalExpression,
} from "../lint-tenant-scoping-request-bindings";
import type { RequestBindings } from "../lint-tenant-scoping-types";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
}

function findFirst(root: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (predicate(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** Finds the enclosing function-declaring node for the given fixture's ONLY function, by taking
 * the first function-like node found — enough for these single-handler fixtures. */
function firstFunctionLike(sourceFile: ts.SourceFile): ts.Node {
  const node = findFirst(
    sourceFile,
    (n) =>
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n),
  );
  if (!node) throw new Error("fixture has no function-like node");
  return node;
}

function bindingsOf(source: string): RequestBindings {
  const sourceFile = parse(source);
  const fn = firstFunctionLike(sourceFile);
  return collectRequestBindings(fn, sourceFile);
}

function parseExpression(exprSource: string): { expr: ts.Expression; sourceFile: ts.SourceFile } {
  const sourceFile = parse(`const __probe = ${exprSource};`);
  const stmt = sourceFile.statements[0] as ts.VariableStatement;
  const decl = stmt.declarationList.declarations[0];
  return { expr: decl.initializer as ts.Expression, sourceFile };
}

function emptyBindings(): RequestBindings {
  return { clientSupplied: new Set(), principalObjects: new Set(), principalFields: new Map() };
}

// ── collectRequestBindings: client-supplied identifiers (D-12) ────────────────────────────────

describe("collectRequestBindings — client-supplied identifiers", () => {
  it("`const { id } = req.params as { id: string };` -> id is client-supplied (time-entries.ts:677 form)", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const { id } = req.params as { id: string };
      }
    `);
    expect(bindings.clientSupplied.has("id")).toBe(true);
  });

  it("`const { id } = idParamSchema.parse(req.params);` -> id is client-supplied (time-entries.ts:1524 form)", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const { id } = idParamSchema.parse(req.params);
      }
    `);
    expect(bindings.clientSupplied.has("id")).toBe(true);
  });

  it("`const body = updateSchema.parse(req.body);` -> body is client-supplied", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const body = updateSchema.parse(req.body);
      }
    `);
    expect(bindings.clientSupplied.has("body")).toBe(true);
  });

  it("`const q = querySchema.parse(req.query);` -> q is client-supplied", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const q = querySchema.parse(req.query);
      }
    `);
    expect(bindings.clientSupplied.has("q")).toBe(true);
  });

  it("`const { employeeId, from } = req.query as {...};` -> both names are client-supplied", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const { employeeId, from } = req.query as { employeeId: string; from: string };
      }
    `);
    expect(bindings.clientSupplied.has("employeeId")).toBe(true);
    expect(bindings.clientSupplied.has("from")).toBe(true);
  });

  it("one-hop propagation: `const employeeId = body.employeeId;` is client-supplied because body is", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const body = updateSchema.parse(req.body);
        const employeeId = body.employeeId;
      }
    `);
    expect(bindings.clientSupplied.has("employeeId")).toBe(true);
  });

  it("negative: `const employeeId = existing.employeeId;` is NOT client-supplied — existing came from a fetched row, not the request", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const employeeId = existing.employeeId;
      }
    `);
    expect(bindings.clientSupplied.has("employeeId")).toBe(false);
  });
});

// ── collectRequestBindings: principal (req.user) aliasing ─────────────────────────────────────

describe("collectRequestBindings — req.user aliasing", () => {
  it("`const user = req.user;` -> user is a principal object alias (time-entries.ts:875 form)", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const user = req.user;
      }
    `);
    expect(bindings.principalObjects.has("user")).toBe(true);
  });

  it("`const tenantId = req.user.tenantId;` -> tenantId maps to the principal field tenantId (shifts.ts:786 form)", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const tenantId = req.user.tenantId;
      }
    `);
    expect(bindings.principalFields.get("tenantId")).toBe("tenantId");
  });

  it("`const { tenantId, employeeId } = req.user;` -> both map to their own field name", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const { tenantId, employeeId } = req.user;
      }
    `);
    expect(bindings.principalFields.get("tenantId")).toBe("tenantId");
    expect(bindings.principalFields.get("employeeId")).toBe("employeeId");
  });

  it("`const tid = req.user.tenantId;` -> the LOCAL name is the map key, the principal field is the value", () => {
    const bindings = bindingsOf(`
      function handler(req, reply) {
        const tid = req.user.tenantId;
      }
    `);
    expect(bindings.principalFields.get("tid")).toBe("tenantId");
    expect(bindings.principalFields.has("tenantId")).toBe(false);
  });
});

// ── isPrincipalExpression ───────────────────────────────────────────────────────────────────

describe("isPrincipalExpression", () => {
  it("resolves req.user.tenantId directly, with no prior bindings needed", () => {
    const { expr, sourceFile } = parseExpression("req.user.tenantId");
    expect(isPrincipalExpression(expr, emptyBindings(), sourceFile)).toBe("tenantId");
  });

  it("resolves user.tenantId when user is a known principal-object alias", () => {
    const { expr, sourceFile } = parseExpression("user.tenantId");
    const bindings: RequestBindings = {
      clientSupplied: new Set(),
      principalObjects: new Set(["user"]),
      principalFields: new Map(),
    };
    expect(isPrincipalExpression(expr, bindings, sourceFile)).toBe("tenantId");
  });

  it("resolves a bare name that was bound to a principal field", () => {
    const { expr, sourceFile } = parseExpression("tenantId");
    const bindings: RequestBindings = {
      clientSupplied: new Set(),
      principalObjects: new Set(),
      principalFields: new Map([["tenantId", "tenantId"]]),
    };
    expect(isPrincipalExpression(expr, bindings, sourceFile)).toBe("tenantId");
  });

  it("negative: body.tenantId is NOT a principal expression — body is client-supplied, not the principal", () => {
    const { expr, sourceFile } = parseExpression("body.tenantId");
    expect(isPrincipalExpression(expr, emptyBindings(), sourceFile)).toBeNull();
  });

  it("negative: entry.employee.tenantId is NOT a principal expression — it is a fetched relation, not req.user", () => {
    const { expr, sourceFile } = parseExpression("entry.employee.tenantId");
    expect(isPrincipalExpression(expr, emptyBindings(), sourceFile)).toBeNull();
  });

  it("negative: a bare tenantId that nothing bound to req.user is NOT a principal expression", () => {
    const { expr, sourceFile } = parseExpression("tenantId");
    expect(isPrincipalExpression(expr, emptyBindings(), sourceFile)).toBeNull();
  });
});

// ── enclosingHandler ────────────────────────────────────────────────────────────────────────

describe("enclosingHandler", () => {
  it("resolves a call nested inside a callback arrow (.map) to the ROUTE HANDLER, not the callback — the time-entries.ts:875/884 scope trap", () => {
    const sourceFile = parse(`
      async function timeEntryRoutes(app) {
        app.post("/:id/breaks", {
          handler: async (req, reply) => {
            const user = req.user;
            items.map((x) => {
              prisma.timeEntry.update({ where: { id: x.id, tenantId: user.tenantId } });
            });
          },
        });
      }
    `);

    const expectedHandler = findFirst(
      sourceFile,
      (n) =>
        ts.isArrowFunction(n) &&
        n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === "req"),
    );
    expect(expectedHandler).toBeDefined();

    const targetCall = findFirst(
      sourceFile,
      (n) =>
        ts.isCallExpression(n) && n.expression.getText(sourceFile).includes("timeEntry.update"),
    );
    expect(targetCall).toBeDefined();

    const resolved = enclosingHandler(targetCall as ts.Node, sourceFile);
    expect(resolved).toBe(expectedHandler);
    // Sanity: the resolved scope must still contain the `req.user` alias binding, which is the
    // entire point of not stopping at the inner `.map` arrow.
    const bindings = collectRequestBindings(resolved, sourceFile);
    expect(bindings.principalObjects.has("user")).toBe(true);
  });

  it("resolves a call inside a module-scope helper function to that helper (audit-actor.ts:17 shape)", () => {
    const sourceFile = parse(`
      function resolveActor(req) {
        return prisma.user.findFirst({ where: { id: req.user.sub } });
      }
    `);

    const expectedHelper = findFirst(sourceFile, (n) => ts.isFunctionDeclaration(n));
    expect(expectedHelper).toBeDefined();

    const targetCall = findFirst(
      sourceFile,
      (n) => ts.isCallExpression(n) && n.expression.getText(sourceFile).includes("user.findFirst"),
    );
    expect(targetCall).toBeDefined();

    const resolved = enclosingHandler(targetCall as ts.Node, sourceFile);
    expect(resolved).toBe(expectedHelper);
  });
});
