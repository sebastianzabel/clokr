// Guard-vacuity fixture (235-08, owner-approved) — the EXACT shape apps/web/scripts/lint-ui.mjs
// and lint-ui-classes.mjs both use: `find` invoked via a TEMPLATE LITERAL WITH SUBSTITUTIONS
// (a `${scope}` interpolation), not a plain string literal. `ts.isStringLiteralLike` recognises a
// StringLiteral or a NoSubstitutionTemplateLiteral, but NOT a TemplateExpression — this fixture
// pins that `isCpCommandWalk` now also matches the template's own HEAD text ("find '"), and that
// the `.toString()` link in the execSync(...).toString().split(...).filter(...).map(...) chain no
// longer breaks walk-derivation (both real files build their file list this exact way).
// Classification: walks=true, asserts=true, inputProof="empty-abort".
import { execSync } from "node:child_process";

export function listSvelteFiles(scope) {
  const out = execSync(`find '${scope}' -type f -name '*.svelte'`, {
    cwd: process.cwd(),
  }).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => f.trim());
}

const files = listSvelteFiles("apps/web/src");
if (files.length === 0) {
  console.error("scanned 0 file(s) — the scan root moved or the filter matched nothing.");
  process.exit(1);
}
