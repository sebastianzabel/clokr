# Release Process

**Audience:** maintainers cutting a Clokr release.
**Time to skim:** under 2 minutes.

## Rationale

The shipping image is bit-identical to the image that passed the Trivy scan on merge. We promote by re-tagging (`crane copy`) instead of rebuilding, so the release artifact is provably the artifact that was scanned. Image content is the source of truth — see memory note `feedback_image_content_is_source_of_truth` and Phase 68 research (`.planning/research/v1.8-pipeline-state.md` §1.3).

## Flow

**Cutting a release is a merge, not a procedure.** `release-please` keeps a PR titled
`chore(main): release X.Y.Z` permanently open against `main`, rewriting it on every push.

1. **Check the release PR.** It shows the next version (derived from the Conventional Commit
   history) and the `CHANGELOG.md` it will write. Nothing to bump by hand.
2. **Write the German release notes into the repo.** The open release PR already shows the next
   version. Write `docs/release-notes/vX.Y.Z.md` per
   [`RELEASE_NOTES_TEMPLATE.md`](RELEASE_NOTES_TEMPLATE.md) and land it on `main` as
   `docs(release): add release notes for vX.Y.Z`. A `docs:` commit does not bump the version, so
   the release PR keeps saying X.Y.Z.
   `.github/workflows/release-notes-guard.yml` fails the release PR while the file is missing.
3. **Merge the release PR.** That single act:
   - bumps the version in all three `package.json` files (root, `apps/api`, `apps/web`)
   - commits `CHANGELOG.md`
   - creates tag `vX.Y.Z` and publishes the GitHub Release
4. **`build-push.yml`** runs on the merge, builds both images, pushes
   `ghcr.io/{owner}/clokr-{api,web}:sha-{SHA}`, Trivy scans them. The API image also bakes
   `docs/release-notes/` into itself via `apps/api/Dockerfile` — the notes file from step 2 is
   already on `main` by the time this build runs, so it is inside the image it describes.
5. **`release.yml` promotes.** It **waits** for the `:sha-{SHA}` image to appear (up to 30 min),
   then `crane copy`s it to `:X.Y.Z`, `:X.Y` and `:latest`. No rebuild — the shipped image is
   bit-identical to the scanned one.
6. **`release.yml`'s `publish-notes` job sets the GitHub Release title and body** from
   `docs/release-notes/vX.Y.Z.md` — the same file baked into the image in step 4. Nothing is
   written by hand at this point; this REPLACES the former manual step, it is not an extra one.
7. **Verify:** `curl https://{your-host}/api/v1/version` returns `{"version":"X.Y.Z"}`. The
   Sidebar shows `vX.Y.Z` below the logout button.

### Why the notes moved in front of the build

The old step 5 wrote the German release notes onto an already-published GitHub Release, by
hand — but that Release, and the image for that version, already existed by then. Measured
across the last three releases before this change, `build-push.yml` had already built and
Trivy-scanned the image 11–16 minutes before anyone touched the notes (v1.9.18 17:53→18:05,
v1.9.17 10:10→10:25, v1.9.16 22:12→22:29 — release created → notes published). An image can
never contain notes that did not exist yet when it was built, and the in-app What's-New dialog
needs exactly that: notes baked into the image, not fetched at runtime (see `docs/release-notes/`
and Phase 110). Writing the notes on `main` before the release-please PR merges — the same commit
`build-push.yml` builds from — is what makes the in-app text and the GitHub Release body one
truth instead of two.

This REPLACES a manual step; it does not add one. The rest of the pipeline is unchanged: the
version is still bumped before the tag (step 3), and promotion (step 5) is still a
digest-preserving re-tag with no rebuild.

### Why release.yml waits for the image

The bump-before-tag rule below still holds — it is just enforced by machinery now instead of by
memory. But automation changed the timing: a human cut the Release only _after_ Build & Push was
green, so the `:sha-` image was always already there. release-please publishes the Release the
instant its PR merges — the same push that _starts_ the build. Promote now reliably arrives
first, so it polls for the image rather than failing on a source tag that does not exist yet.
The two runs are triggered by different events and cannot `needs:` one another.

If that wait ever times out, Build & Push failed or never ran. Fix that; do not promote a
different image.

### Version scheme

One shared version across root, `apps/api` and `apps/web` — release-please bumps the root and
carries the other two via `extra-files` (`release-please-config.json`). The version is a
_deployment_ fact here, not a package fact: it is baked into the image and asserted against the
tag by the smoke test, so letting the three drift apart would break that check. `packages/db`,
`packages/types` and `packages/mcp` are internal and keep their own fixed versions.

Only `feat`, `fix`, `perf` and `refactor` appear in the changelog. `docs`, `test`, `chore`,
`ci`, `build` and `style` are recorded in git and hidden from it.

## Patch releases — RETIRED (historical)

> **The 1.9.x patch line is retired as of 2026-08-26.** `main` was resynced to
> `release/1.9.x` (PR #31) and is now the single line: patches, minors and majors all
> branch from `main`, merge back to `main`, and are tagged there per the Flow above.
> There is no separate patch branch to remember, and no second place for a release to
> come from.
>
> `release/1.9.x` remains as frozen history. Its tags (`v1.9.0`…`v1.9.18`) are independent
> git objects and stay valid — rollback via `crane copy` from any of them is unaffected.
>
> The old flow is kept below for reading releases cut before that date.

The 1.9.x patch line did **not** merge to `main`. Instead:

1. The GitHub Release was tagged directly on `release/1.9.x` HEAD (no merge to main).
2. `build-push.yml` ran on the `release/**` push and built `:sha-<commit>` + `:release-1.9.x`.
3. Cutting the GitHub Release then triggered `release.yml` (Promote & Publish), which `crane copy`d `:sha-<commit>` → `:X.Y.Z` / `:X.Y` / `:latest` (Trivy-scanned, digest-identical to the built image).

`build-push.yml` still triggers on `release/**` pushes. That trigger is harmless and is left
in place so a maintenance line can be reopened without a workflow change.

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

Steps 1-7 above produce and publish the image. They do **not** deploy it. Two manual pins follow:

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
- Workflow: `.github/workflows/release-notes-guard.yml`
- Corpus: `docs/release-notes/README.md`
- Research: `.planning/research/v1.8-pipeline-state.md` §5
- Phase: `.planning/phases/69-pr-231-nachholen-runtime-version-image-promotion/`
- Phase: `.planning/phases/110-release-notes-in-der-app-anzeigen/`
