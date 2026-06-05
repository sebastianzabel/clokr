# Visual Regression Workflow

Phase 75 (2026-06) introduced a Playwright `toHaveScreenshot()` baseline net
covering 10 design-critical pages. This document is the operator runbook for
the gate. For the why (decisions D-01..D-07), read
`.planning/phases/75-visual-regression/75-CONTEXT.md`.

## TL;DR

- CI runs the `visual-regression` job on every PR that touches
  `apps/web/**`, `apps/web/src/tokens.css`, or `apps/e2e/**` (D-06).
- The job runs inside the pinned `mcr.microsoft.com/playwright:v1.60.0-jammy`
  image so font rasterization is byte-identical across macOS dev, Linux dev,
  and the GitHub Actions runner (D-02).
- Default diff threshold: **0.2 %** `maxDiffPixelRatio` (per-test override
  allowed, document the WHY) (D-04).
- If the job fails, the PR cannot merge until you either fix the regression
  or re-baseline with a written rationale (D-05).
- The pinned image tag MUST stay in sync with the `@playwright/test`
  version in `apps/e2e/package.json` and the `FROM` line in
  `apps/e2e/Dockerfile.visual`. Bumping one without the others is a
  guaranteed failure mode.

## When the gate is green

Nothing to do. Merge.

## When the gate is red

### Step 1 — Look at the diff

Download the `visual-regression-diffs` artifact from the failing PR's
**Actions** tab (14-day retention). Each failing spec produces three PNGs
in `apps/e2e/test-results/`:

- `<spec>-expected.png` — the committed baseline
- `<spec>-actual.png` — what the new code rendered
- `<spec>-diff.png` — pixel-level highlight of the difference

You can also pull `visual-regression-report` (the Playwright HTML report)
for a side-by-side view of every failing assertion plus the test trace.

Open `<spec>-diff.png` and decide:

| What you see                                                                                              | What it means                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Highlighted pixels match your intentional change (e.g. you moved a button)                                | Intentional regression — go to Step 2                         |
| Highlighted pixels are unrelated to your change (e.g. you only touched the API but the dashboard shifted) | Suspicious regression — go to Step 3                          |
| Highlighted pixels are tiny (1-2 px shifts on text edges) and the threshold is already 0.2 %              | Sub-pixel anti-aliasing noise — see "Tuning thresholds" below |

### Step 2 — Approving an intentional change (D-05)

Re-baseline locally, inspect every PNG by eye, commit with a written
rationale. The PR diff then shows the baseline PNG change and the
commit message explains it.

```bash
# Make sure the dev stack is running (api + web + postgres)
docker compose up --build -d

# Re-capture all 10 baselines
docker compose -f docker-compose.e2e.yml run --rm e2e-visual \
  pnpm --filter e2e exec playwright test --project=visual --update-snapshots

# OR scope to one spec (faster iteration)
docker compose -f docker-compose.e2e.yml run --rm e2e-visual \
  pnpm --filter e2e exec playwright test --project=visual \
  -g "01 — Dashboard" --update-snapshots

# Visually inspect every changed PNG BEFORE committing
git diff --stat apps/e2e/tests/visual.spec.ts-snapshots/

# Commit with rationale (D-05 — the WHY lives in the commit message)
git add apps/e2e/tests/visual.spec.ts-snapshots/
git commit -m "feat(<phase-or-area>): re-baseline <page> after <change>

<one or two sentences on WHY this baseline moved>"
git push
```

The reviewer's job: confirm the new PNG matches the intent stated in
the commit message. If yes, approve.

### Step 3 — Escalating a suspicious diff

If the diff highlights pixels that have nothing to do with your change:

1. **Do not re-baseline.** Re-baselining hides the bug.
2. Check for recent token changes: `git log -p apps/web/src/tokens.css`.
3. Check for a Playwright version bump in `apps/e2e/package.json` — the
   pinned image, the `FROM` in `apps/e2e/Dockerfile.visual`, and the
   npm dep version must all match. A drift here can shift glyph
   rasterization and trip every baseline at once.
