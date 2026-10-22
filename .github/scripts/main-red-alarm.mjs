// Main-red alarm (Issue #507): keeps EXACTLY ONE open issue "main ist rot" (label bug) in sync with
// the newest completed Build & Push run on main.
//
//   red run   + no open issue          -> create the issue
//   red run   + open issue, unreported -> comment (run link + failed jobs)
//   green run + open issue             -> comment and close
//   anything else                      -> do nothing
//
// Two properties make it safe to run from a workflow_run trigger:
//  - Reconcile, not react: without --run-id the script ignores WHICH run woke it up and mirrors
//    the newest COMPLETED run on main. An older green run that finishes after a newer red one
//    can therefore never close the alarm, and a stale red one can never reopen it.
//  - No duplicates: the open issue is found by exact title + label through the issues list (not
//    the search API, which is indexed with a delay), every report carries a per-run-attempt
//    marker, and the workflow serializes runs through a concurrency group.
//
// Pure decision and rendering functions are exported for the fixture tests; the CLI at the bottom
// only runs when this file is executed directly, never on import.
//
// Usage: node .github/scripts/main-red-alarm.mjs [--run-id <digits>] [--dry-run]
// Environment: GITHUB_REPOSITORY (owner/name), gh authenticated (GH_TOKEN) with actions: read
// and issues: write. NEVER run it without --dry-run against the real repository for a test.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const ALARM_TITLE = "main ist rot";
export const ALARM_LABEL = "bug";
export const BUILD_PUSH_WORKFLOW_FILE = "build-push.yml";
export const BUILD_PUSH_PATH = ".github/workflows/build-push.yml";
export const RED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];
// Issue #708: a hung build ends as `cancelled` after GitHub's 6 h limit (or by hand), so a
// cancelled run is red too, unless a newer run of the workflow replaced it (see isRedRun).
export const CANCELLED_CONCLUSION = "cancelled";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_PATTERN = /^[0-9]+$/;
const FAILED_JOB_CONCLUSIONS = ["failure", "timed_out"];

/** Hidden marker that identifies one reported run attempt inside an issue body or comment. */
export function runMarker(run) {
  return `<!-- main-red-alarm:run=${run.id}:attempt=${run.run_attempt ?? 1} -->`;
}

/**
 * Find the open alarm issue. Exact title and label match only, so a hand-filed
 * "main ist rot: <details>" issue is never adopted. With two matches the lowest number wins.
 */
export function findOpenAlarmIssue(issues) {
  const matches = (issues ?? []).filter((issue) => {
    if (issue.pull_request) return false;
    if (issue.state !== undefined && issue.state !== "open") return false;
    if (issue.title !== ALARM_TITLE) return false;
    return (issue.labels ?? []).some(
      (label) => (typeof label === "string" ? label : label?.name) === ALARM_LABEL,
    );
  });
  if (matches.length === 0) return null;
  return matches.reduce((lowest, candidate) =>
    candidate.number < lowest.number ? candidate : lowest,
  );
}

/**
 * True when a newer Build & Push run on main (any status, higher run_number) exists. A cancelled
 * run that a newer push replaced is not a failure of main. `runs` is the list of recent runs.
 */
export function isSupersededRun(run, runs) {
  return (runs ?? []).some(
    (other) =>
      other.head_branch === "main" &&
      other.path === BUILD_PUSH_PATH &&
      other.run_number > run.run_number,
  );
}

/**
 * Red = a red conclusion, or `cancelled` without a newer run (Issue #708). `timed_out` is always
 * red. `superseded` is the result of isSupersededRun and only matters for `cancelled`.
 */
export function isRedRun(run, { superseded = false } = {}) {
  if (!run || run.status !== "completed") return false;
  if (RED_CONCLUSIONS.includes(run.conclusion)) return true;
  return run.conclusion === CANCELLED_CONCLUSION && !superseded;
}

/** Newest COMPLETED Build & Push run on main: highest run_number, ties broken by the higher id. */
export function selectNewestCompletedRun(runs) {
  const candidates = (runs ?? []).filter(
    (run) =>
      run.head_branch === "main" && run.status === "completed" && run.path === BUILD_PUSH_PATH,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    if (candidate.run_number !== best.run_number) {
      return candidate.run_number > best.run_number ? candidate : best;
    }
    return candidate.id > best.id ? candidate : best;
  });
}

/** A replayed run must be a completed Build & Push run on main; anything else is refused. */
export function assertReplayableRun(run) {
  if (run.head_branch !== "main") {
    throw new Error(
      `Lauf ${run.id} gehört zum Branch '${run.head_branch}', nur Läufe auf main werden gemeldet.`,
    );
  }
  if (run.path !== BUILD_PUSH_PATH) {
    throw new Error(`Lauf ${run.id} gehört nicht zum Workflow Build & Push (${run.path}).`);
  }
  if (run.status !== "completed") {
    throw new Error(`Lauf ${run.id} ist noch nicht abgeschlossen (Status '${run.status}').`);
  }
}

