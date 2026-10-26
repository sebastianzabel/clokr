// Board hygiene list for the sprint change (Issue #712): a MEASURED list instead of eyeballing.
//
// Written into the sprint checklist issue by .github/workflows/sprint-rollover.yml. Sections:
//   1. closed cards without a sprint, or in a sprint that does not contain their close date
//   2. Ready cards in an expired sprint, with the days they sat in Ready ("Liegezeit")
//   3. Ready cards older than one sprint: decide "this sprint" or "back to Backlog"
//   4. open sprint checklists of earlier sprints
//   5. size of the Inbox
//   6. open issues without a milestone that are not deliberately in the Backlog
//
// The Ready date comes from the project's status-change timeline events; Projects v2 has no
// "status changed at" field. Pure functions are exported for the fixture tests; the CLI at the
// bottom only runs when this file is executed directly, never on import.
//
// Usage: node .github/scripts/sprint-hygiene.mjs [--dry-run] [--exclude-title <title>]
//          [--owner <login>] [--project <number>] [--repo <owner/name>]
// Environment: GH_TOKEN (repo read). BOARD_TOKEN (optional) reads the user-owned project; the
// default Actions token cannot, so without it only the repository-based sections are measured.
// --dry-run only documents intent: the script never writes anything to GitHub, it prints.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SPRINT_DAYS = 14;
export const CLOSED_LOOKBACK_DAYS = 28;
const DAY_MS = 86_400_000;

/** Whole days between two instants, never negative. */
export function daysBetween(from, to) {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/** Last time a card moved INTO Ready, from its status-change events (any order); null if none. */
export function readySince(events) {
  const times = (events ?? [])
    .filter((e) => e && e.status === "Ready" && e.createdAt)
    .map((e) => Date.parse(e.createdAt));
  return times.length ? Math.max(...times) : null;
}

function iterationEnd(it) {
  return Date.parse(it.startDate) + it.duration * DAY_MS;
}

/** Normalise one raw project node into the flat shape the sections work on. */
export function normalizeItem(node) {
  const c = node.content;
  if (!c || c.number == null) return null;
  // The checklist issues themselves are bookkeeping, not delivery.
  if (/^Sprint-Wechsel KW /.test(c.title)) return null;
  const it = node.iteration;
  return {
    number: c.number,
    title: c.title,
    open: c.state === "OPEN",
    closedAt: c.closedAt ? Date.parse(c.closedAt) : null,
    milestone: c.milestone?.title ?? null,
    status: node.status?.name ?? null,
    iteration: it
      ? { title: it.title, start: Date.parse(it.startDate), end: iterationEnd(it) }
      : null,
    readySince: readySince(c.timelineItems?.nodes),
  };
}

/** Closed recently, but without a sprint or in a sprint that does not contain the close date. */
export function doneWithoutSprint(items, now) {
  const since = now - CLOSED_LOOKBACK_DAYS * DAY_MS;
  return items.filter((i) => {
    if (i.open || i.closedAt == null || i.closedAt < since) return false;
    if (!i.iteration) return true;
    return i.closedAt < i.iteration.start || i.closedAt >= i.iteration.end;
  });
}

/** Ready cards with their Liegezeit; `overdue` when it exceeds one sprint. */
export function readyCards(items, now) {
  return items
    .filter((i) => i.open && i.status === "Ready")
    .map((i) => {
      const days = i.readySince == null ? null : daysBetween(i.readySince, now);
      return {
        ...i,
        days,
        overdue: days != null && days > SPRINT_DAYS,
        inExpiredSprint: i.iteration != null && i.iteration.end <= now,
      };
    })
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.number - b.number);
}

/** Inbox = status Inbox, or on the board without any status. Open issues only. */
export function inboxCount(items) {
  return items.filter((i) => i.open && (i.status === "Inbox" || i.status == null)).length;
}

/**
 * Open issues without a milestone that do not sit deliberately in the Backlog.
 * `repoIssues` is the repository's open issue list; the board status is joined by number, an
 * issue that is not on the board counts as "not deliberately Backlog".
 */
export function withoutMilestone(repoIssues, items) {
  const status = new Map(items.map((i) => [i.number, i.status]));
  return repoIssues
    .filter((r) => !r.milestone && status.get(r.number) !== "Backlog")
    .filter((r) => !(r.labels ?? []).some((l) => (l.name ?? l) === "sprint"))
    .map((r) => ({ number: r.number, title: r.title, status: status.get(r.number) ?? null }))
    .sort((a, b) => a.number - b.number);
}

/** Open sprint checklists other than the one just being created. */
export function earlierChecklists(sprintIssues, excludeTitle) {
  return sprintIssues.filter((s) => s.title !== excludeTitle).sort((a, b) => a.number - b.number);
}

const ref = (i) => `#${i.number} ${i.title}`;

function section(title, lines, empty) {
  return [`**${title}**`, ...(lines.length ? lines : [`- ${empty}`]), ""];
}