4. Check that the dev stack is healthy locally — sometimes a stale
   Prisma client or missing migration renders broken UI that looks
   like a "regression" but is actually a data-shape bug.
5. Confirm the deterministic seed (`apps/e2e/fixtures/visual-seed.ts`)
   ran — non-deterministic data is the most common silent break.
6. If still unclear: open a `bug/visual-suspicious-diff` issue, attach
   the three PNGs, link the failing CI run, and block the PR until
   triaged. Do not merge.

### Step 4 — Tuning thresholds

Default: `maxDiffPixelRatio: 0.002` (0.2 %) — set on the `visual`
project in `apps/e2e/playwright.config.ts`.

Per-test override (use sparingly, document the WHY):

```ts
await expect(page).toHaveScreenshot("06-schichtplan-wochen-grid.png", {
  fullPage: true,
  maxDiffPixelRatio: 0.005, // 0.5% — wide grid with heavy text anti-aliasing
});
```

Wider thresholds erode the signal. If you find yourself reaching for
`>0.005` repeatedly, that's a hint the baseline or the test setup is
wrong, not the threshold.

## Token v1.5 changes (special case)

A real change to `apps/web/src/tokens.css` (color/spacing/radius
shift, not a whitespace edit) will almost always trip ALL 10 baselines
at once. This is expected behaviour, not a bug. Standard process:

1. PR description explains the token change and which surfaces it
   affects.
2. Re-baseline all 10 pages in a single commit (`--update-snapshots`
   on the full visual project).
3. Commit message:
   `feat(tokens): adjust --brand from #X to #Y — Phase YY`.
4. Reviewer spot-checks 2-3 pages (not all 10) against the PR
   description and approves.

## Anatomy of the gate

| Component      | Where                                                                | Why                                                |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Pinned image   | `apps/e2e/Dockerfile.visual`                                         | Font rendering must be byte-identical              |
| Visual project | `apps/e2e/playwright.config.ts` (`projects` array, `name: "visual"`) | Fixed viewport 1440×900, `reducedMotion: "reduce"` |
| Freeze hook    | `apps/e2e/tests/visual.setup.ts`                                     | Per-test animation/transition/caret kill-switch    |
| Seed helper    | `apps/e2e/fixtures/visual-seed.ts`                                   | Byte-stable DB state on every run (D-07)           |
| Specs          | `apps/e2e/tests/visual.spec.ts`                                      | 10 `toHaveScreenshot()` calls (D-01)               |
| Baselines      | `apps/e2e/tests/visual.spec.ts-snapshots/visual/`                    | Authoritative reference; tracked in git            |
| CI gate        | `.github/workflows/ci.yml` (job `visual-regression`)                 | Path-filtered (D-06)                               |

## FAQ

- **Why not Chromatic / Percy?** Built-in Playwright is free, lives in
  the repo, and was the v1.8 roadmap recommendation. Re-evaluate if
  the manual diff-review load becomes painful or if the 10-page net
  grows past a single reviewer's capacity.
- **Why 10 pages and not all of them?** the operator's most re-checked
  surfaces (per D-01). More pages = more diff-review load per PR. The
  net can grow in a follow-up phase if a specific page becomes a
  regression hotspot.
- **Why does the gate not block API-only PRs?** The path filter
  excludes anything outside `apps/web/**` / `apps/web/src/tokens.css`
  / `apps/e2e/**` / `docker-compose.e2e.yml` / `ci.yml` itself (D-06).
  No CI minutes wasted on unrelated changes.
- **What if the `e2e-visual` image build fails in CI?** Investigate
  the Docker pull (likely the pinned image tag drifted or the registry
  is down). The pinned tag is `v1.60.0-jammy`. Do NOT chase a moving
  target without re-baselining all 10 PNGs.
- **What if the visual job's status shows `in_progress` in the CI
  Summary comment?** The summary step in the `test` job races the
  visual job (they run in parallel by design). Re-running the summary
  step (or re-running the workflow) refreshes the comment with the
  final outcome.