/** Reduce a jobs response to the failed jobs and the names of their failing steps. */
export function failedJobsOf(jobs) {
  return (jobs ?? [])
    .filter((job) => FAILED_JOB_CONCLUSIONS.includes(job.conclusion))
    .map((job) => ({
      name: job.name,
      html_url: job.html_url,
      steps: (job.steps ?? [])
        .filter((step) => FAILED_JOB_CONCLUSIONS.includes(step.conclusion))
        .map((step) => step.name),
    }));
}

/**
 * Decide what to do. `reportedTexts` are the issue body plus all its comments; a run attempt
 * whose marker is already in there is never reported twice.
 */
export function decideAlarmAction({ run, openIssue, reportedTexts, superseded = false }) {
  if (!run) {
    return { action: "noop", reason: "kein abgeschlossener Build & Push Lauf auf main gefunden" };
  }
  if (run.status !== "completed") {
    return { action: "noop", reason: "der Lauf ist noch nicht abgeschlossen" };
  }
  if (isRedRun(run, { superseded })) {
    if (!openIssue) {
      return {
        action: "create",
        reason: "Build & Push auf main ist rot und es gibt kein offenes Alarm-Issue",
      };
    }
    const marker = runMarker(run);
    if ((reportedTexts ?? []).some((text) => typeof text === "string" && text.includes(marker))) {
      return {
        action: "noop",
        reason: "dieser Lauf wurde im offenen Alarm-Issue bereits gemeldet",
      };
    }
    return {
      action: "comment",
      reason:
        "Build & Push auf main ist erneut rot, das offene Alarm-Issue bekommt einen Kommentar",
    };
  }
  if (run.conclusion === "success") {
    if (openIssue) {
      return {
        action: "close",
        reason: "Build & Push auf main ist wieder grün, das Alarm-Issue wird geschlossen",
      };
    }
    return {
      action: "noop",
      reason: "Build & Push auf main ist grün und es gibt kein offenes Alarm-Issue",
    };
  }
  if (run.conclusion === CANCELLED_CONCLUSION) {
    return {
      action: "noop",
      reason: "der Lauf wurde abgebrochen, weil ein neuerer Lauf folgte (kein Fehler von main)",
    };
  }
  return {
    action: "noop",
    reason: `Ergebnis '${run.conclusion}' ist weder rot noch grün, das Issue bleibt unverändert`,
  };
}

function runLink(run) {
  const attempt = (run.run_attempt ?? 1) > 1 ? `, Versuch ${run.run_attempt}` : "";
  return `[#${run.run_number}${attempt}](${run.html_url})`;
}

function failedJobLines(failedJobs) {
  if (!failedJobs || failedJobs.length === 0) {
    return ["  - keine Job-Details verfügbar"];
  }
  return failedJobs.map((job) => {
    const steps =
      job.steps.length > 0 ? `: Schritt ${job.steps.map((step) => `„${step}“`).join(", ")}` : "";
    return `  - [${job.name}](${job.html_url})${steps}`;
  });
}

/** Markdown for the issue body (kind "create") or a follow-up comment (kind "comment"). */
export function renderFailureText(run, failedJobs, kind) {
  const sha7 = (run.head_sha ?? "").slice(0, 7);
  const details = [
    `- Lauf: ${runLink(run)}`,
    `- Commit: \`${sha7}\``,
    `- Ergebnis: \`${run.conclusion}\``,
    "- Fehlgeschlagene Jobs:",
    ...failedJobLines(failedJobs),
  ];
  if (kind === "comment") {
    return [
      `Erneut fehlgeschlagen: „Build & Push“ auf \`main\` (${runLink(run)}).`,
      "",
      ...details,
      "",
      runMarker(run),
    ].join("\n");
  }
  return [
    "„Build & Push“ ist auf `main` fehlgeschlagen.",
    "",
    ...details,
    "",
    "---",
    "Dieses Issue wurde automatisch von `.github/workflows/main-red-alarm.yml` angelegt. " +
      "Weitere Fehlschläge auf `main` werden hier kommentiert, der nächste grüne Lauf schließt es. " +
      "Solange es offen ist, wird kein Release promotet. Hintergrund: `docs/release-process.md`.",
    "",
    runMarker(run),
  ].join("\n");
}

/** Markdown for the comment that closes the alarm issue. */
export function renderCloseText(run) {
  const sha7 = (run.head_sha ?? "").slice(0, 7);
  return (
    `„Build & Push“ ist auf \`main\` wieder grün: ${runLink(run)}, Commit \`${sha7}\`. ` +
    "Dieses Issue wird automatisch geschlossen."
  );
}

