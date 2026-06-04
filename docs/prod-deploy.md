# Production Deploy Runbook

**Audience:** the operator (sole prod-deploy operator).
**Environment:** prod = prod-host VPS, Docker Compose, TLS terminated by **OPNsense HAProxy**.
**Trigger model:** **Manual**. There is NO CI auto-deploy. There is NO Watchtower. the operator decides when to deploy.

> Per Phase 71 decision **D-04** (CONTEXT.md):
> _"ich sag dir wenn du deployen sollst, nicht automatisiert und soll auch nicht teil der pipeline sein."_ — the operator, 2026-06-04.
>
> This file documents the manual flow; do NOT automate it. Auto-deploy via GitHub Actions, Watchtower, Portainer, or any hybrid approval-gate is explicitly out of scope (CONTEXT.md "Deferred Ideas").

---

## Prerequisites (one-time setup on prod-host)

1. **SSH access** to prod-host (the operator's keypair).
2. **Docker + Docker Compose plugin** installed (`docker --version`, `docker compose version`).
3. **`.env` file** populated at `${CLOKR_DIR}/.env` (see `.env.example` template below).
4. **`docker-compose.prod.yml`** copied from this repo to `${CLOKR_DIR}/docker-compose.prod.yml`.
5. **OPNsense HAProxy** configured to route the prod hostname (e.g. `clokr.example.com`) via SNI:
   - HAProxy frontend on OPNsense terminates TLS with Let's Encrypt certs.
   - HAProxy backend forwards HTTP to `prod-host:3000` (web) and `prod-host:4000` (api).
   - This config lives **on OPNsense**, NOT in this repo. See OPNsense web UI.
6. **(Optional) `crane` binary on the operator machine** for fast rollbacks: `brew install crane`. NOT needed on prod-host.

### Why no Traefik?

Per Phase 71 decision **D-01**: TLS terminates on OPNsense HAProxy, not in `docker-compose.prod.yml`. There are no Traefik labels, no Caddy container, no nginx reverse proxy — the compose file ships api on port 4000 and web on port 3000 in plain HTTP. HAProxy on OPNsense handles SNI routing + cert renewal upstream. This means prod-host has a smaller surface area: one fewer container to update, one fewer place to misconfigure TLS.

### `.env.example` template for prod-host

Copy this template to `${CLOKR_DIR}/.env` on prod-host and fill in real values. Never commit it to this repo.

```bash
# Required: the GHCR image tag to deploy. Bump on each release.
CLOKR_VERSION=v1.8.0

# Required: database
POSTGRES_PASSWORD=<strong-random>

# Required: API secrets (min 32 chars each)
JWT_SECRET=<32+ char random>
JWT_REFRESH_SECRET=<32+ char random>
ENCRYPTION_KEY=<32+ char random>

# Required: app URLs (must match HAProxy frontend hostname)
CORS_ORIGIN=https://clokr.example.com
APP_URL=https://clokr.example.com

# Optional: rate limit (requests/min, default 500)
RATE_LIMIT_MAX=500

# Required: MinIO admin credentials
MINIO_ROOT_USER=<minio-user>
MINIO_ROOT_PASSWORD=<minio-pass>

# Optional: fritzbox-adapter (only if `--profile fritzbox` is used)
FRITZBOX_URL=http://fritz.box:49000
FRITZBOX_USER=<user>
FRITZBOX_PASS=<pass>
CLOKR_PRESENCE_KEY=<key>
POLL_INTERVAL_SECONDS=60
```

### GHCR access

Per Phase 71 decision **D-11** (verified 2026-06-04 via `gh api user/packages`): the GHCR packages
`ghcr.io/sebastianzabel/clokr-api` and `ghcr.io/sebastianzabel/clokr-web` are **public**. No
`docker login ghcr.io` is required on prod-host. Image pulls work unauthenticated.

---

## Deploy a new version (standard release)

After a release tag has been pushed and the `release.yml` workflow has completed promoting the
`sha-{SHA}` images to a `vX.Y.Z` tag (see `docs/release-process.md`):

```bash
# On the operator machine:
ssh prod-host

# On prod-host:
cd ${CLOKR_DIR}                     # the directory containing docker-compose.prod.yml + .env

# Edit .env to bump CLOKR_VERSION to the new tag (e.g. v1.8.0):
nano .env
# Change: CLOKR_VERSION=v1.7.4  →  CLOKR_VERSION=v1.8.0

# Pull the new images
docker compose -f docker-compose.prod.yml pull api web

# Restart api + web (postgres, redis, minio keep running)
docker compose -f docker-compose.prod.yml up -d api web

# Inspect state
docker compose -f docker-compose.prod.yml ps
```

### Verify deploy succeeded (smoke test)

Per Phase 71 decision **D-18** + matching the Phase 70-05 smoke-test job:

```bash
# From the operator machine (or from prod-host itself):
curl -sfS --max-time 10 https://clokr.example.com/api/v1/health | jq .status
# Expected: "ok"

curl -sfS --max-time 10 https://clokr.example.com/api/v1/version | jq .version
# Expected: matches CLOKR_VERSION (without the leading "v")
#   e.g. CLOKR_VERSION=v1.8.0 ⇒ .version == "1.8.0"
```

If either assertion fails — **STOP** and consider rolling back (next section).

Per Phase 71 decision **D-19**: smoke is **only** these two HTTP probes. Do NOT add DB-probes,
login probes, or E2E flows here. E2E smoke is gated behind Phase 73 (E2E Foundation).

---

## Rollback (DEVOPS-V8-08)

Per Phase 71 decisions **D-05** + **D-06**: there is **no automated rollback**. The operator
decides per-failure. Two paths are supported.

### Path A: Re-tag images via `crane copy` (fastest, surgical)

Use this when the previous release tag has been overwritten or you want to roll back to a
specific commit SHA rather than a release tag.

```bash
# On the operator machine, identify the last known good 7-char commit SHA:
git log --oneline -20                # pick the last green build before the bad deploy
PREV_SHA=<7-char-sha>                # e.g. a1b2c3d

# Re-tag the prior sha-{SHA} images as a rollback tag (crane copy is server-side, no pull):
crane copy \
  ghcr.io/sebastianzabel/clokr-api:sha-${PREV_SHA} \
  ghcr.io/sebastianzabel/clokr-api:vROLLBACK

crane copy \
  ghcr.io/sebastianzabel/clokr-web:sha-${PREV_SHA} \
  ghcr.io/sebastianzabel/clokr-web:vROLLBACK

# Then on prod-host:
ssh prod-host
cd ${CLOKR_DIR}
# Set CLOKR_VERSION=vROLLBACK in .env
nano .env
docker compose -f docker-compose.prod.yml pull api web
docker compose -f docker-compose.prod.yml up -d api web

# Smoke:
curl -sfS https://clokr.example.com/api/v1/health  | jq .status     # expect "ok"
curl -sfS https://clokr.example.com/api/v1/version | jq .version    # expect new tag
```

### Path B: Edit `.env` back to the previous release tag (cleanest)

Use this when the previous release tag still exists in GHCR (the common case — `cleanup-images.yml`
retention keeps several recent releases).

```bash
ssh prod-host
cd ${CLOKR_DIR}
# Set CLOKR_VERSION back to the previous good release (e.g. v1.7.4 if v1.8.0 was bad)
nano .env
docker compose -f docker-compose.prod.yml pull api web
docker compose -f docker-compose.prod.yml up -d api web

# Smoke (same as above)
curl -sfS https://clokr.example.com/api/v1/health  | jq .status
curl -sfS https://clokr.example.com/api/v1/version | jq .version
```

This is the recommended default. Use Path A only when the release tag is gone or you need a
specific intermediate SHA.

### What NOT to do during a rollback

- Do **not** restore from a Postgres dump unless you are certain the new release ran a
  destructive migration. Schema rollbacks are rare; most rollbacks are stateless.
- Do **not** edit `docker-compose.prod.yml` to pin a different image — keep the file source-of-truth
  identical to the repo and parameterise via `CLOKR_VERSION` only.
- Do **not** trigger a fresh CI run hoping for a hotfix — first restore service, then fix forward
  in a new PR.

---

## Helper script

For convenience, `scripts/prod-deploy.sh` automates the deploy + smoke flow. Run it from the
operator machine; it SSHes into prod-host and runs the steps above.

```bash
# Deploy the version currently set in prod-host's .env file:
./scripts/prod-deploy.sh

# Deploy a specific version (rewrites CLOKR_VERSION in .env on prod-host):
./scripts/prod-deploy.sh v1.8.0

# "Rollback" is just deploying a previous version tag:
./scripts/prod-deploy.sh v1.7.4
```

The script is **idempotent** — running it twice with the same version is a no-op because Docker
sees no image change.

The script does NOT auto-trigger from CI (D-04). It runs only when the operator invokes it from his
own shell. The script's runtime configuration (target host, remote path) is passed via env vars
`DMZ_HOST`, `CLOKR_DIR`, `BASE_URL` (see the script header for defaults).

---

## Companion documents

- [`docs/release-process.md`](release-process.md) — How releases get tagged + how images get
  promoted from `sha-{SHA}` to `vX.Y.Z` (Phase 69).
- [`docs/ci-branch-protection.md`](ci-branch-protection.md) — Branch protection + status checks
  (Phase 70-07).
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — Post-release smoke-test
  job for INT (Phase 70-05). It uses the same `/api/v1/health` + `/api/v1/version` probes as this
  runbook but only targets `vars.INT_BASE_URL` (int). It does **NOT** run against prod (D-04: prod
  stays manual).
- [`docker-compose.prod.yml`](../docker-compose.prod.yml) — The actual compose file referenced by
  this runbook (pinned `image:` tags, zero Traefik labels, secrets via `${VAR}`).

---

## Decision log

- **2026-06-04** — Phase 71-03 wrote this runbook + `scripts/prod-deploy.sh` (closes
  DEVOPS-V8-07 + DEVOPS-V8-08).
- **2026-06-04** — Decided AGAINST auto-deploy from CI (D-04). Decided AGAINST Watchtower on
  prod. Decided AGAINST a hybrid auto-deploy with approval gate. the operator is the only deploy
  trigger.
- **2026-06-04** — Decided AGAINST Traefik labels in compose (D-01). TLS terminates on OPNsense
  HAProxy; prod-host compose stays reverse-proxy-free. (Correction to earlier CONTEXT assumption
  that prod ran Traefik; verified via `git commit 93b48a8` historical state.)
- **2026-06-04** — Decided AGAINST DB-probe / login-probe / E2E-smoke in this runbook (D-19).
  Smoke stays at `/api/v1/health` + `/api/v1/version` only; future expansion comes with Phase 73.
- **2026-06-04** — Decided AGAINST automated rollback-on-failure (D-06). Rollback is an explicit
  operator action; no smoke-test-failure auto-trigger.
