# Integration Environment (int)

The `int` environment is the integration / pre-production cluster for clokr. It runs on the k3s homelab cluster via ArgoCD GitOps sync, tracking the `release/1.9.x` branch, with anonymized data refreshed from prod (Phase 72).

## TL;DR

- **URL:** `https://clokr-int.example.com`
- **Cluster:** k3s in the homelab
- **Source of truth:** `https://github.com/sebastianzabel/clokr` (public), branch `release/1.9.x`
- **Helm chart:** `charts/clokr-app/` in the clokr repo (single umbrella chart)
- **ArgoCD Application:** `argocd-apps/clokr-app.yaml` in the `git.internal/home/homelab` repo
- **Version check:** manual `curl` of `/api/v1/version` after the int pin, see `docs/release-process.md` ("Getting the release onto int and prod")

## How int Differs From dev and prod

| Aspect          | dev                  | int                                                                      | prod                      |
| --------------- | -------------------- | ------------------------------------------------------------------------ | ------------------------- |
| Runtime         | Local Docker Compose | k3s + ArgoCD                                                             | VPS Docker Compose        |
| TLS termination | none (http)          | k3s Traefik Ingress                                                      | OPNsense HAProxy SNI      |
| Data            | dev seeds            | anonymized prod (Phase 72)                                               | live customer data        |
| Deploy trigger  | `pnpm dev`           | git push `release/1.9.x` → ArgoCD sync                                   | manual SSH (the operator) |
| Update cadence  | dev workflow         | tracks `release/1.9.x` (imagePullPolicy=Always; `rollout restart` pulls) | release tag only          |
| Version check   | none                 | manual `curl` after the pin                                              | manual `curl` per runbook |

## Architecture

```
GitHub (public)              GitLab (homelab)            k3s (homelab)
─────────────────            ────────────────            ─────────────
clokr repo (release/1.9.x)
├── charts/clokr-app/  ──┐
│   ├── Chart.yaml       │   homelab repo               clokr namespace
│   ├── values.yaml      │   └── argocd-apps/               ├── deployment-api
│   ├── values-int.yaml  └──→     clokr-app.yaml  ──→ ArgoCD ├── deployment-web
│   └── templates/                  (Application)            ├── postgres-statefulset
└── .github/workflows/                                       ├── ingress
    └── release.yml                                          └── service
```

## Deploy to int

There is no manual deploy step for int. ArgoCD tracks the `release/1.9.x` branch of the clokr repo and syncs new HEADs within ~3 minutes. The Application is configured with `syncPolicy.automated.prune + selfHeal`. Because the deployment uses `imagePullPolicy: Always`, a `kubectl -n clokr rollout restart` pulls the freshly built image for the current tag.

To deploy a specific revision:

1. Push to `release/1.9.x` (or a tag on that line, e.g. `v1.9.2`) of the clokr repo
2. ArgoCD detects the new HEAD on the next reconcile loop
3. Helm chart re-templates and applies any drift
4. Pods roll over (RollingUpdate strategy); `rollout restart` forces a fresh image pull

To force a re-sync:

```bash
# Via ArgoCD CLI (if available)
argocd app sync clokr

# Via ArgoCD UI
ArgoCD UI → Applications → clokr → "Sync"
```

## Secrets

The clokr repo is public on GitHub. Real secrets (JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY, DB passwords) MUST NOT be committed to `charts/clokr-app/values-int.yaml`. The file uses `CHANGEME-*` placeholders.

Real secret values are injected via the **ArgoCD UI Parameters tab**:

1. ArgoCD UI → Applications → clokr → Settings → Parameters
2. Override `secrets.jwtSecret`, `secrets.jwtRefreshSecret`, `secrets.encryptionKey` with int-grade test values (32+ chars each, NOT prod values — int is throwaway-anonymized data)
3. Save → ArgoCD re-syncs with the override values
4. Verify by hitting `/api/v1/health` — should return 200

