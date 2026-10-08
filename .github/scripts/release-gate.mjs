// Release gate (Issue #507): release.yml's `promote` may only start when the Build & Push run of
// the tagged commit finished with conclusion `success`.
//
// Why a run check and not an image check: build-push.yml pushes the `:sha-<7>` image BEFORE its
// Trivy step, so an existing image proves nothing about the scan. Only the workflow run's own
// conclusion says "built AND scanned clean".
//
// Fail-closed throughout: every conclusion other than `success` counts as red, an API error
// propagates (it never turns into a pass), and a run that never shows up fails after a grace
// period. Pure decision functions are exported for the fixture tests; the CLI at the bottom only
// runs when this file is executed directly, never on import.
//
// Usage: node .github/scripts/release-gate.mjs --tag v1.15.0
//        node .github/scripts/release-gate.mjs --sha <40 hex>
// Environment: GITHUB_REPOSITORY (owner/name), gh authenticated (GH_TOKEN) with actions: read.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BUILD_PUSH_WORKFLOW_FILE = "build-push.yml";

// Must stay identical to the regex in release.yml's promote "Extract metadata" step (T-UMA-01);
// a test pins the source text.
export const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const DEFAULT_TIMEOUT_MINUTES = 45;
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MISSING_GRACE_MINUTES = 5;

function parseNumber(raw, { name, unit, min, minInclusive }) {
  const value = Number(raw);
  const ok = raw !== "" && Number.isFinite(value) && (minInclusive ? value >= min : value > min);
  if (!ok) {
    throw new Error(
      `Ungültiger Wert für ${name}: '${raw}'. Erwartet wird eine Zahl ${minInclusive ? "≥" : ">"} ${min} (${unit}).`,
    );
  }
  return value;
}

/**
 * Parse and validate the CLI arguments. Throws an Error with a German message on any problem.
 * Validation happens before a single API call is made.
 */
export function parseGateArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        tag: { type: "string" },
        sha: { type: "string" },
        "timeout-minutes": { type: "string" },
        "interval-seconds": { type: "string" },
        "missing-grace-minutes": { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`Ungültiger Aufruf: unbekannte oder unvollständige Option (${error.message}).`);
  }

  const { tag, sha } = values;
  if (tag !== undefined && sha !== undefined) {
    throw new Error("Ungültiger Aufruf: genau eines von --tag oder --sha angeben, nicht beide.");
  }
  if (tag === undefined && sha === undefined) {
    throw new Error(
      "Ungültiger Aufruf: --tag vX.Y.Z oder --sha <40 Hex-Zeichen> ist erforderlich.",
    );
  }
  if (tag !== undefined && !TAG_PATTERN.test(tag)) {
    throw new Error(
      `Ungültiger Release-Tag '${tag}': erwartet wird vX.Y.Z (optional mit -Suffix).`,
    );
  }
  if (sha !== undefined && !SHA_PATTERN.test(sha)) {
    throw new Error(
      `Ungültige SHA '${sha}': erwartet werden genau 40 Hex-Zeichen in Kleinbuchstaben.`,
    );
  }

  return {
    tag,
    sha,
    timeoutMinutes:
      values["timeout-minutes"] === undefined
        ? DEFAULT_TIMEOUT_MINUTES
        : parseNumber(values["timeout-minutes"], {
            name: "--timeout-minutes (Zeitlimit)",
            unit: "Minuten",
            min: 0,
            minInclusive: true,
          }),
    intervalSeconds:
      values["interval-seconds"] === undefined
        ? DEFAULT_INTERVAL_SECONDS
        : parseNumber(values["interval-seconds"], {
            name: "--interval-seconds (Abfrageabstand)",
            unit: "Sekunden",
            min: 0,
            minInclusive: false,
          }),
    missingGraceMinutes:
      values["missing-grace-minutes"] === undefined
        ? DEFAULT_MISSING_GRACE_MINUTES
        : parseNumber(values["missing-grace-minutes"], {
            name: "--missing-grace-minutes (Wartezeit auf einen fehlenden Lauf)",
            unit: "Minuten",
            min: 0,
            minInclusive: true,
          }),
  };
}

/**
 * Decide from the Build & Push runs of ONE commit.
 * The newest run (highest run_number, ties broken by the higher id) is the only one that counts:
 * a re-run or a later attempt supersedes an older red run, and an older green run must never
 * mask a newer red one. No branch or event filter, so a reopened release/** line keeps working.
 */
export function evaluateBuildPushRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: "missing" };
  }
  const newest = runs.reduce((best, candidate) => {
    if (candidate.run_number !== best.run_number) {
      return candidate.run_number > best.run_number ? candidate : best;
    }
    return candidate.id > best.id ? candidate : best;
  });
  if (newest.status !== "completed") {
    return { state: "pending", run: newest };
  }
  if (newest.conclusion === "success") {
    return { state: "success", run: newest };
  }
  // Fail closed: cancelled, timed_out, startup_failure, action_required, neutral, skipped,
  // stale and a missing conclusion are all "not proven green".
  return { state: "failed", run: newest };
}

/**
 * Poll until the build is green, red, missing past the grace period, or pending past the timeout.
 * Never waits on red. Errors from fetchRuns propagate so an API failure can never become a pass.
 */
