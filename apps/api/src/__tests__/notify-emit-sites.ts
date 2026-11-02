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
 */
function extractTypeLiterals(typeExpression: string): string[] {
  const qIndex = typeExpression.indexOf("?");
  const relevant = qIndex === -1 ? typeExpression : typeExpression.slice(qIndex + 1);
  const matches = relevant.match(/"([A-Z][A-Z0-9_]*)"/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
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
    const callRegex = /\bnotify\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(content)) !== null) {
      const windowStart = match.index;
      const window = content.slice(windowStart, windowStart + 1500);
      const typeLineMatch = window.match(/^\s*type:\s*(.+)$/m);
      if (!typeLineMatch) continue;
      for (const t of extractTypeLiterals(typeLineMatch[1])) {
        found.add(t);
      }
    }
  }

  return { types: found, filesScanned: files.length };
}
