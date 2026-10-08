// Build & Push reconcile (Issue #509): makes sure the tip of main has a Build & Push run.
//
// The gap: commits that Dependabot's `gh pr merge --auto` brings onto main are recorded under the
// GITHUB_TOKEN identity. GitHub starts no workflow from an event made with GITHUB_TOKEN (except
// workflow_dispatch and repository_dispatch), so their push never triggers build-push.yml. Measured
// on 2026-10-05: f1fbb71 (#491), e7684ce (#486) and a2bd9c0 (#485) have no Build & Push run.
//
// Why a state-based reconcile and not an event trigger: it compares STATE (main's commits against
// the existing runs), so a missed or late scheduled run is caught up by the next one, any cause of
// a missing push run is covered (not only Dependabot), and it is idempotent: a tip that has a run in
// ANY state (queued, in progress, completed with any conclusion) is never dispatched again.
// Colour is not its job, that belongs to the main-red alarm and the release gate (#507).
//
// Why only the TIP is ever dispatched: the dispatch API takes a branch, never a commit, so it always
// builds the tip of the ref. Building an older commit through the same workflow is not possible, and
// would also be wrong: its run would become the newest Build & Push run on main and break the #507
// invariant "newest completed run = state of main". A commit overtaken by a newer one before the
// reconcile reaches it gets no run of its own; its content is built and scanned in the newer
// commit's run and the report lists it as "OHNE LAUF, Inhalt gebaut im Lauf von <sha>".
//
// Decide mode (default) never writes to GitHub. Only `--dispatch <sha>` without `--dry-run` does,
// and only inside GitHub Actions. Pure decision functions are exported for the fixture tests; the
// CLI at the bottom only runs when this file is executed directly, never on import.
//
// Usage: node .github/scripts/build-push-reconcile.mjs [--lookback <1-100>] [--grace-minutes <n>]
//                                                      [--tip <40 hex>] [--dry-run]
//        node .github/scripts/build-push-reconcile.mjs --dispatch <40 hex> [--dry-run]
// Environment: GITHUB_REPOSITORY (owner/name), gh authenticated (GH_TOKEN) with contents: read and
// actions: read for decide mode; --dispatch additionally needs actions: write. A real (non
// dry-run) --dispatch is refused unless GITHUB_ACTIONS is "true", so no local run can start a build
// by accident. --dispatch re-reads main's tip and the tip's runs first and skips when main moved
// on or a run appeared, then confirms that a workflow_dispatch run exists (exit 1 otherwise).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BUILD_PUSH_WORKFLOW_FILE = "build-push.yml";
export const BUILD_PUSH_PATH = ".github/workflows/build-push.yml";
export const DISPATCH_REF = "main";
export const DEFAULT_LOOKBACK = 20;
export const MAX_LOOKBACK = 100;
export const DEFAULT_GRACE_MINUTES = 5;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const CONFIRM_TIMEOUT_MS = 180_000;
export const CONFIRM_INTERVAL_MS = 10_000;
export const DISPATCH_SKEW_MS = 60_000;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGITS_PATTERN = /^[0-9]+$/;
const MINUTE_MS = 60_000;

export function sha7(sha) {
  return String(sha ?? "").slice(0, 7);
}

/**
 * Reduce the commits list (newest first, as `GET repos/<repo>/commits` returns it) to the
 * first-parent chain that starts at the first entry. The chain stops at the first parent that is
 * not part of the input and never visits a commit twice.
 */
export function firstParentChain(commits) {
  const list = Array.isArray(commits) ? commits : [];
  if (list.length === 0) return [];
  const bySha = new Map(list.map((item) => [item.sha, item]));
  const chain = [];
  const visited = new Set();
  let current = list[0];
  while (current && !visited.has(current.sha)) {
    visited.add(current.sha);
    chain.push({
      sha: current.sha,
      committedAt: current.commit?.committer?.date,
      author: current.author?.login ?? current.commit?.author?.name ?? "unbekannt",
    });
    const parentSha = current.parents?.[0]?.sha;
    current = parentSha ? bySha.get(parentSha) : undefined;
  }
  return chain;
}