export async function waitForGreenBuild({
  fetchRuns,
  sleep,
  now,
  timeoutMs,
  intervalMs,
  missingGraceMs,
  onPoll,
}) {
  const start = now();
  for (let attempt = 1; ; attempt += 1) {
    const runs = await fetchRuns();
    const evaluation = evaluateBuildPushRuns(runs);
    const elapsed = now() - start;
    if (onPoll) {
      onPoll({ attempt, elapsedMs: elapsed, evaluation });
    }
    if (evaluation.state === "success") {
      return { ok: true, outcome: "success", run: evaluation.run };
    }
    if (evaluation.state === "failed") {
      return { ok: false, outcome: "failed", run: evaluation.run };
    }
    if (evaluation.state === "missing" && elapsed >= missingGraceMs) {
      return { ok: false, outcome: "missing" };
    }
    if (evaluation.state === "pending" && elapsed >= timeoutMs) {
      return { ok: false, outcome: "timeout", run: evaluation.run };
    }
    await sleep(intervalMs);
  }
}

/**
 * Render the outcome as { title, message }. The message is ONE line because raw newlines break
 * GitHub workflow-command annotations.
 */
export function formatOutcome(result, { tag, sha }) {
  const sha7 = (sha ?? "").slice(0, 7);
  const tagForCommand = tag ?? "<TAG>";
  const redispatch = `gh workflow run release.yml --ref main -f tag=${tagForCommand}`;
  const run = result.run;

  switch (result.outcome) {
    case "success":
      return {
        title: "Release-Gate: Build & Push grün",
        message: `Build & Push für ${sha7} ist grün (Lauf ${run.id}).`,
      };
    case "failed":
      return {
        title: "Release-Gate: Build & Push rot",
        message:
          `Build & Push für ${sha7} ist nicht grün: Lauf ${run.id} (${run.html_url}) endete mit '${run.conclusion ?? "ohne Ergebnis"}'. ` +
          `Es wird nichts promotet. Bei einer einmaligen Störung: 'gh run rerun ${run.id} --failed', danach '${redispatch}'. ` +
          `Bei einem echten Befund: auf main beheben und ein neues Release schneiden. Niemals ein anderes Image von Hand promoten.`,
      };
    case "missing":
      return {
        title: "Release-Gate: Build & Push fehlt",
        message:
          `Für den Commit ${sha7} existiert kein Build & Push Lauf. Ohne geprüften Lauf wird nichts promotet. ` +
          `Klären, warum Build & Push nicht lief, und niemals von Hand promoten.`,
      };
    case "timeout":
      return {
        title: "Release-Gate: Zeitüberschreitung",
        message:
          `Build & Push für ${sha7} lief nach der Wartezeit noch: Lauf ${run.id} (${run.html_url}), Status '${run.status}'. ` +
          `Nichts wurde promotet. Nach dem Ende des Laufs erneut starten: '${redispatch}'.`,
      };
    default:
      throw new Error(`Unbekanntes Ergebnis '${result.outcome}'.`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function escapeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function annotateError(title, message) {
  console.log(`::error title=${title}::${escapeData(message)}`);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function appendSummary(env, line) {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

export async function main(argv, env) {
  let args;
  try {
    args = parseGateArgs(argv);
  } catch (error) {
    annotateError("Release-Gate: ungültiger Aufruf", error.message);
    return 1;
  }

  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY_PATTERN.test(repository)) {
    annotateError(
      "Release-Gate: ungültiger Aufruf",
      "GITHUB_REPOSITORY fehlt oder hat nicht die Form owner/name.",
    );
    return 1;
  }

  try {
    let sha = args.sha;
    if (sha === undefined) {
      sha = gh(["api", `repos/${repository}/commits/${args.tag}`, "--jq", ".sha"]).trim();
      if (!SHA_PATTERN.test(sha)) {
        throw new Error(`Der Tag ${args.tag} ließ sich nicht auf einen Commit auflösen.`);
      }
    }

    const fetchRuns = async () => {
      const raw = gh([
        "api",
        `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/runs?head_sha=${sha}&per_page=100`,
      ]);
      return JSON.parse(raw).workflow_runs ?? [];
    };

    console.log(
      `Release-Gate: prüfe Build & Push für ${sha.slice(0, 7)}${args.tag ? ` (${args.tag})` : ""} ` +
        `(Zeitlimit ${args.timeoutMinutes} min, Abstand ${args.intervalSeconds} s).`,
    );

    const result = await waitForGreenBuild({
      fetchRuns,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      timeoutMs: args.timeoutMinutes * 60_000,
      intervalMs: args.intervalSeconds * 1000,
      missingGraceMs: args.missingGraceMinutes * 60_000,
      onPoll: ({ attempt, evaluation }) => {
        const run = evaluation.run;
        console.log(
          `Abfrage ${attempt}: ` +
            (run
              ? `Lauf ${run.id}, Status '${run.status}', Ergebnis '${run.conclusion ?? "offen"}'`
              : "kein Build & Push Lauf gefunden") +
            ` (${evaluation.state}).`,
        );
      },
    });

    const outcome = formatOutcome(result, { tag: args.tag, sha });
    if (result.ok) {
      const line = `Release-Gate: ${outcome.message}`;
      console.log(line);
      appendSummary(env, line);
      return 0;
    }
    annotateError(outcome.title, outcome.message);
    appendSummary(env, `${outcome.title}: ${outcome.message}`);
    return 1;
  } catch (error) {
    // Fail closed: an API or parsing error must never let promote start.
    const detail = String(error.stderr || error.message || error)
      .trim()
      .split("\n")[0];
    annotateError(
      "Release-Gate: API-Fehler",
      `Der Build & Push Status ließ sich nicht prüfen: ${detail}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      annotateError("Release-Gate: unerwarteter Fehler", String(error?.message ?? error));
      process.exit(1);
    },
  );
}
