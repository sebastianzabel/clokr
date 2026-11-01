#!/usr/bin/env -S pnpm exec tsx
/**
 * lint:prisma-unknown-keys — Issue #804.
 *
 * Why this gate exists: the Prisma delegate methods are typed `findMany<T extends XFindManyArgs>(
 * args?: SelectSubset<T, XFindManyArgs>)`. `T` is INFERRED from the argument, and `SelectSubset`
 * only maps the TOP-LEVEL keys of `T` (`select`, `where`, `orderBy`, …) against the args type.
 * Everything nested is checked by plain assignability of the (no longer fresh) inferred type to the
 * constraint, and assignability ignores extra properties. So a nonexistent field in `select`,
 * `include`, `where`, `orderBy` or `data` is accepted as soon as at least one sibling key is valid:
 * the only thing that still fires is TypeScript's weak-type check (TS2353 for `select: { bogus:
 * true }` alone, because no property overlaps). `tsc` therefore cannot be tightened to catch it
 * (tsconfig flags, `strict`, `skipLibCheck` make no difference) — this AST + type-checker pass does.
 *
 * What it does: for every call whose resolved signature has a parameter declared as
 * `SelectSubset<T, U>` / `Subset<T, U>`, take `U` (the real Prisma args type) and walk the object
 * literal argument recursively: every property key must exist on the corresponding (union member of
 * the) type. Spreads and non-literal values are skipped (nothing to read), index-signature types
 * (JSON values) accept any key.
 *
 * Usage: `tsx scripts/lint-prisma-unknown-keys.ts [-p <tsconfig>]` (default `tsconfig.scripts.json`).
 * Exit 1 with one line per unknown key.
 */
import path from "node:path";
import ts from "typescript";

const argv = process.argv.slice(2);
const pIdx = argv.indexOf("-p");
const tsconfigName = pIdx >= 0 ? argv[pIdx + 1] : "tsconfig.scripts.json";
const apiRoot = path.resolve(__dirname, "..");
const configPath = path.resolve(apiRoot, tsconfigName);

const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const findings: string[] = [];
let callsChecked = 0;
let keysChecked = 0;

/** The members of `type` that can carry named properties (unions flattened, null/undefined dropped). */
function objectMembers(type: ts.Type): ts.Type[] {
  // Relation args are `"rel" extends keyof ExtArgs["result"][..] ? boolean : boolean | RelArgs`
  // while `ExtArgs` is a type parameter; both branches are possible, so read both.
  if (type.flags & ts.TypeFlags.Conditional) {
    const node = (type as ts.ConditionalType).root.node;
    return [node.trueType, node.falseType].flatMap((n) =>
      objectMembers(checker.getTypeFromTypeNode(n)),
    );
  }
  if (type.isUnion()) return type.types.flatMap((t) => objectMembers(t));
  return [type].filter(
    (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)),
  );
}

function hasKey(members: ts.Type[], name: string): boolean {
  return members.some((m) => {
    if (m.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
      return true;
    if (checker.getIndexInfoOfType(m, ts.IndexKind.String)) return true;
    return checker.getPropertyOfType(m, name) !== undefined;
  });
}

function propType(members: ts.Type[], name: string): ts.Type[] {
  const out: ts.Type[] = [];
  for (const m of members) {
    const sym = checker.getPropertyOfType(m, name);
    if (sym) {
      out.push(...objectMembers(checker.getTypeOfSymbol(sym)));
    } else {
      // JSON values (`InputJsonObject`) are string-indexed: the value type is the next level.
      const index = checker.getIndexInfoOfType(m, ts.IndexKind.String);
      if (index) out.push(...objectMembers(index.type));
    }
  }
  return out;
}

function walk(node: ts.Expression, members: ts.Type[], trail: string): void {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return walk(node.expression, members, trail);
  }
  if (ts.isArrayLiteralExpression(node)) {
    // `AND: [..]`, `createMany.data: [..]` — array element types: use the array's element type or the type itself.
    const elementMembers = members.flatMap((m) => {
      const el = checker.getIndexTypeOfType(m, ts.IndexKind.Number);
      return el ? objectMembers(el) : [m];
    });
    for (const el of node.elements) walk(el, elementMembers, trail);
    return;
  }
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (name === undefined) continue;
    keysChecked++;
    if (!hasKey(members, name)) {
      const { line } = prop.getSourceFile().getLineAndCharacterOfPosition(prop.getStart());
      findings.push(
        `${path.relative(apiRoot, prop.getSourceFile().fileName)}:${line + 1}  unknown key "${trail}${name}"`,
      );
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      walk(prop.initializer, propType(members, name), `${trail}${name}.`);
    }
  }
}

/**
 * The concrete Prisma args type `U` of `method(args?: SelectSubset<T, U>)` / `Subset<T, U>` on the
 * receiver's delegate type. The signature is taken from the delegate's method symbol, NOT from the
 * resolved call: there `T` is already inferred and `SelectSubset` has collapsed into a plain object
 * (no `U`), while on the method symbol the alias survives and `ExtArgs` is already `DefaultArgs`
 * (a type read from the declaration would keep `ExtArgs` generic and its fields unresolved).
 */
function prismaArgsType(call: ts.CallExpression): ts.Type | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const recvType = checker.getTypeAtLocation(call.expression.expression);
  const methodSym = checker.getPropertyOfType(recvType, call.expression.name.text);
  if (!methodSym) return undefined;
  const sig = checker.getTypeOfSymbol(methodSym).getCallSignatures()[0];
  const param = sig?.parameters[0];
  if (!param) return undefined;
  const t = checker.getTypeOfSymbol(param);
  for (const c of t.isUnion() ? t.types : [t]) {
    if (
      c.aliasSymbol &&
      ["SelectSubset", "Subset"].includes(c.aliasSymbol.getName()) &&
      c.aliasTypeArguments?.length === 2
    ) {
      return c.aliasTypeArguments[1];
    }
  }
  return undefined;
}

function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const args = prismaArgsType(node);
    if (args) {
      callsChecked++;
      walk(node.arguments[0], objectMembers(args), "");
    }
  }
  ts.forEachChild(node, visit);
}

// Only the files the tsconfig lists: `scripts/` also imports from `src/`, which `typecheck` covers.
const listed = new Set(parsed.fileNames.map((f) => path.resolve(f)));
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !listed.has(path.resolve(sf.fileName))) continue;
  visit(sf);
}

// Anti-vacuity: a scan that saw no Prisma call proves nothing (moved directory, changed client typing).
if (callsChecked === 0) {
  console.error(
    `lint:prisma-unknown-keys: no Prisma call found in ${tsconfigName} — the gate is vacuous.`,
  );
  process.exit(1);
}
if (findings.length > 0) {
  console.error(`lint:prisma-unknown-keys: ${findings.length} unknown key(s) (Issue #804):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `lint:prisma-unknown-keys: OK (${callsChecked} calls, ${keysChecked} keys in ${tsconfigName}).`,
);