/** Newest run: highest run_number, ties broken by the higher id (same rule as gate and alarm). */
export function newestRun(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce((best, candidate) => {
    if (candidate.run_number !== best.run_number) {
      return candidate.run_number > best.run_number ? candidate : best;
    }
    return candidate.id > best.id ? candidate : best;
  });
}

function runsOf(runsBySha, sha) {
  const runs = runsBySha instanceof Map ? runsBySha.get(sha) : runsBySha?.[sha];
  return (runs ?? []).filter((run) => run.path === BUILD_PUSH_PATH);
}

/**
 * Attach the newest Build & Push run to every chain entry. A missing commit also records
 * `coveredBy`: the nearest NEWER commit that has a run, whose build contains this commit's content.
 */
export function classifyCommits(chain, runsBySha) {
  const classified = chain.map((entry) => {
    const run = newestRun(runsOf(runsBySha, entry.sha));
    return { ...entry, run, missing: run === null, coveredBy: null };
  });
  classified.forEach((entry, index) => {
    if (!entry.missing) return;
    for (let newer = index - 1; newer >= 0; newer -= 1) {
      if (!classified[newer].missing) {
        entry.coveredBy = classified[newer].sha;
        return;
      }
    }
  });
  return classified;
}

function describeRun(run) {
  return `${run.status}/${run.conclusion ?? "-"}`;
}

/**
 * Decide from the classified chain whether the tip needs a dispatch.
 *   noop     the tip has a run in any state
 *   wait     the tip has no run yet but is younger than the grace period
 *   dispatch the tip has no run and is at least `graceMinutes` old
 */
export function decideReconcile({ classified, nowMs, graceMinutes }) {
  if (!Array.isArray(classified) || classified.length === 0) {
    throw new Error("Keine Commits auf main gefunden.");
  }
  const tip = classified[0];
  if (tip.run) {
    return {
      action: "noop",
      sha: tip.sha,
      reason: `Commit ${sha7(tip.sha)} hat bereits den Build & Push Lauf ${tip.run.id} (${describeRun(tip.run)})`,
    };
  }
  const committedMs = Date.parse(tip.committedAt);
  if (Number.isNaN(committedMs)) {
    throw new Error(
      `Das Commit-Datum von ${sha7(tip.sha)} ist unlesbar: '${tip.committedAt ?? ""}'.`,
    );
  }
  const ageMs = Math.max(0, nowMs - committedMs);
  const ageMinutes = Math.floor(ageMs / MINUTE_MS);
  if (ageMs >= graceMinutes * MINUTE_MS) {
    return {
      action: "dispatch",
      sha: tip.sha,
      reason: `Commit ${sha7(tip.sha)} hat keinen Build & Push Lauf und ist ${ageMinutes} Min. alt`,
    };
  }
  return {
    action: "wait",
    sha: tip.sha,
    reason: `Commit ${sha7(tip.sha)} hat noch keinen Build & Push Lauf, ist aber erst ${ageMinutes} Min. alt (Wartezeit ${graceMinutes} Min.)`,
  };
}

/** Plain-text report of the classified chain, ending with the one-line list of missing commits. */
export function renderReport(classified) {
  const lines = [
    `Geprüft: ${classified.length} Commits auf main (erster Elternteil), neuester zuerst.`,
  ];
  classified.forEach((entry, index) => {
    const head = `- ${sha7(entry.sha)} ${entry.committedAt} ${entry.author}:`;
    if (!entry.missing) {
      lines.push(`${head} Lauf ${entry.run.id} (${describeRun(entry.run)})`);
    } else if (index === 0) {
      lines.push(`${head} OHNE LAUF`);
    } else if (entry.coveredBy) {
      lines.push(`${head} OHNE LAUF, Inhalt gebaut im Lauf von ${sha7(entry.coveredBy)}`);
    } else {
      lines.push(`${head} OHNE LAUF, noch kein Lauf eines Nachfolgers`);
    }
  });
  const missing = classified.filter((entry) => entry.missing).map((entry) => sha7(entry.sha));
  lines.push(`Ohne Build & Push Lauf: ${missing.length > 0 ? missing.join(", ") : "keine"}`);
  return lines.join("\n");
}

