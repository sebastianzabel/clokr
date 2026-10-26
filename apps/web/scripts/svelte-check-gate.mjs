// svelte-check gate (Issue #699). `tsc --noEmit` does not look inside .svelte files, so this
// runs svelte-check over the whole web app and fails on ANY error. Warnings (a11y, unused CSS,
// state-reference hints) are counted and frozen: the count may only go down. When it does, lower
// WARNING_CEILING in this file in the same commit, so the ratchet follows the improvement.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WARNING_CEILING = 87;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(
  "pnpm",
  ["exec", "svelte-check", "--tsconfig", "./tsconfig.json", "--output", "machine"],
  { cwd: webRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const summary = /COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS/.exec(out);

// Anti-vacuity: a run that never reached the summary line or checked no files proves nothing.
if (!summary || Number(summary[1]) === 0) {
  console.error("svelte-check-gate: no summary line or zero files checked — the gate saw nothing.");
  console.error(out.slice(-2000));
  process.exit(1);
}

const [, files, errors, warnings] = summary.map(Number);
const problems = out.split("\n").filter((l) => / ERROR /.test(l));
for (const line of problems) console.error(line.replace(/^\d+ ERROR /, "ERROR "));

let failed = false;
if (errors > 0) {
  console.error(`svelte-check-gate: ${errors} error(s) in ${files} files (must be 0).`);
  failed = true;
}
if (warnings > WARNING_CEILING) {
  console.error(
    `svelte-check-gate: ${warnings} warnings exceed the frozen ceiling of ${WARNING_CEILING}. ` +
      "Fix the new warning(s); run `pnpm --filter @clokr/web exec svelte-check --tsconfig ./tsconfig.json` to list them.",
  );
  failed = true;
} else if (warnings < WARNING_CEILING) {
  console.log(
    `svelte-check-gate: ${warnings} warnings, ceiling is ${WARNING_CEILING} — lower WARNING_CEILING in scripts/svelte-check-gate.mjs.`,
  );
}
if (failed) process.exit(1);
console.log(`svelte-check-gate: OK (${files} files, 0 errors, ${warnings} warnings).`);
