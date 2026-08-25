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

## Patch releases (1.9.x)

The 1.9.x patch line does **not** merge to `main`. Instead:

1. The GitHub Release is tagged directly on `release/1.9.x` HEAD (no merge to main).
2. `build-push.yml` runs on the `release/**` push and builds `:sha-<commit>` + `:release-1.9.x`.
3. Cutting the GitHub Release then triggers `release.yml` (Promote & Publish), which `crane copy`s `:sha-<commit>` → `:X.Y.Z` / `:X.Y` / `:latest` (Trivy-scanned, digest-identical to the built image).

## What `release.yml` now does (previously "not yet")

All three items below have shipped:

- **Post-promote smoke tests** — the `smoke-test` job in `release.yml` curls `/api/v1/health` + asserts `/api/v1/version` matches the tag (Phase 70, DEVOPS-V8-05). It runs against int (`vars.INT_BASE_URL`); prod stays manual per D-04.
- **SBOM generation** — `release.yml` runs `anchore/sbom-action` to generate an SBOM for the published images (Phase 70, DEVOPS-V8-04).
- **Rollback automation** — shipped as the operator runbook `docs/prod-deploy.md` (there is no `docs/rollback.md`). It documents `crane copy` re-tag + `.env` image-var rollback paths (DEVOPS-V8-08).

## Manual rollback (superseded by `docs/prod-deploy.md`)

> **Superseded.** The full rollback runbook now lives in [`docs/prod-deploy.md`](prod-deploy.md) ("Rollback" section). Use that. The interim snippet below is kept only for quick reference.

To roll back production to a previous release `vX.Y.W`:

```bash
crane copy ghcr.io/{owner}/clokr-api:X.Y.W ghcr.io/{owner}/clokr-api:latest
crane copy ghcr.io/{owner}/clokr-web:X.Y.W ghcr.io/{owner}/clokr-web:latest
# Then reload prod-host / restart containers so they pull the new :latest digest.
```

## Getting the release onto int and prod

Steps 1-9 above produce and publish the image. They do **not** deploy it. Two manual pins follow:

- **int** — `image.tag` in `k8s-homelab/argocd-apps/clokr-app.yaml`, then commit + push. ArgoCD syncs.
- **prod** — the image tag variables in `/opt/awh-infra/.env` on `dmz-proxy`, then recreate the containers.

**Do not use `kubectl set image` on int.** The ArgoCD Application has `syncPolicy.automated` with
`selfHeal: true`; an imperative image change is reverted within seconds and the rollout silently
goes back to the pinned tag. The homelab repo is the only durable path.

## Ordering rule: bump before tag

The version is baked into the image at build time from `package.json`
(`apps/api/src/app.ts:59-65`) and served by `GET /api/v1/version`. Promotion is a digest-preserving
re-tag — **no rebuild** — so an image built _before_ the version bump keeps reporting the old
version under the new tag, and the smoke test fails correctly.

On the patch line this is easy to get wrong, because there is no PR/merge step to force the order:
push the `chore(release): bump version to X.Y.Z` commit, wait for **Build & Push** to go green on
_that_ commit, and only then tag it.

## Known behaviours that look like failures

- **The `smoke-test` job is red on a first pass, by construction.** It probes int's
  `/api/v1/version` right after promote, but int is only repointed in the manual step above. Re-run
  it after bumping int if you want it green.
- **Trivy gates on CRITICAL/HIGH.** Per `docs/cve-handling.md` the order is: update the direct
  dependency → override the transitive one (`pnpm.overrides`) → only then justify an exception in
  `.trivyignore`. Never lower the severity threshold. Note that both runtime images currently ship
  the full workspace `node_modules`, so build-only tooling shows up in scans (see ROADMAP Phase 102).
- **Prod writes are often refused for an assistant session.** Reads over ssh to `dmz-proxy` work;
  in-place edits and `compose up -d` usually do not. Hand the operator a `!`-prefixed one-liner.
- **Keep the previous image.** Never `docker image prune -a` on the prod host — the previous tag is
  the rollback path.
- **A rollback does not undo a migration.** If the release carried one, the old image runs against
  the new schema. Additive migrations tolerate that; anything else does not. Take a `pg_dump` first.

## Refreshing int with production data

`pg_dump` prod → restore into a **local** staging database → `apps/api/scripts/pseudonymize-dump.ts`
→ verify 0 real emails / 0 NFC ids / 0 usable password hashes → dump → restore to int.

**Never** restore a raw prod dump to int: int is internet-reachable and the dump carries employee
names, emails and NFC card ids. The pseudonymizer replaces those while preserving ids, employee
numbers and all time/leave/saldo data, so reports stay meaningful.

After a refresh **nobody can log in to int** — every `passwordHash` becomes `ANONYMIZED`. Create one
fresh admin; do not resurrect an existing account.

`validate-anonymization.ts` belongs to `anonymize-dump.ts` (full erasure), **not** to the
pseudonymizer — it asserts `firstName === "Gelöscht"` and will fail against pseudonymized data. The
pseudonymizer runs its own inline verification.

## References

- Workflow: `.github/workflows/release.yml`
- Workflow: `.github/workflows/build-push.yml`
- Research: `.planning/research/v1.8-pipeline-state.md` §5
- Phase: `.planning/phases/69-pr-231-nachholen-runtime-version-image-promotion/`