/** Lines for GITHUB_OUTPUT: `dispatch` and `sha` (empty unless a dispatch was decided). */
export function formatOutputs({ dispatch, sha }) {
  return `dispatch=${dispatch ? "true" : "false"}\nsha=${dispatch ? sha : ""}\n`;
}

/**
 * Re-check right before dispatching (the decide job ran minutes earlier). A dispatch always builds
 * the tip of main, so it is only allowed while `expectedSha` still IS the tip and still has no run.
 */
export function decideDispatch({ expectedSha, mainTipSha, runsForExpected }) {
  if (mainTipSha !== expectedSha) {
    return {
      action: "skip",
      reason: `main steht inzwischen auf ${sha7(mainTipSha)} statt ${sha7(expectedSha)}, ein Lauf würde den neueren Commit bauen; der nächste Abgleich entscheidet neu`,
    };
  }
  const existing = newestRun((runsForExpected ?? []).filter((r) => r.path === BUILD_PUSH_PATH));
  if (existing) {
    return {
      action: "skip",
      reason: `Commit ${sha7(expectedSha)} hat inzwischen den Build & Push Lauf ${existing.id} (${describeRun(existing)})`,
    };
  }
  return {
    action: "dispatch",
    reason: `Commit ${sha7(expectedSha)} ist weiterhin der Stand von main und hat keinen Build & Push Lauf`,
  };
}

/**
 * Extract the run id from the raw answer of the dispatch call. Current GitHub answers 200 with
 * `workflow_run_id`; older behaviour is 204 with an empty body. Anything unusable yields null, and
 * the caller then falls back to polling.
 */
