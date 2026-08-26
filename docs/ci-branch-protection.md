# CI Branch Protection — Required Status Checks

Last applied: 2026-06-04 (Phase 70 — `70-07`)
Source-of-truth for which CI jobs MUST pass before a PR can merge to `main`.

> **The executable source of truth is [`scripts/apply-branch-protection.sh`](../scripts/apply-branch-protection.sh).**
>
> ```bash
> ./scripts/apply-branch-protection.sh            # read-only, non-zero exit on drift
> ./scripts/apply-branch-protection.sh --apply    # restore the intended state
> ```
>
> The script covers `main` — the only protected branch now that the 1.9.x patch line is
> retired — asserts only the required-check set, and carries every other protection
> setting forward unchanged. Prefer it over the raw `gh api` calls below: those are kept
> for reference and for recovery when `gh` behaves unexpectedly, but the check list in
> the script is the one that is actually verified.
>
> **Why this exists:** on 2026-08-26 an audit found `main` with an _empty_ required-check
> list and `release/1.9.x` with _no protection at all_, while this document still claimed
> four blocking checks on both. Prose drifts silently; a script that exits non-zero does
> not. `--check` runs as a fixed item on the sprint-rollover checklist
> (see [`PROCESS.md`](PROCESS.md)), which bounds undetected drift to one sprint.

This runbook documents the operational `gh api` commands for applying, auditing, and recovering from drift in `main` branch protection. Linked from `CLAUDE.md` § GSD Workflow Enforcement and from `docs/release-process.md`.

`release/1.9.x` is **retired** and no longer protected. It was found completely unprotected in the 2026-08-26 audit, which is moot now that it is frozen: its release tags are independent git objects that outlive the branch, and int pins a tag rather than tracking the branch. If a maintenance line is ever reopened, add it to `BRANCHES` in the script rather than protecting it by hand.

## Required checks (Phase 70 baseline)

| Check         | Workflow | Job           | Why required                                                                                                                                                                                                                                                   |
| ------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`        | ci.yml   | `test`        | Pre-merge quality + security gate: ESLint API + Web, Prettier `--check`, UI primitives lint, tsc API + Web, Vitest coverage ≥ 40%, `pnpm audit --audit-level high`, Trivy FS scan, Build API + Build Web                                                       |
| `codeql`      | ci.yml   | `codeql`      | SAST — CodeQL semantic vulnerability analysis (DEVOPS-V8-04). Uploads SARIF to GitHub Security tab.                                                                                                                                                            |
| `secret-scan` | ci.yml   | `secret-scan` | gitleaks v3 scan of PR diff for leaked credentials (DEVOPS-V8-04). Uploads SARIF to GitHub Security tab.                                                                                                                                                       |
| `docker-gate` | ci.yml   | `docker-gate` | Stable context for the `docker` matrix build, which validates that `apps/api/Dockerfile` and `apps/web/Dockerfile` compile (no push) and warms the GHA cache for the later `build-push.yml` run. See the caveat below — require `docker-gate`, never `docker`. |

Note: `visual-regression` was previously listed in this table as merge-blocking, but it was
never present in the `gh api` payload below and is not in the script's check list — the table
and the payload contradicted each other. It is **advisory**. The job is technically eligible
(it always reports a status; only its _steps_ are path-filtered, so it never hangs as
"pending"), but its baselines are recorded on arm64 locally and replayed on amd64 in CI, so
it fails for reasons unrelated to the change under review. Promoting it to blocking is a
baseline fix — see `docs/visual-regression-workflow.md` — not a protection change.

Note: the `docker` PR-gate job is in `ci.yml`, not `build-push.yml`. `build-push.yml` runs ONLY on push to `main` (after merge) and is therefore not a PR-blocking candidate. Trivy container-scan results from `build-push.yml` are post-merge and surface via the GitHub Security tab.

### Never require `docker` — require `docker-gate`

`docker` is a **matrix** job. GitHub does not report a check run under a matrix job's bare
name when it runs; it reports one per leg, named after the entire `include` entry:

```
docker (clokr-api, ./apps/api/Dockerfile, .)
docker (clokr-web, ./apps/web/Dockerfile, .)
```

A required context that is never reported never resolves — the PR sits at "Expected —
waiting for status to be reported" indefinitely, and no amount of re-running fixes it.
The `gh api` payload further down this page asked for the bare `docker`, which is the
most likely reason the 2026-08-26 audit found `main` with an empty check list: applied
once, everything jammed, list cleared, prose left standing.

The leg names are also brittle — editing a Dockerfile path changes the check name and
silently breaks protection. `ci.yml` therefore carries a tiny `docker-gate` job whose only
job is to be a stable context: it `needs: docker`, runs with `if: always()`, and fails
unless the matrix succeeded. **Require `docker-gate`.** The reference payload below has been
corrected accordingly, but prefer the script — it verifies before it writes.

The script enforces this: `--apply` compares every configured context against check names
actually observed across recent PRs and refuses rather than freezing the branch. A
consequence worth knowing: a newly added check must have run at least once before it can
be required.

## Coupled setting: Actions may create pull requests

`release-please` opens the standing release PR, which requires
**Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**.
It was enabled on 2026-08-26 (`can_approve_pull_request_reviews: true`;
`default_workflow_permissions` deliberately left at `read` — workflows declare their own
permissions).

GitHub bundles _create_ and _approve_ into that single toggle. There is no way to permit one
without the other, so enabling it also lets any workflow in this repository approve a pull
request.

**That is acceptable only while `required_approving_review_count` is 0.** With zero required
reviews a self-approving workflow gains nothing — there is no gate to bypass. The moment that
count is raised, this toggle becomes a hole in the new requirement: a workflow could satisfy it
without a human ever looking.

> **If you ever require approving reviews on `main`, revisit this.** The alternative is a
> fine-grained PAT or GitHub App token for release-please alone, which keeps the global toggle
> off. Do not raise the review count and leave this enabled.

The `Dependabot Auto-Merge` workflow deliberately does **not** approve, even though it now
could — see its header comment.

## NOT required (advisory in Phase 70)

| Check        | Workflow | Job          | Promotion path                                                                                                                                                         |
| ------------ | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lighthouse` | ci.yml   | `lighthouse` | Phase 73 — remove `continue-on-error: true` and flip `lighthouserc.json` thresholds from `warn` → `error`. Extend to authenticated pages via docker-compose webServer. |
| `axe-scan`   | ci.yml   | `axe-scan`   | Phase 73 — remove `continue-on-error: true` and tighten the spec assertion from advisory to `expect(violations).toEqual([])`.                                          |