/** Render the German markdown block. `board` is null when the board could not be read. */
export function renderHygiene({ items, board, repoIssues, sprintIssues, excludeTitle, now }) {
  const out = ["### Board-Hygiene (gemessen)", ""];
  if (board) {
    const done = doneWithoutSprint(items, now).map(
      (i) =>
        `- [ ] ${ref(i)} — ${i.iteration ? `Sprint „${i.iteration.title}“ passt nicht zum Schließdatum` : "ohne Sprint"}`,
    );
    out.push(...section("Erledigt ohne bzw. mit falschem Sprint", done, "keine"));

    const ready = readyCards(items, now);
    const fmt = (c) =>
      `- [ ] ${ref(c)} — Ready seit ${c.days == null ? "unbekannt" : `${c.days} Tg.`}${c.overdue ? " ⚠ länger als ein Sprint" : ""}${c.inExpiredSprint ? `, Sprint „${c.iteration.title}“ abgelaufen` : ""}`;
    out.push(...section("Ready-Karten (Liegezeit)", ready.map(fmt), "keine Karte im Status Ready"));
    const stale = ready.filter((c) => c.overdue);
    out.push(
      ...section(
        "Ready länger als ein Sprint — Entscheidung: „diesen Sprint“ oder „zurück ins Backlog“",
        stale.map((c) => `- [ ] ${ref(c)} (${c.days} Tg.): diesen Sprint / zurück ins Backlog`),
        "keine",
      ),
    );
  } else {
    out.push(
      "_Board nicht lesbar (Secret `PROJECT_READ_TOKEN` fehlt oder ist abgelaufen). Die Abschnitte zu Sprint-Zuordnung, Ready-Liegezeit und Inbox entfallen._",
      "",
    );
  }

  const earlier = earlierChecklists(sprintIssues, excludeTitle).map(
    (s) => `- [ ] #${s.number} ${s.title} — schließen oder abarbeiten`,
  );
  out.push(...section("Offene Sprint-Checklisten früherer Sprints", earlier, "keine"));

  if (board) out.push(`**Inbox:** ${inboxCount(items)} offene Karten`, "");

  // Without a readable board the status is unknown, so the Backlog exemption cannot be applied.
  const nomile = withoutMilestone(repoIssues, items).map(
    (i) => `- [ ] ${ref(i)}${i.status ? ` (${i.status})` : board ? " (nicht auf dem Board)" : ""}`,
  );
  out.push(...section("Offene Issues ohne Milestone, nicht bewusst im Backlog", nomile, "keine"));
  return out.join("\n");
}

const PROJECT_QUERY = `query($login:String!,$number:Int!,$after:String){
  user(login:$login){ projectV2(number:$number){
    items(first:10, after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{
        status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
        iteration: fieldValueByName(name:"Iteration"){ ... on ProjectV2ItemFieldIterationValue{ title startDate duration } }
        content{ ... on Issue{
          number title state closedAt milestone{ title }
          timelineItems(last:15, itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){
            nodes{ ... on ProjectV2ItemStatusChangedEvent{ createdAt status } } }
        } }
      }
    }
  } }
}`;

// GitHub answers 502/504 for a heavy project query now and then; retry before giving up.
function gh(args, token) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

function fetchBoardItems({ owner, project, token }) {
  const items = [];
  let after = null;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${PROJECT_QUERY}`,
      "-F",
      `login=${owner}`,
      "-F",
      `number=${project}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const res = JSON.parse(gh(args, token));
    const page = res.data?.user?.projectV2?.items;
    if (!page) throw new Error("project not readable");
    items.push(...page.nodes.map(normalizeItem).filter(Boolean));
    if (!page.pageInfo.hasNextPage) return items;
    after = page.pageInfo.endCursor;
  }
}

function fetchIssues(repo, extra) {
  const out = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,milestone,labels",
    ...extra,
  ]);
  return JSON.parse(out);
}

export function parseHygieneArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "exclude-title": { type: "string", default: "" },
      owner: { type: "string", default: "sebastianzabel" },
      project: { type: "string", default: "1" },
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "sebastianzabel/clokr" },
    },
  });
  return {
    dryRun: values["dry-run"],
    excludeTitle: values["exclude-title"],
    owner: values.owner,
    project: Number(values.project),
    repo: values.repo,
  };
}

function main() {
  const o = parseHygieneArgs(process.argv.slice(2));
  const now = Date.now();
  const boardToken = process.env.BOARD_TOKEN;
  let items = [];
  let board = false;
  try {
    items = fetchBoardItems({ owner: o.owner, project: o.project, token: boardToken });
    board = true;
  } catch (err) {
    console.error(`board not read: ${String(err.message).split("\n")[0]}`);
  }
  const repoIssues = fetchIssues(o.repo, []);
  const sprintIssues = fetchIssues(o.repo, ["--label", "sprint"]);
  process.stdout.write(
    renderHygiene({ items, board, repoIssues, sprintIssues, excludeTitle: o.excludeTitle, now }) +
      "\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