export function parseDispatchResponse(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = parsed?.workflow_run_id;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The newest workflow_dispatch run of build-push.yml on main that was created at or after the
 * dispatch (minus a clock-skew allowance), or null.
 */
export function findDispatchedRun(runs, { sinceMs }) {
  const candidates = (runs ?? []).filter((r) => {
    if (r.event !== "workflow_dispatch" || r.head_branch !== DISPATCH_REF) return false;
    if (r.path !== BUILD_PUSH_PATH) return false;
    return Date.parse(r.created_at) >= sinceMs - DISPATCH_SKEW_MS;
  });
  return newestRun(candidates);
}

/**
 * Poll until the dispatched run shows up or the timeout is over. Errors from fetchRuns propagate,
 * so an API failure can never be reported as a started build.
 */
export async function waitForDispatchedRun({
  fetchRuns,
  sleep,
  now,
  sinceMs,
  timeoutMs = CONFIRM_TIMEOUT_MS,
  intervalMs = CONFIRM_INTERVAL_MS,
}) {
  const start = now();
  for (let attempts = 1; ; attempts += 1) {
    const found = findDispatchedRun(await fetchRuns(), { sinceMs });
    if (found) return { run: found, attempts };
    if (now() - start >= timeoutMs) return { run: null, attempts };
    await sleep(intervalMs);
  }
}

function invalid(name, value, expectation) {
  return new Error(`Ungültiger Wert für ${name}: '${value}'. Erwartet wird ${expectation}.`);
}

/**
 * Parse and validate the CLI arguments; throws an Error with a German message. Validation happens
 * before a single API call is made.
 */
export function parseReconcileArgs(argv, env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "dry-run": { type: "boolean" },
        lookback: { type: "string" },
        "grace-minutes": { type: "string" },
        tip: { type: "string" },
        dispatch: { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`Ungültiger Aufruf: unbekannte oder unvollständige Option (${error.message}).`);
  }

  const dispatchSha = values.dispatch;
  if (dispatchSha !== undefined) {
    if (!SHA_PATTERN.test(dispatchSha)) {
      throw new Error(
        `Ungültige SHA '${dispatchSha}': erwartet werden genau 40 Hex-Zeichen in Kleinbuchstaben.`,
      );
    }
    const extra = ["tip", "lookback", "grace-minutes"].filter((name) => values[name] !== undefined);
    if (extra.length > 0) {
      throw new Error(
        `Ungültiger Aufruf: --dispatch lässt sich nicht mit --${extra.join(", --")} kombinieren.`,
      );
    }
    const dryRunRequested = values["dry-run"] === true;
    if (!dryRunRequested && env?.GITHUB_ACTIONS !== "true") {
      throw new Error(
        "Ungültiger Aufruf: --dispatch ohne --dry-run schreibt nach GitHub und ist nur innerhalb des Workflows (GITHUB_ACTIONS=true) erlaubt.",
      );
    }
    return {
      mode: "dispatch",
      dryRun: dryRunRequested,
      lookback: DEFAULT_LOOKBACK,
      graceMinutes: DEFAULT_GRACE_MINUTES,
      tip: undefined,
      sha: dispatchSha,
    };
  }

  let lookback = DEFAULT_LOOKBACK;
  if (values.lookback !== undefined) {
    const raw = values.lookback;
    const parsed = DIGITS_PATTERN.test(raw) ? Number(raw) : NaN;
    if (!(parsed >= 1 && parsed <= MAX_LOOKBACK)) {
      throw invalid("--lookback", raw, `eine ganze Zahl von 1 bis ${MAX_LOOKBACK}`);
    }
    lookback = parsed;
  }

  let graceMinutes = DEFAULT_GRACE_MINUTES;
  if (values["grace-minutes"] !== undefined) {
    const raw = values["grace-minutes"];
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
      throw invalid("--grace-minutes", raw, "eine Zahl ≥ 0 (Minuten)");
    }
    graceMinutes = parsed;
  }

  const dryRun = values["dry-run"] === true;
  const tip = values.tip;
  if (tip !== undefined) {
    if (!SHA_PATTERN.test(tip)) {
      throw new Error(
        `Ungültige SHA '${tip}': erwartet werden genau 40 Hex-Zeichen in Kleinbuchstaben.`,
      );
    }
    if (!dryRun) {
      throw new Error(
        "Ungültiger Aufruf: --tip (Wiederholung eines früheren Stands) ist nur zusammen mit --dry-run erlaubt.",
      );
    }
  }

  return { mode: "decide", dryRun, lookback, graceMinutes, tip };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const DECISION_LABELS = {
  dispatch: "Build & Push anstoßen",
  wait: "abwarten",
  noop: "nichts tun",
};

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, input });
}

function ghGet(endpoint) {
  return JSON.parse(gh(["api", endpoint]));
}

function escapeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function appendTo(file, text) {
  if (file) {
    appendFileSync(file, text);
  }
}

async function runDecide(args, env, repository) {
  const commits = ghGet(
    `repos/${repository}/commits?sha=${args.tip ?? DISPATCH_REF}&per_page=${args.lookback}`,
  );
  const chain = firstParentChain(commits);
  const runsBySha = new Map();
  for (const entry of chain) {
    const response = ghGet(
      `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/runs?head_sha=${entry.sha}&per_page=100`,
    );
    runsBySha.set(entry.sha, response.workflow_runs ?? []);
  }
  const classified = classifyCommits(chain, runsBySha);
  const decision = decideReconcile({
    classified,
    nowMs: Date.now(),
    graceMinutes: args.graceMinutes,
  });

  const report = renderReport(classified);
  const headline = `Entscheidung: ${DECISION_LABELS[decision.action]} – ${decision.reason}`;
  console.log(report);
  console.log("");
  console.log(headline);
  appendTo(env.GITHUB_STEP_SUMMARY, `${report}\n\n${headline}\n`);

  const willDispatch = decision.action === "dispatch" && !args.dryRun;
  appendTo(env.GITHUB_OUTPUT, formatOutputs({ dispatch: willDispatch, sha: decision.sha }));
  if (args.dryRun) {
    console.log("Probelauf: nichts angestoßen.");
  }
  return 0;
}