These jobs run on every PR but their failures do not block merging in Phase 70.

## Apply / re-apply command

The command below is **idempotent** — safe to re-run at any time. It preserves the existing `required_pull_request_reviews` settings (Phase 70 pre-state: `required_approving_review_count: 0`, `dismiss_stale_reviews: false`, `require_code_owner_reviews: false`, `require_last_push_approval: false`).

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/sebastianzabel/clokr/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "test", "app_id": -1 },
      { "context": "codeql", "app_id": -1 },
      { "context": "secret-scan", "app_id": -1 },
      { "context": "docker-gate", "app_id": -1 }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null
}
EOF
```

### Pre-flight snapshot (always run before re-applying)

GitHub's branch-protection PUT API requires the **full** settings object — fields not included are reset to their defaults. Always snapshot the current state and copy any non-null fields into the PUT body before re-applying:

```bash
gh api /repos/sebastianzabel/clokr/branches/main/protection > /tmp/branch-protection-before.json
cat /tmp/branch-protection-before.json | jq '{required_pull_request_reviews, enforce_admins, restrictions}'
```

If `required_pull_request_reviews` is non-null (it is in Phase 70 pre-state), copy the **inner fields** (`required_approving_review_count`, `dismiss_stale_reviews`, …) into the PUT body. The `url` field returned by the API is read-only and must be omitted from the PUT input.

`app_id: -1` means "any GitHub App may post this check" — required for GitHub Actions context names that are not bound to a specific app. Future hardening pass may tighten to `app_id: 15368` (GitHub Actions app).

## Audit command

```bash
./scripts/apply-branch-protection.sh          # preferred — exits non-zero on drift
```

The raw equivalent:

```bash
gh api /repos/sebastianzabel/clokr/branches/main/protection \
  --jq '.required_status_checks.checks[].context' | sort
```

Expected output (one per line, sorted):

```
codeql
docker-gate
secret-scan
test
```

`docker-gate`, not `docker` — see "Never require `docker`" above.

If output is empty or missing any of these → re-run the Apply command above.

Lighthouse + axe-scan MUST NOT appear in the audit output during Phase 70:

```bash
gh api /repos/sebastianzabel/clokr/branches/main/protection \
  --jq '.required_status_checks.checks[].context' | grep -cE '^(lighthouse|axe-scan)$'
# Expected: 0
```

## When this list changes

| Trigger                                              | Action                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Phase 73 ships `axe-scan` + `lighthouse` as blocking | Add `lighthouse` + `axe-scan` to the `checks` array; re-apply.                                   |
| Phase 73 adds new E2E job (e.g. `e2e-tests`)         | Add the new job context to the `checks` array; re-apply.                                         |
| A workflow job is renamed                            | Update both the workflow file AND this runbook in the same PR; re-apply after the rename merges. |
| A workflow job is removed                            | Remove from this list; re-apply. (Otherwise PRs block forever on a non-existent check.)          |
| Required-approving-review-count raised               | Update `required_approving_review_count` in the PUT body above before re-applying.               |

## Why `required_status_checks.strict: true`

`strict: true` means PRs must be up-to-date with `main` before merging. This prevents the "tests passed at PR head but main moved on incompatibly" foot-gun. Already true in the Phase 70 pre-state — preserved.

## Why `enforce_admins: false`

Admins can override branch protection for emergency hotfixes. Phase 70 preserves the pre-state value (`enabled: false`). To flip on, set `"enforce_admins": true` in the PUT body. Caveat: with `enforce_admins: true`, even `sebastianzabel` cannot push hotfixes directly to `main` — every change must go via PR + green checks.

## Dependabot interaction

Dependabot PRs respect required checks: the existing `dependabot-auto-approve.yml` workflow auto-merges Dependabot PRs ONLY AFTER all required checks pass. Adding new required checks tightens but does not break the auto-merge flow.

## Disaster recovery

If branch protection is accidentally deleted or reset to defaults:

1. Snapshot whatever state is currently set (see Pre-flight snapshot section).
2. Compare against the canonical state documented in this file.
3. Re-run the Apply command — it is idempotent.
4. Verify via the Audit command.
5. Open a tiny no-op PR (whitespace change to this doc) to confirm the "Merge" button is blocked until checks pass; close without merging once verified.

## Files

- `.github/workflows/ci.yml` — defines the required jobs (`test`, `codeql`, `secret-scan`, `docker-gate`) plus the advisory `visual-regression`, `lighthouse` and `axe-scan`. The `docker` matrix job is required indirectly, through `docker-gate`.
- `scripts/apply-branch-protection.sh` — the executable check list; `--check` audits, `--apply` restores.
- `.github/workflows/build-push.yml` — runs post-merge on push to `main`; not a PR-gate candidate.
- `docs/cve-handling.md` — companion runbook for `.trivyignore` exceptions surfaced by these gates.
- `docs/release-process.md` — companion runbook for the release flow that depends on these gates being green.