Alternative: create a Kubernetes Secret manually in the clokr namespace that the chart's `secret.yaml` template references. This survives Application deletion but requires manual maintenance.

## Version Check After a Release

`release.yml` no longer probes int after promotion (Issue #507): int is pinned by hand after the release, so a probe right after promote raced a human and was red or green by timing alone. After pinning int, check the deployed version by hand:

```bash
curl -fsS https://clokr-int.example.com/api/v1/version
```

It must return `{"version":"X.Y.Z"}` for the released version. Details and what a mismatch means: `docs/release-process.md` ("Getting the release onto int and prod").

## Rollback

Two rollback paths depending on what changed:

### 1. Helm chart changes (most cases)

Revert the offending commit in the clokr repo:

```bash
git revert <bad-sha>
git push origin release/1.9.x
```

ArgoCD detects the new HEAD on the next sync loop and rolls back the cluster state to the reverted manifests. No manual cluster intervention needed.

### 2. ArgoCD Application changes (rare)

If the change is in `homelab/argocd-apps/clokr-app.yaml`:

```bash
cd ~/git/homelab
git revert <bad-sha>
git push origin main
```

The app-of-apps controller picks up the change and reconciles.

### Force-rollback to a previous revision

ArgoCD tracks revision history (`revisionHistoryLimit: 10`):

```bash
argocd app rollback clokr <N>
```

Or via UI: ArgoCD UI → clokr → History and Rollback → pick a previous revision.

## Operator Cheat-Sheet

| Action                         | Command                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| Check sync status              | `argocd app get clokr`                                               |
| Tail API logs                  | `kubectl -n clokr logs deployment/clokr-api -f`                      |
| Connect to int Postgres        | `kubectl -n clokr port-forward statefulset/clokr-postgres 5432:5432` |
| Force re-sync                  | `argocd app sync clokr`                                              |
| Rollback                       | `argocd app rollback clokr <N>`                                      |
| Check the deployed int version | `curl -fsS https://clokr-int.example.com/api/v1/version`             |

## Pre-Reqs (One-Time Setup)

These must be done before int is fully functional. Each should be ticked off:

- [x] ArgoCD Application `clokr-app.yaml` merged into homelab main (Plan 71-02)
- [x] GHCR packages `clokr-api` + `clokr-web` are public (verified Phase 71 research)
- [x] `INT_BASE_URL` repo variable set (Plan 71-04, this doc)
- [ ] DNS for `clokr-int.example.com` points to homelab Ingress
- [ ] Secrets injected via ArgoCD UI Parameters (one-time)
- [ ] First sync succeeded (ArgoCD UI shows clokr as Healthy)
- [ ] Manual `curl -sf https://clokr-int.example.com/api/v1/health` returns 200

## References

- `.planning/phases/71-environment-topology/71-CONTEXT.md` — Decisions D-01..D-19
- `.planning/phases/71-environment-topology/71-RESEARCH.md` — Helm + ArgoCD patterns, homelab discovery
- `charts/clokr-app/` — The Helm chart deployed here
- `homelab/argocd-apps/clokr-app.yaml` — The ArgoCD Application manifest
- `docs/prod-deploy.md` — Prod-equivalent deploy doc (companion)
- `docs/release-process.md` — Release flow, gate, and the manual version check ("Getting the release onto int and prod")

## End-to-End Dry-Run

After all pre-reqs are ticked, run this dry-run to verify the full chain:

1. Push any commit to clokr `release/1.9.x` (e.g., update this doc's typo)
2. ArgoCD picks it up, re-templates the Helm chart, applies changes
3. Wait ~3 min for sync to settle (`argocd app get clokr` → Synced + Healthy)
4. Push a release tag: `git tag v1.9.2-int-test && git push --tags`
5. `release.yml` runs: build-push-gate → promote
6. Pin `image.tag` to the test tag in k8s-homelab and wait for the sync
7. `curl -fsS https://clokr-int.example.com/api/v1/version` reports the test version

If any step fails: read the failed step's log, fix the underlying issue, re-run.