function workflowRunsEndpoint(repository, query) {
  return `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/runs?${query}`;
}

async function runDispatch(args, env, repository) {
  const mainTip = ghGet(`repos/${repository}/commits/${DISPATCH_REF}`).sha;
  if (!SHA_PATTERN.test(String(mainTip))) {
    throw new Error(`Die Antwort der API enthält keinen lesbaren Stand von ${DISPATCH_REF}.`);
  }
  const runsForExpected =
    ghGet(workflowRunsEndpoint(repository, `head_sha=${args.sha}&per_page=100`)).workflow_runs ??
    [];
  const decision = decideDispatch({
    expectedSha: args.sha,
    mainTipSha: mainTip,
    runsForExpected,
  });
  const label = decision.action === "dispatch" ? "Build & Push anstoßen" : "nicht anstoßen";
  const headline = `Entscheidung: ${label} – ${decision.reason}`;
  console.log(headline);
  appendTo(env.GITHUB_STEP_SUMMARY, `${headline}\n`);
  if (decision.action === "skip") {
    return 0;
  }
  if (args.dryRun) {
    console.log("Probelauf: nichts angestoßen.");
    return 0;
  }

  const sinceMs = Date.now();
  // The answer is deliberately not JSON-parsed here: depending on the API version it is empty.
  const raw = gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/dispatches`,
      "--input",
      "-",
    ],
    JSON.stringify({ ref: DISPATCH_REF }),
  );
  const runId = parseDispatchResponse(raw);
  let started;
  if (runId !== null) {
    started = ghGet(`repos/${repository}/actions/runs/${runId}`);
  } else {
    const waited = await waitForDispatchedRun({
      fetchRuns: async () =>
        ghGet(
          workflowRunsEndpoint(
            repository,
            `event=workflow_dispatch&branch=${DISPATCH_REF}&per_page=20`,
          ),
        ).workflow_runs ?? [],
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      sinceMs,
    });
    started = waited.run;
  }

  if (!started) {
    const message =
      `Der Aufruf für ${sha7(args.sha)} wurde abgeschickt, aber nach 3 Minuten ist kein Build & Push Lauf erschienen. ` +
      "Prüfen mit: gh run list --workflow build-push.yml --branch main --event workflow_dispatch";
    console.log(`::error title=Build & Push Abgleich::${escapeData(message)}`);
    appendTo(env.GITHUB_STEP_SUMMARY, `${message}\n`);
    return 1;
  }
  const line = `Build & Push angestoßen: Lauf ${started.id} (${started.html_url}), Commit ${sha7(started.head_sha)}`;
  console.log(line);
  appendTo(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (started.head_sha !== args.sha) {
    const note = `Hinweis: main ist inzwischen weiter, gebaut wird ${sha7(started.head_sha)}.`;
    console.log(note);
    appendTo(env.GITHUB_STEP_SUMMARY, `${note}\n`);
  }
  return 0;
}

export async function main(argv, env) {
  try {
    const args = parseReconcileArgs(argv, env);
    const repository = env.GITHUB_REPOSITORY ?? "";
    if (!REPOSITORY_PATTERN.test(repository)) {
      throw new Error("GITHUB_REPOSITORY fehlt oder hat nicht die Form owner/name.");
    }
    if (args.mode === "dispatch") {
      return await runDispatch(args, env, repository);
    }
    return await runDecide(args, env, repository);
  } catch (error) {
    const detail = String(error.stderr || error.message || error)
      .trim()
      .split("\n")[0];
    console.log(`::error title=Build & Push Abgleich::${escapeData(detail)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.log(
        `::error title=Build & Push Abgleich::${escapeData(String(error?.message ?? error))}`,
      );
      process.exit(1);
    },
  );
}
