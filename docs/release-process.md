# Release Process

**Audience:** maintainers cutting a Clokr release.
**Time to skim:** under 2 minutes.

## Rationale

The shipping image is bit-identical to the image that passed the Trivy scan on merge. We promote by re-tagging (`crane copy`) instead of rebuilding, so the release artifact is provably the artifact that was scanned. Image content is the source of truth — see memory note `feedback_image_content_is_source_of_truth` and Phase 68 research (`.planning/research/v1.8-pipeline-state.md` §1.3).

## Flow

1. **Branch from current main.** `git checkout main && git pull && git checkout -b release/vX.Y.Z`.
2. **Bump versions** in all three `package.json` files (root, `apps/api`, `apps/web`) to the same value `X.Y.Z`.
3. **Open PR** with title `chore(release): vX.Y.Z`. Wait for `ci.yml` to pass.
4. **Merge PR** to `main`. The merge commit is the release commit.
5. **`build-push.yml` runs automatically** on the merge. It builds both images and pushes `ghcr.io/{owner}/clokr-api:sha-{SHA}` and `ghcr.io/{owner}/clokr-web:sha-{SHA}`. Trivy scans both.
6. **Wait for `build-push.yml` to finish green.** Required — release promotion needs the `:sha-{SHA}` images on GHCR.
7. **Cut a GitHub Release** with tag `vX.Y.Z`. **The tag MUST point at the merge commit** from step 4 (memory note `feedback_release_tag_on_main`).
8. **`release.yml` runs automatically** on the published release. It runs `crane copy` for both `clokr-api` and `clokr-web`, tagging each with `:X.Y.Z`, `:X.Y`, and `:latest`. No rebuild.
9. **Verify:** `curl https://{your-host}/api/v1/version` returns `{"version":"X.Y.Z"}`. The Sidebar in the web UI shows `vX.Y.Z` below the logout button.

## What `release.yml` does NOT do (yet)

- Post-promote smoke tests (curl `/api/v1/health` + `/api/v1/version`-matches-tag assertion). **TODO:** Phase 70 (DEVOPS-V8-05).
- SBOM attachment to the GitHub Release. **TODO:** Phase 70 (DEVOPS-V8-04).
- Rollback automation. **TODO:** Phase 71 — see `docs/rollback.md` once it lands (DEVOPS-V8-08).

## Manual rollback (interim, until Phase 71 lands)

To roll back production to a previous release `vX.Y.W` while the rollback runbook is still pending:

```bash
crane copy ghcr.io/{owner}/clokr-api:X.Y.W ghcr.io/{owner}/clokr-api:latest
crane copy ghcr.io/{owner}/clokr-web:X.Y.W ghcr.io/{owner}/clokr-web:latest
# Then reload prod-host / restart containers so they pull the new :latest digest.
```

## References

- Workflow: `.github/workflows/release.yml`
- Workflow: `.github/workflows/build-push.yml`
- Research: `.planning/research/v1.8-pipeline-state.md` §5
- Phase: `.planning/phases/69-pr-231-nachholen-runtime-version-image-promotion/`
