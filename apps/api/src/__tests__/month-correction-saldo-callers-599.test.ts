/**
 * Issue #599 — every production call of the saldo core passes the booked month corrections.
 *
 * `CloseMonthInput.accountCorrections` is optional in the type only so the pure-core unit fixtures
 * stay unchanged. A production caller that forgot it would silently drop an approved correction
 * from the saldo, so this guard walks every non-test source file and requires each
 * `closeEmployeeMonth({ ... })` object literal to name `accountCorrections` (directly, or through a
 * spread of a local object that names it).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The text of the object literal that starts at `open` (index of `{`), braces balanced. */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unbalanced object literal");
}

describe("Issue #599 — closeEmployeeMonth callers pass accountCorrections", () => {
  const files = walk(SRC);
  const calls: { file: string; ok: boolean }[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/closeEmployeeMonth\(\{/g)) {
      const literal = objectAt(text, m.index! + "closeEmployeeMonth(".length);
      let ok = /\baccountCorrections\b/.test(literal);
      if (!ok) {
        // `...shared` spreads: the spread object must itself name the field.
        for (const spread of literal.matchAll(/\.\.\.(\w+)/g)) {
          const decl = new RegExp(`const ${spread[1]} = \\{`).exec(text);
          if (
            decl &&
            /\baccountCorrections\b/.test(objectAt(text, decl.index + decl[0].length - 1))
          ) {
            ok = true;
          }
        }
      }
      calls.push({ file: file.slice(SRC.length + 1), ok });
    }
  }

  it("finds the production call sites (walked set is not empty)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThanOrEqual(9);
  });

  it("every call names accountCorrections", () => {
    expect(calls.filter((c) => !c.ok)).toEqual([]);
  });
});