/** Parse and validate the CLI arguments; throws an Error with a German message. */
export function parseAlarmArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "run-id": { type: "string" },
        "dry-run": { type: "boolean" },
      },
    }));
  } catch (error) {
    throw new Error(`Ungültiger Aufruf: unbekannte oder unvollständige Option (${error.message}).`);
  }
  const runId = values["run-id"];
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Ungültige Lauf-ID '${runId}': erwartet werden nur Ziffern.`);
  }
  return { runId, dryRun: values["dry-run"] === true };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const DECISION_LABELS = {
  create: "Issue anlegen",
  comment: "Issue kommentieren",
  close: "Issue schließen",
  noop: "nichts tun",
};

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, input });
}

/** GET an endpoint; with `paginate` every page is flattened into one array. */
function ghGet(endpoint, { paginate = false } = {}) {
  if (paginate) {
    return JSON.parse(gh(["api", "--paginate", "--slurp", endpoint])).flat();
  }
  return JSON.parse(gh(["api", endpoint]));
}

function ghWrite(method, endpoint, body) {
  return JSON.parse(
    gh(["api", "--method", method, endpoint, "--input", "-"], JSON.stringify(body)),
  );
}

function escapeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function appendSummary(env, text) {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}

export async function main(argv, env) {
  try {
    const args = parseAlarmArgs(argv);
    const repository = env.GITHUB_REPOSITORY ?? "";
    if (!REPOSITORY_PATTERN.test(repository)) {
      throw new Error("GITHUB_REPOSITORY fehlt oder hat nicht die Form owner/name.");
    }

    let run;
    if (args.runId !== undefined) {
      run = ghGet(`repos/${repository}/actions/runs/${args.runId}`);
      assertReplayableRun(run);
      console.log(
        `Wiederholung des Laufs ${run.id}: neuere Läufe auf main werden dabei ignoriert.`,
      );
    } else {
      const response = ghGet(
        `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=20`,
      );
      run = selectNewestCompletedRun(response.workflow_runs ?? []);
    }

    const issues = ghGet(
      `repos/${repository}/issues?state=open&labels=${ALARM_LABEL}&per_page=100`,
      {
        paginate: true,
      },
    );
    const openIssue = findOpenAlarmIssue(issues);

    let superseded = false;
    if (run && run.status === "completed" && run.conclusion === CANCELLED_CONCLUSION) {
      const recent = ghGet(
        `repos/${repository}/actions/workflows/${BUILD_PUSH_WORKFLOW_FILE}/runs?branch=main&per_page=20`,
      );
      superseded = isSupersededRun(run, recent.workflow_runs ?? []);
    }
    const isRed = isRedRun(run, { superseded });
    let reportedTexts = [];
    if (isRed && openIssue) {
      const comments = ghGet(
        `repos/${repository}/issues/${openIssue.number}/comments?per_page=100`,
        {
          paginate: true,
        },
      );
      reportedTexts = [openIssue.body ?? "", ...comments.map((comment) => comment.body ?? "")];
    }

    const decision = decideAlarmAction({ run, openIssue, reportedTexts, superseded });

    let text = "";
    if (decision.action === "create" || decision.action === "comment") {
      const jobs = ghGet(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
      text = renderFailureText(run, failedJobsOf(jobs), decision.action);
    } else if (decision.action === "close") {
      text = renderCloseText(run);
    }

    const runInfo = run ? `Lauf ${run.id}, ${run.conclusion}` : "kein Lauf";
    const headline = `Entscheidung: ${DECISION_LABELS[decision.action]} – ${decision.reason} (${runInfo})`;
    console.log(headline);
    if (text) console.log(`\n${text}\n`);
    appendSummary(env, `${headline}\n\n${text}`);

    if (args.dryRun) {
      console.log("Probelauf: nichts geschrieben.");
      return 0;
    }
    if (decision.action === "noop") {
      return 0;
    }

    if (decision.action === "create") {
      const created = ghWrite("POST", `repos/${repository}/issues`, {
        title: ALARM_TITLE,
        body: text,
        labels: [ALARM_LABEL],
      });
      console.log(`Issue angelegt: ${created.html_url}`);
    } else if (decision.action === "comment") {
      const comment = ghWrite("POST", `repos/${repository}/issues/${openIssue.number}/comments`, {
        body: text,
      });
      console.log(`Kommentar geschrieben: ${comment.html_url}`);
    } else if (decision.action === "close") {
      ghWrite("POST", `repos/${repository}/issues/${openIssue.number}/comments`, { body: text });
      const closed = ghWrite("PATCH", `repos/${repository}/issues/${openIssue.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      console.log(`Issue geschlossen: ${closed.html_url}`);
    }
    return 0;
  } catch (error) {
    const detail = String(error.stderr || error.message || error)
      .trim()
      .split("\n")[0];
    console.log(`::error title=main-Alarm::${escapeData(detail)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.log(`::error title=main-Alarm::${escapeData(String(error?.message ?? error))}`);
      process.exit(1);
    },
  );
}
