/**
 * Issue #608 - the ONE scanner of `notify({ ... })` call sites under apps/api/src (a helper, not a
 * test file). Moved verbatim out of `notification-email-policy.test.ts` so the e-mail registry test
 * and the push registry test (`notification-push-policy-608.test.ts`) walk exactly the same set of
 * types; a second scanner could drift from the first and let one registry go unchecked.
 *
 * Pure static analysis: no DB, no app boot. It throws when it walked zero files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(__dirname, "../");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns the text of the `type:` property of the object literal that starts at `openBrace`
 * (the index of the `{` of `notify({`), up to the property's top-level comma or the closing brace.
 * String literals and nesting are tracked, so a multi-line ternary is read completely and a comma
 * inside a string or a call never ends the expression. Null when the object has no `type:` key.
 *
 * Known limit (review 2, IN-04): comments are not skipped, so an apostrophe inside a comment within a
 * `notify({ ... })` object reads as the start of a string and the call site then fails loudly with
 * "no readable type property". Keep such comments apostrophe-free or above the call.
 */
function readTypeExpression(content: string, openBrace: number): string | null {
  let depth = 0;
  let i = openBrace;
  let typeStart = -1;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) i += content[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0 && typeStart !== -1) return content.slice(typeStart, i);
      if (depth === 0) return null;
    } else if (ch === "," && depth === 1 && typeStart !== -1) {
      return content.slice(typeStart, i);
    } else if (depth === 1 && typeStart === -1 && content.startsWith("type", i)) {
      const before = content[i - 1];
      const after = content.slice(i + 4).match(/^\s*:/);
      if (/[\s{,]/.test(before) && after) typeStart = i + 4 + after[0].length;
    }
  }
  return null;
}

/** Index of the first top-level `?` of a ternary (not `?.` and not `??`), or -1. */
function ternaryIndex(expression: string): number {
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < expression.length && expression[i] !== quote) i += expression[i] === "\\" ? 2 : 1;
      continue;
    }
    if (
      ch === "?" &&
      expression[i + 1] !== "." &&
      expression[i + 1] !== "?" &&
      expression[i - 1] !== "?"
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract UPPER_SNAKE notification-type literals from the expression that follows
 * `type:` in a `notify({ ... })` call.
 *
 * The naive "every /"([A-Z][A-Z0-9_]*)"/g literal on the line" rule is WRONG: the
 * ternary at `leave.ts:1400` reads
 *   type: body.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
 * and the naive rule also captures "APPROVED" — the comparison operand, a
 * `LeaveRequest.status` value, never a notification type. `resolveEmailPolicy("APPROVED")`
 * is undefined BY CONSTRUCTION and can never be fixed by adding a registry entry.
 *
 * Correct rule: if the expression contains a `?`, discard everything up to and
 * including the FIRST `?` and collect literals only from the branches after it.
 * Otherwise collect literals from the whole expression.
 *
 * Review IN-02: the branches must consist of string literals ONLY. A variable, a constant, a
 * function call or a nested ternary makes the call site unresolvable for a static scan, and a
 * registry test that silently skipped it could not prove completeness - so it throws instead.
 */
function extractTypeLiterals(typeExpression: string, where: string): string[] {
  const qIndex = ternaryIndex(typeExpression);
  const relevant = qIndex === -1 ? typeExpression : typeExpression.slice(qIndex + 1);
  const literals = (relevant.match(/"([A-Z][A-Z0-9_]*)"/g) ?? []).map((m) => m.slice(1, -1));
  const leftover = relevant.replace(/"[^"\n]*"/g, "").replace(/[\s:?(),]/g, "");
  if (literals.length === 0 || leftover !== "") {
    throw new Error(
      `notify() call at ${where} has a non-literal "type" (${typeExpression.trim().slice(0, 80)}). ` +
        "Use string literals (a ternary of literals is fine) so the e-mail and push registries " +
        "can be proven complete, or extend apps/api/src/__tests__/notify-emit-sites.ts to read it.",
    );
  }
  return literals;
}

/** The types a source text emits through `notify({ ... })`; throws on an unresolvable call. */
export function scanNotifySource(content: string, label: string): string[] {
  const types: string[] = [];
  const callRegex = /\bnotify\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(content)) !== null) {
    // The declaration `function notify({ userId, type, ... }: NotifyParams)` is not a call.
    if (/function\s+$/.test(content.slice(Math.max(0, match.index - 24), match.index))) continue;
    const openBrace = match.index + match[0].length - 1;
    const line = content.slice(0, match.index).split("\n").length;
    const where = `${label}:${line}`;
    const expression = readTypeExpression(content, openBrace);
    if (expression === null) {
      throw new Error(`notify() call at ${where} has no readable "type: ..." property`);
    }
    types.push(...extractTypeLiterals(expression, where));
  }
  return types;
}

export function scanNotifyEmitSites(): { types: Set<string>; filesScanned: number } {
  const found = new Set<string>();
  const files = collectTsFiles(SRC_DIR);
  if (files.length === 0) {
    // Own non-empty proof: a moved or emptied source tree must fail loudly, never scan nothing.
    throw new Error("notify() emit-site scan walked zero .ts files under " + SRC_DIR);
  }

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    for (const t of scanNotifySource(content, file.slice(SRC_DIR.length))) found.add(t);
  }

  return { types: found, filesScanned: files.length };
}
