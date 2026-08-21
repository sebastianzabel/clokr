# Image Footprint — IMG-05 Measurement Ledger

Purpose: this is the IMG-05 (`.planning/phases/102-.../102-CONTEXT.md` D-04) measurement ledger for
Phase 102 (Runtime-Images auf Produktionsabhängigkeiten reduzieren). Every number below is
**measured, not asserted** — each row is produced by a literal, reproducible command, listed
verbatim next to the number it produced. Do not hand-edit a number without re-running its command.

Environment this ledger was produced on: Docker 29.2.1 (containerd snapshotter,
`driver-type: io.containerd.snapshotter.v1`), host `linux/arm64` (Apple Silicon, single-platform
local build, not the CI `linux/amd64,linux/arm64` matrix), Trivy 0.74.0, vulnerability DB
downloaded 2026-08-21. Builds were run from the CI-equivalent context (`.`) and Dockerfiles
(`apps/web/Dockerfile`, `apps/api/Dockerfile`) that `.github/workflows/build-push.yml` uses, but for
the local platform only — this is a measurement, not a release artifact.

**Before-numbers HEAD:** `b6eb2d6d7f8b15d16b1c2107cf41b72a8c7b7908` (branch `release/1.9.x`), captured
2026-08-21T17:16:37Z, before any Dockerfile in this phase was edited.

## A known measurement quirk — read before comparing sizes

`docker image inspect --format '{{.Size}}'` and `docker images --format '{{.Size}}'` **do not agree
in magnitude** on this host (243 MB vs 1.13 GB for the same web image). Confirmed root cause: this
Docker Desktop uses the containerd image store (`driver-type: io.containerd.snapshotter.v1`), under
which `docker image inspect .Size` reports a different accounting than the classic overlay2
graphdriver did. Ruled out as the cause: multi-platform confusion — `docker image inspect
--format '{{.Os}}/{{.Architecture}}'` confirms a single `linux/arm64` image, matching the host.
Both numbers are recorded below exactly as the acceptance criteria require. **For before/after
comparison, compare each metric against itself** (inspect-bytes vs inspect-bytes, human-size vs
human-size) — do not compare inspect-bytes on one side against human-size on the other.

---

## Before-measurement (unmodified HEAD, both images)

### Build commands

```bash
docker build -f apps/web/Dockerfile -t clokr-web:102-before .
docker build -f apps/api/Dockerfile -t clokr-api:102-before .
```

Both exited 0. No Dockerfile, lockfile, or `package.json` was modified before or during this step —
verified after the fact with `git diff --name-only`, which listed only this file.

### Size

| Image                  | Command                                                                             | Result            |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------- |
| `clokr-web:102-before` | `docker image inspect --format '{{.Size}}' clokr-web:102-before`                    | `243178829` bytes |
| `clokr-web:102-before` | `docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' clokr-web:102-before` | `1.13GB`          |
| `clokr-api:102-before` | `docker image inspect --format '{{.Size}}' clokr-api:102-before`                    | `258507058` bytes |
| `clokr-api:102-before` | `docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' clokr-api:102-before` | `1.18GB`          |

The human sizes match the orchestrator-measured starting point given in the plan
(`clokr-web:latest` 1.13 GB · `clokr-api:latest` 1.18 GB) — cross-check passed.

### Trivy CRITICAL+HIGH count — gated (repo gate, what CI enforces) and ungated (what is actually present)

Commands (gated = with `.trivyignore`, matching the exact flags
`.github/workflows/build-push.yml` lines 83-96 configure — `severity: CRITICAL,HIGH`,
`trivyignores: .trivyignore`; ungated = identical minus `--ignorefile`):

```bash
trivy image --severity CRITICAL,HIGH --scanners vuln --ignorefile .trivyignore \
  --format json --output web-before-gated.json clokr-web:102-before
trivy image --severity CRITICAL,HIGH --scanners vuln \
  --format json --output web-before-ungated.json clokr-web:102-before

trivy image --severity CRITICAL,HIGH --scanners vuln --ignorefile .trivyignore \
  --format json --output api-before-gated.json clokr-api:102-before
trivy image --severity CRITICAL,HIGH --scanners vuln \
  --format json --output api-before-ungated.json clokr-api:102-before
```

Count extraction (run against each JSON output; cross-checked with an equivalent inline Python
count — both methods agreed on every file):

```bash
jq '[.Results[].Vulnerabilities[]?] | length' <file>.json
```

| Image                  | Gated (CI-enforced) CRITICAL+HIGH | Ungated (actually present) CRITICAL+HIGH |
| ---------------------- | --------------------------------- | ---------------------------------------- |
| `clokr-web:102-before` | **0**                             | **0**                                    |
| `clokr-api:102-before` | **0**                             | **0**                                    |

**Sanity check (scanner-is-working proof, not part of the gate):** an unfiltered scan (`trivy image
--scanners vuln` with no `--severity` filter) on both before-images returns non-zero findings at
MEDIUM/LOW (web: 17 MEDIUM / 3 LOW across 11 packages incl. `tar`, `ip-address`, `postcss`,
`esbuild`; api: 17 MEDIUM / 2 LOW across 9 packages) — confirming the scanner is genuinely running
against these images and the 0/0 CRITICAL+HIGH result is real, not a broken scan. **Observation, not
a Phase 102 finding:** the CRITICAL/HIGH count being 0 even ungated means most `.trivyignore`
entries (which were written against CRITICAL/HIGH CVEs like `CVE-2026-59873` node-tar CRIT) no
longer reproduce on this snapshot — likely because `npm install -g npm@latest` now resolves to a
version whose bundled CVEs are already fixed. Whether each `.trivyignore` entry can be retired is
Plan 04's job (IMG-04), evaluated on its own evidence at that time, not backdated from this ledger.

### `node_modules` size and build-tooling inventory

Commands (run inside a throwaway container from each image):

```bash
docker run --rm --entrypoint sh <image> -c 'du -sh /app/node_modules'
docker run --rm --entrypoint sh <image> -c 'find /app -maxdepth 6 -iname "prisma" -type d'
docker run --rm --entrypoint sh <image> -c 'find /app -maxdepth 6 -iname "tsx" -type d'
docker run --rm --entrypoint sh <image> -c 'find /app -maxdepth 6 -iname "typescript" -type d'
docker run --rm --entrypoint sh <image> -c 'find /app -maxdepth 6 -iname "vite" -type d'
docker run --rm --entrypoint sh <image> -c 'command -v pnpm || echo "NOT FOUND"'
docker run --rm --entrypoint sh <image> -c 'find / -path "*corepack*" -iname "*pnpm*"'
```

|                                                                                                                                                                | `clokr-web:102-before`                                                                       | `clokr-api:102-before`                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/app/node_modules` size                                                                                                                                       | 625.1 M                                                                                      | 593.3 M                                                                                |
| `prisma` present                                                                                                                                               | YES — `.pnpm/prisma@7.8.0.../node_modules/prisma`                                            | YES — same, plus `/app/packages/db/prisma` (schema dir)                                |
| `tsx` present                                                                                                                                                  | YES — `.pnpm/tsx@4.23.1/node_modules/tsx`                                                    | YES — same                                                                             |
| `typescript` present                                                                                                                                           | YES — `.pnpm/typescript@6.0.3/node_modules/typescript`                                       | YES — same                                                                             |
| `vite` present                                                                                                                                                 | YES — `.pnpm/vite@8.1.5.../node_modules/vite`                                                | YES — same                                                                             |
| `pnpm` binary on PATH (`command -v pnpm`)                                                                                                                      | **NOT FOUND**                                                                                | **FOUND** — `/usr/local/bin/pnpm`, `10.34.5`                                           |
| Real (downloaded/activated) corepack pnpm cache                                                                                                                | **NOT FOUND** — no `/root/.cache/node/corepack/v1/pnpm/<version>/` dir                       | **FOUND** — `/root/.cache/node/corepack/v1/pnpm/10.34.5/dist/pnpm.cjs` + `.pnpm` store |
| Dormant corepack pnpm shim scripts (bundled with the `node:24-alpine` base image itself, <1 KB each, not on PATH, present regardless of any Dockerfile choice) | present — `/usr/local/lib/node_modules/corepack/shims/pnpm{,.cmd,.ps1}` (+ nodewin variants) | present — same                                                                         |

**Correction to the plan's `measured_starting_state` hypothesis:** it stated "no pnpm binary and no
corepack pnpm cache" for the web image. Re-confirmed empirically: **no pnpm binary and no real
(downloaded/activated) pnpm cache** is correct — but small dormant corepack shim scripts (~2.5 KB
total, part of Node 24's bundled corepack, present in the base image before any Dockerfile
instruction runs, and inert because `corepack enable` is never called in the web runtime stage) do
exist on disk. This distinction matters for Plan 04 (IMG-04): the pnpm-cluster `.trivyignore`
entries are about a _real, activated_ pnpm install being able to run `configDependencies`
(`CVE-2026-55697`) — an inert, unreachable shim script is not that. The web image was already, and
remains, not exposed to that CVE class either way.

---

## After: `apps/web` (Task 3, this plan)

Filled in Task 3 after the pruned `apps/web/Dockerfile` builds and passes its smoke test.

### Smoke test (IMG-03) — three independent proofs, all required, all passed

1. **Module-resolution proof (hash-independent).** Inside a running `clokr-web:102-after`
   container: `node --input-type=module -e "await import('date-fns'); await
import('date-fns/locale'); await import('chart.js'); console.log('RESOLVE_OK')"` →
   printed `RESOLVE_OK`.
2. **Real SSR proof.** `/login`, `/dashboard`, `/reports` each returned HTTP 200.
   `/dashboard` and `/reports` bodies are 2208 bytes each (well above the 500-byte floor),
   contain a genuine `<body data-sveltekit-preload-data="hover">` tag, and their `<head>`
   correctly lists the CSS for their own leaf route (`28.CYw5P7IS.css` for `/dashboard`
   → manifest leaf 28, `KPIStat`/`SaldoAnzeige`/`Pagination` component CSS) — evidence the
   server actually imported and rendered that route's component tree, not a generic
   shell. `/login` (public control, does not import chart.js/date-fns) returned 6196
   bytes.
   **Adversarial cross-check (stronger than the plan requires):** to rule out SvelteKit
   silently swallowing a resolution failure into a 200, a second container was started
   from the same `clokr-web:102-after` image and `chart.js` was deleted from its
   `node_modules` at the container filesystem level (not the image), then the process was
   restarted. Result: `/dashboard` → **HTTP 500**, with a structured log line naming the
   exact failure: `"Cannot find package 'chart.js' imported from
/app/apps/web/build/server/chunks/_page.svelte-Cd5Vdtws.js"` (`ERR_MODULE_NOT_FOUND`).
   `/login` on the same poisoned container still returned 200 (correctly unaffected, no
   chart.js dependency). This confirms the 200s recorded above are genuine positive
   evidence, not an artifact of SvelteKit error-swallowing — a broken image on this exact
   code path would have been caught, not silently passed.
3. **Silent-failure proof.** `docker logs` on the (unpoisoned) smoke container, scanned
   for `ERR_MODULE_NOT_FOUND`, `Cannot find package`, `Cannot find module`: zero matches.

### Size

| Command                                                                  | Before            | After            | Delta                                                                                   |
| ------------------------------------------------------------------------ | ----------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `docker image inspect --format '{{.Size}}' clokr-web:102-{before,after}` | `243178829` bytes | `82791759` bytes | **-160387070 bytes (-65.96%)**                                                          |
| `docker images --format '...{{.Size}}' clokr-web:102-{before,after}`     | `1.13GB`          | `359MB`          | **-68.5%** (human-rounded; compare like-for-like with the byte figure, not across rows) |

### Trivy CRITICAL+HIGH — gated and ungated

|                                     | Before | After | Delta                                                     |
| ----------------------------------- | ------ | ----- | --------------------------------------------------------- |
| Gated (`--ignorefile .trivyignore`) | 0      | 0     | no change                                                 |
| Ungated (no ignorefile)             | 0      | 0     | no change — passes the hard-stop rule (must not increase) |

Sanity check (all-severity, not part of the gate, same method as the before-ledger):
`clokr-web:102-after` has 6 MEDIUM / 0 LOW findings across 3 packages (`ip-address`, `tar`,
`undici`), down from the before-image's 17 MEDIUM / 3 LOW across 11 packages — a real
reduction even at severities below the CI gate, consistent with devDependencies (and
their own transitive trees) having actually been removed rather than merely hidden.

### `node_modules` size and build-tooling inventory

|                                                 | Before    | After      | Delta                                                        |
| ----------------------------------------------- | --------- | ---------- | ------------------------------------------------------------ |
| `/app/node_modules` size                        | 625.1 M   | **38.5 M** | **-586.6 M (-93.84%)**                                       |
| `prisma` present                                | YES       | **NO**     | closed                                                       |
| `tsx` present                                   | YES       | **NO**     | closed                                                       |
| `typescript` present                            | YES       | **NO**     | closed                                                       |
| `vite` present                                  | YES       | **NO**     | closed                                                       |
| `pnpm` binary on PATH                           | NOT FOUND | NOT FOUND  | unchanged (web never ran `corepack enable`, before or after) |
| Real corepack pnpm cache                        | NOT FOUND | NOT FOUND  | unchanged                                                    |
| Dormant corepack pnpm shims (base-image, inert) | present   | present    | unchanged (base-image artifact, not affected by this prune)  |

**IMG-01 closed with evidence:** `clokr-web:102-after` contains no `prisma`, no `@prisma/*`,
no `packages/db` (`/app/packages/db` does not exist — `test ! -e` in the Dockerfile's own
ABSENCE gate, independently re-confirmed here), and none of `vite`, `typescript`,
`svelte-check`, `vitest`, `jsdom` under its `node_modules`.

### Deployed dependency closure (for context — not part of the acceptance criteria)

`pnpm --filter @clokr/web deploy --prod --legacy` produces exactly 5 top-level
`node_modules` packages: `@clokr/types` (workspace dep, source-only, not actually imported
by any compiled route per the build-output scan below, but harmless to ship), `@tanstack/
svelte-query`, `chart.js`, `date-fns`, `svelte-dnd-action` — i.e. precisely `@clokr/web`'s
own `dependencies` in `package.json`. `svelte@5.55.7` also appears in the deployed tree's
`.pnpm` store as a transitive **peer** dependency of `@tanstack/svelte-query` and
`svelte-dnd-action` (both declare `svelte` as a peerDependency) — this is expected and
distinct from the (absent) `svelte-check`/devDependency class; the compiled SSR output
does not import bare `svelte` at runtime either way (see below).

### Build-output import scan — real vs. JSDoc-comment-only (method + result)

Before writing the Dockerfile comment, the claim in the plan's `measured_starting_state`
("`svelte`, `@sveltejs/kit`, `@standard-schema/spec` and `types` are JSDoc-comment hits,
not real imports") was independently re-verified against `clokr-web:102-before`'s actual
build output (`apps/web/build/`, 125 non-client `.js` files), not assumed:

1. Extracted the build output from the built image: `docker cp
$(docker create clokr-web:102-before):/app/apps/web/build ./build-inspect`.
2. Scanned every file for `from "<specifier>"` / `import("<specifier>")` occurrences,
   classifying each as inside a `/* ... */` block comment or not.

Result for the six specifiers of interest:

| Specifier                                              | Real (non-comment) hits                                                                              | Comment-only hits                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `date-fns`                                             | 10 (across multiple `_page.svelte-*.js` chunks)                                                      | 1                                          |
| `date-fns/locale`                                      | included above                                                                                       | 0                                          |
| `chart.js`                                             | 2 (`_page.svelte-Cd5Vdtws.js` = `/dashboard`'s leaf, `_page.svelte-Dh82mbe8.js` = `/reports`'s leaf) | 0                                          |
| `svelte`                                               | **0**                                                                                                | 9                                          |
| `@sveltejs/kit`                                        | **0**                                                                                                | 45                                         |
| `@standard-schema/spec`                                | **0**                                                                                                | 4                                          |
| `@clokr/types`                                         | 0                                                                                                    | 0 (not referenced at all, real or comment) |
| `types` (bare specifier `'types'`, not `@clokr/types`) | **0**                                                                                                | 94                                         |

Spot-checked several hits directly: the `date-fns`/`chart.js` hits are plain
`import { x } from 'chart.js'` statements at the top of a route's leaf chunk. Every
`svelte` / `@sveltejs/kit` / `types` / `@standard-schema/spec` hit checked is inside a
`/** @import { X } from '...' */` JSDoc type-annotation comment inside SvelteKit's own
bundled runtime source (e.g. `server/index.js`) — a TypeScript/editor-tooling construct
that Node's module loader does not parse and that has zero runtime effect. Route-to-leaf
mapping (`/dashboard` → manifest leaf 28 → `_page.svelte-Cd5Vdtws.js`; `/reports` → leaf
32 → `_page.svelte-Dh82mbe8.js`) was confirmed from `apps/web/build/server/manifest.js`.

---

## After: `apps/api` (Plan 03)

Filled in Plan 03 Task 2 after the pruned `apps/api/Dockerfile` builds and passes its smoke test.
Measured on `clokr-api:102-after`, built from the Dockerfile committed in Plan 03 Task 1
(`ead996b7`) — restructured onto `pnpm --filter @clokr/api deploy --prod --legacy` plus a
second, separately-scoped `pnpm --filter @clokr/db deploy --config.inject-workspace-packages=true`
for the retained tooling (prisma CLI + schema-engine, tsx). Full mechanism and rationale:
`apps/api/Dockerfile` comments above the `prod-deps`/`tooling-deps` stages;
`102-03-SUMMARY.md`.

**Tag-consistency note:** the image measured here (`clokr-api:102-after`) and the image booted
for the smoke test below (built via `docker compose up -d --build api`, tagged `clokr-api:latest`
by the compose project) are two separate `docker build` invocations of the identical Dockerfile
and context. Verified equivalent by construction, not merely asserted: `docker image inspect
--format '{{json .RootFS.Layers}}'` on both returned byte-identical layer-digest lists (every
layer showed `CACHED` on the second build). `clokr-api:latest` was then explicitly re-tagged as
`clokr-api:102-after` (`docker tag`) so the exact artifact that was smoke-tested carries the tag
Plan 04 will re-scan with Trivy.

### Smoke test (IMG-03) — proofs required by D-03, all passed

Brought up against a CLEAN postgres volume (`docker compose down -v` first — this also removed
the local dev `redis`/`minio` volumes, restored afterward per project convention), with
`NODE_ENV=production` (docker-compose.yml's default for the `api` service), so the entrypoint
took the `migrate deploy` branch, not `db push` and not the retry-fallback path.

1. **Migration actually ran, verified against the database, not just the log.** Container log
   shows `Using prisma: /app/node_modules/.bin/prisma`, `19 migrations found in
prisma/migrations`, all 19 applied by name, `All migrations have been successfully applied.`,
   `✅ Database schema synced`. Independently confirmed against Postgres itself:
   `select count(*) from _prisma_migrations where finished_at is not null` → **19**, and
   `select migration_name from _prisma_migrations order by started_at` lists the same 19 names in
   the same order as `packages/db/prisma/migrations`'s 19 directories (`migration_lock.toml` is a
   file, not a migration — the directory-only count is 19, not the 20 a raw `ls | wc -l` would
   include).
2. **A Prisma-backed endpoint returns data derived from a real DB read.** `POST
/api/v1/auth/login` with the seed script's own demo admin credentials
   (`admin@clokr.de` / `admin1234` — public demo-only constants already in
   `packages/db/src/seed.ts`, not a secret) → `HTTP 200`, JWT issued. `GET /api/v1/employees` with
   that token → `HTTP 200`, body is an array of exactly the 2 seeded employees
   (`firstName: "Admin"`/`"Max"`, `employeeNumber: "001"`/`"002"`) — a shape only a genuine
   Prisma round trip against freshly-seeded data produces, not derivable from config.
   `SEED_DEMO_DATA` is `true` by default in `docker-compose.yml` for the `api` service; no
   override needed.
3. **`sharp` loads its native binding, executed not just located.** `docker compose exec api
node -e "..."` generated an 8×8 PNG buffer and read its metadata back inside the running
   container → printed `SHARP_OK width=8 format=png`.

Full `docker compose logs api` scanned for `ERR_MODULE_NOT_FOUND`, `Cannot find module`,
`Cannot find package`, `ERR_DLOPEN_FAILED`, `Error: Could not load` — **zero matches**. The only
warning in the log is a pre-existing, expected one: `MinIO: Could not verify/create bucket (will
retry on first use)` / `getaddrinfo ENOTFOUND minio` — this smoke test intentionally brought up
only `postgres`+`api` (`redis` came along as a declared dependency); MinIO was not started, so its
hostname doesn't resolve. Unrelated to the prune; the code retries on first use as designed.

### Size

| Command                                                                  | Before            | After             | Delta                                                                                   |
| ------------------------------------------------------------------------ | ----------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `docker image inspect --format '{{.Size}}' clokr-api:102-{before,after}` | `258507058` bytes | `217750175` bytes | **-40756883 bytes (-15.76%)**                                                           |
| `docker images --format '...{{.Size}}' clokr-api:102-{before,after}`     | `1.18GB`          | `1.01GB`          | **-14.4%** (human-rounded; compare like-for-like with the byte figure, not across rows) |

Smaller than `apps/web`'s reduction (93.84% on `node_modules`, 65.96% on image bytes) by design —
D-02/D-03: `apps/api` is genuinely constrained and legitimately retains the Prisma CLI closure
(incl. `mysql2`/`postgres` driver stubs Prisma CLI itself depends on, `@prisma/dev`'s embedded
local-Postgres tooling) and the full `tsx` transpilation toolchain. The win here is the workspace
ROOT's own devDependencies (turbo, vitest, husky, eslint, playwright) and `typescript` — not a
wholesale strip of every dev-tier package, several of which are the retained tools themselves.

### Trivy CRITICAL+HIGH — gated and ungated

|                                     | Before | After | Delta                                                     |
| ----------------------------------- | ------ | ----- | --------------------------------------------------------- |
| Gated (`--ignorefile .trivyignore`) | 0      | 0     | no change                                                 |
| Ungated (no ignorefile)             | 0      | 0     | no change — passes the hard-stop rule (must not increase) |

Sanity check (all-severity, not part of the gate, same method as the before-ledger and web's
after-ledger): `clokr-api:102-after` has 16 MEDIUM / 2 LOW findings across 8 packages
(`@hono/node-server`, `esbuild`, `fast-xml-parser`, `hono`, `ip-address`, `tar`, `undici`,
`valibot`) — a small reduction from the before-image's 17 MEDIUM / 2 LOW across 9 packages. The
remaining packages are transitive dependencies of the retained Prisma CLI (`@prisma/dev`'s
embedded local-Postgres feature pulls in `hono`/`@hono/node-server`/`valibot`), not leftover
build tooling — consistent with D-02's framing that this image's win is narrower than web's.

### `node_modules` size and build-tooling inventory

|                                           | Before  | After       | Delta                                                                                                          |
| ----------------------------------------- | ------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `/app/node_modules` size                  | 593.3 M | **439.4 M** | **-153.9 M (-25.94%)**                                                                                         |
| `prisma` present                          | YES     | **YES**     | retained (KEEP — `docker-entrypoint.sh:19-23,30`)                                                              |
| `tsx` present                             | YES     | **YES**     | retained (KEEP — `cronjob-anonymizer.yaml:51`, operator scripts)                                               |
| `typescript` present                      | YES     | **NO**      | closed (no runtime consumer — `102-API-RUNTIME-SET.md` Part C.4)                                               |
| `vite` present                            | YES     | **NO**      | closed (was only ever a workspace-root `vitest` transitive)                                                    |
| `pnpm` binary on PATH (`command -v pnpm`) | FOUND   | FOUND       | unchanged — `corepack prepare pnpm@10.34.5 --activate` still runs in the runtime stage (needed for `pnpm tsx`) |
| Real corepack pnpm cache                  | FOUND   | FOUND       | unchanged, same reason                                                                                         |

**IMG-02 closed for `apps/api` with evidence:** the runtime image contains the empirically
established KEEP set (`102-API-RUNTIME-SET.md`) and nothing from the DROP set — `typescript` and
`vite` confirmed absent from `/app/node_modules/.pnpm`, no `apps/web` tree, no workspace-root
devDependencies (`turbo`/`vitest`/`husky`/`eslint` all confirmed absent by name, not just by
category). Every retained dev-tier package (`prisma`, `tsx`) has a named consumer and an
assertion gate in `apps/api/Dockerfile` that fails the build if it goes missing — one of which
(the pnpm@10 hoisting-symlink `test -e` gate) was demonstrated firing on a deliberately dangling
symlink during Task 1, confirming the gate genuinely discriminates broken from healthy.

<!-- API_AFTER_SECTION -->

---

## IMG-04 — Per-CVE `.trivyignore` Disposition (Plan 04, Task 1)

Scanned images: `clokr-web:102-after` and `clokr-api:102-after` — the exact tags Plan 01/03
smoke-tested and content-identity-verified (`102-03-SUMMARY.md`: `RootFS.Layers` byte-identical to
the booted `clokr-api:latest`/`clokr-web:latest` compose containers). Trivy 0.74.0, vulnerability
DB version 2, updated 2026-08-21T13:05:54Z (same DB generation used for the before/after size
scans above).

### Method (read before the table)

1. **Ungated scan, CRITICAL+HIGH only** (the CI gate's own severity filter, no ignorefile):
   `trivy image --severity CRITICAL,HIGH --scanners vuln --format json -q <image>`. Result for
   BOTH images: **0 findings** — every `.trivyignore` CVE id, and everything else, is silent at
   this severity.
2. Because (1) alone cannot distinguish "genuinely fixed" from "Trivy's DB has a coverage gap for
   this exact package/version," a second **ungated, all-severity scan** was run (no
   `--severity` flag at all): `trivy image --scanners vuln --format json -q <image>`. Every one of
   the 13 CVE ids currently in `.trivyignore` was grepped against both JSON outputs — **zero hits,
   at any severity, on either image, for all 13 ids** (command and per-id result table below).
3. Trivy-silence alone is still not proof of absence (T-102-23's own point). For every id, the
   package's **physical presence and installed version** was independently established with
   `find`/`grep` inside a running container from each image, and cross-checked against the
   **authoritative fixed-version threshold** for that exact CVE id, queried directly from GitHub's
   own reviewed Security Advisory database (`api.github.com/advisories`) — not re-derived from the
   `.trivyignore` comment text itself, to avoid circular reasoning. `github_reviewed_at` was
   checked for every id to screen out unreviewed/candidate-stage advisories before trusting a
   fix-version claim (this caught one real case — see `CVE-2026-55697` below).
4. **A verdict class the plan's RETIRE/KEEP taxonomy does not name directly, but the evidence
   forced:** for six ids (`CVE-2026-33671`, `-35039`, `-35042`, `-48815`, `-59873`, `-59874`) the
   _package name_ is still physically present in one or both images (npm always bundles some
   `tar`/`sigstore`/`tinyglobby`; `fast-jwt` is a genuine, load-bearing runtime dependency of
   `@fastify/jwt`) but the _specific vulnerable version range_ is not — the installed version
   already exceeds the CVE's own documented fix threshold. This is recorded as **RETIRE
   (version-patched)** to keep it honestly distinct from the plan's literal "package absent from
   both images" RETIRE criterion: the table below shows the exact installed version next to the
   exact fix threshold and its source, in place of a `find`-absence proof, for every such row.
   Root cause, confirmed by the before-ledger's own prior observation and now verified concretely:
   `npm install -g npm@latest` (both Dockerfiles, unrelated to this phase) resolves to a newer npm
   release over time, which bundles newer transitive copies of `tar`/`sigstore`/`tinyglobby`
   (→ `picomatch`) than existed when these `.trivyignore` entries were written; `fast-jwt`'s fix
   was independently already pulled in by the existing root `pnpm.overrides: "fast-jwt": ">=6.2.4"`
   pin. Neither mechanism is caused by this phase's pruning.

### Full-severity Trivy silence, all 13 ids (both images)

```bash
trivy image --scanners vuln --format json -q clokr-web:102-after > web-after-allsev.json
trivy image --scanners vuln --format json -q clokr-api:102-after > api-after-allsev.json
for cve in CVE-2025-69262 CVE-2025-69263 CVE-2026-13149 CVE-2026-14257 CVE-2026-33671 \
           CVE-2026-35039 CVE-2026-35042 CVE-2026-48815 CVE-2026-55697 CVE-2026-59873 \
           CVE-2026-59874 CVE-2026-69152 CVE-2026-69192; do
  echo "$cve web=$(grep -c "$cve" web-after-allsev.json) api=$(grep -c "$cve" api-after-allsev.json)"
done
```

Result: **every id, 0 hits, both images, at every severity** — not just at the CRITICAL,HIGH gate
threshold. (Both images' own genuine, non-`.trivyignore` findings at MEDIUM/LOW are listed in the
before/after tables above — `undici`, `ip-address` at different CVE ids, `tar` at a different GHSA
id, `hono`/`@hono/node-server`/`valibot`/`fast-xml-parser`/`esbuild` on the API image — proving
both scans genuinely executed and are not silently broken.)

### Disposition table — all 13 `.trivyignore` CVE ids

| CVE              | Package                                                             | Web (`clokr-web:102-after`)                                                                                                                                                                                         | API (`clokr-api:102-after`)                                                                                                                                                                                                                                                                                                                                                                                                                   | Fix threshold (source, reviewed)                                                                                                                                                                                  | Verdict                                                                                                                 |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CVE-2025-69262` | pnpm                                                                | **Absent.** `command -v pnpm` → not found; no `/root/.cache/node/corepack/v1/pnpm/` dir.                                                                                                                            | **Present.** `/usr/local/bin/pnpm` → `10.34.5`.                                                                                                                                                                                                                                                                                                                                                                                               | `>= 10.27.0` — GHSA-2phv-j68v-wwqx, high, `github_reviewed_at` set, single clean range. Installed 10.34.5 exceeds it.                                                                                             | **KEEP, JUSTIFICATION CORRECTED**                                                                                       |
| `CVE-2025-69263` | pnpm                                                                | Absent (same as above).                                                                                                                                                                                             | Present, 10.34.5.                                                                                                                                                                                                                                                                                                                                                                                                                             | `>= 10.26.0` — GHSA-7vhp-vf5g-r2fw, high, reviewed. Installed 10.34.5 exceeds it.                                                                                                                                 | **KEEP, JUSTIFICATION CORRECTED**                                                                                       |
| `CVE-2026-55697` | pnpm                                                                | Absent.                                                                                                                                                                                                             | Present, 10.34.5.                                                                                                                                                                                                                                                                                                                                                                                                                             | Disputed — see note below.                                                                                                                                                                                        | **KEEP, JUSTIFICATION CORRECTED** (D-05: not retired)                                                                   |
| `CVE-2026-33671` | picomatch (via tinyglobby, npm's own bundle + API's corepack cache) | npm bundle: `tinyglobby@0.2.17` → bundled `picomatch@4.0.5` at `/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch/package.json`.                                                       | Same npm-bundle path, `4.0.5`; **also** corepack cache `/root/.cache/node/corepack/v1/pnpm/10.34.5/dist/node_modules/picomatch/package.json` → `4.0.5`.                                                                                                                                                                                                                                                                                       | `>= 4.0.4` — GHSA-c2c7-rcm5-vvqj, high, reviewed. `4.0.5` exceeds it everywhere it appears.                                                                                                                       | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-35039` | fast-jwt                                                            | Absent — web has no `fast-jwt` anywhere (`find` — no hits).                                                                                                                                                         | `/app/node_modules/.pnpm/fast-jwt@6.2.4/node_modules/fast-jwt/package.json` → `6.2.4`, pinned by root `pnpm.overrides: "fast-jwt": ">=6.2.4"`.                                                                                                                                                                                                                                                                                                | `>= 6.1.0` — GHSA-rp9m-7r4c-75qg, **critical**, reviewed. `6.2.4` exceeds it.                                                                                                                                     | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-35042` | fast-jwt                                                            | Absent (same).                                                                                                                                                                                                      | `6.2.4` (same).                                                                                                                                                                                                                                                                                                                                                                                                                               | `>= 6.2.0` — GHSA-hm7r-c7qw-ghp6, high, reviewed. `6.2.4` exceeds it.                                                                                                                                             | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-59873` | tar                                                                 | npm bundle `/usr/local/lib/node_modules/npm/node_modules/tar/package.json` → `7.5.19`.                                                                                                                              | Same npm-bundle path, `7.5.19`; **also** corepack cache `/root/.cache/node/corepack/v1/pnpm/10.34.5/dist/node_modules/tar/package.json` → `7.5.19`.                                                                                                                                                                                                                                                                                           | `>= 7.5.19` — GHSA-23hp-3jrh-7fpw, **critical**, reviewed. `7.5.19` meets it exactly, both locations, both images.                                                                                                | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-59874` | tar                                                                 | `7.5.19` (same path).                                                                                                                                                                                               | `7.5.19` (both locations).                                                                                                                                                                                                                                                                                                                                                                                                                    | `>= 7.5.18` — GHSA-8x88-c5mf-7j5w, high, reviewed. Exceeds it.                                                                                                                                                    | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-48815` | sigstore                                                            | npm bundle `/usr/local/lib/node_modules/npm/node_modules/sigstore/package.json` → `5.0.0`. No corepack-cache copy of `sigstore` exists on either image (it is an npm-audit/provenance tool, not a pnpm dependency). | Same npm-bundle path, `5.0.0`.                                                                                                                                                                                                                                                                                                                                                                                                                | `>= 4.1.1` — GHSA-52v5-jr5w-gjxr, high, reviewed. `5.0.0` exceeds it.                                                                                                                                             | **RETIRE (version-patched)**                                                                                            |
| `CVE-2026-14257` | brace-expansion                                                     | npm bundle `5.0.7` — fixed.                                                                                                                                                                                         | npm bundle `5.0.7` — fixed; **but** corepack cache `/root/.cache/node/corepack/v1/pnpm/10.34.5/dist/node_modules/brace-expansion/package.json` → `2.1.2`.                                                                                                                                                                                                                                                                                     | `>= 5.0.7` — GHSA-mh99-v99m-4gvg, high, reviewed. GHSA's `extracted_events` give a single global range (`0 → 5.0.7`), no per-major-line backport data — `2.1.2` falls inside the vulnerable range on this record. | **KEEP, JUSTIFICATION CORRECTED** — API corepack-cache copy still exposed                                               |
| `CVE-2026-13149` | brace-expansion                                                     | npm bundle `5.0.7` — fixed.                                                                                                                                                                                         | npm bundle fixed; corepack cache `2.1.2` — same single-global-range reasoning as above, vulnerable.                                                                                                                                                                                                                                                                                                                                           | `>= 5.0.6` — GHSA-3jxr-9vmj-r5cp, high, reviewed.                                                                                                                                                                 | **KEEP, JUSTIFICATION CORRECTED**                                                                                       |
| `CVE-2026-69152` | brace-expansion (bypasses the -14257 mitigation)                    | npm bundle `5.0.7` — **still vulnerable**, threshold is higher than the other two.                                                                                                                                  | npm bundle `5.0.7` vulnerable; corepack cache `2.1.2` vulnerable (per-major-line data for this specific CVE gives a 2.x-line fix at `2.1.4`; `2.1.2 < 2.1.4`).                                                                                                                                                                                                                                                                                | `>= 5.0.9` (top line) / `>= 2.1.4` (2.x line) — GHSA-rgw5-rvv9-x895, high, reviewed, multi-range record. Neither threshold is met anywhere.                                                                       | **KEEP, JUSTIFICATION CORRECTED** — genuinely still exploitable in the npm bundle on both images                        |
| `CVE-2026-69192` | ip-address                                                          | npm bundle `/usr/local/lib/node_modules/npm/node_modules/ip-address/package.json` → `10.2.0` — vulnerable.                                                                                                          | Same npm-bundle path `10.2.0` vulnerable; **also** corepack cache `10.2.0` vulnerable. Workspace app tree (`/app/node_modules`) has **no `ip-address` copy at all** post-prune — `find /app -path "*ip-address*/package.json"` returns nothing (the old `.trivyignore` claim "our app tree resolves ip-address@10.4.0" is now stale — the `--prod` prune dropped the devDependency chain, e.g. `socks-proxy-agent`, that used to pull it in). | `>= 10.3.1` — GHSA-mwp4-54f8-5fhr, high, reviewed. `10.2.0` does not meet it anywhere.                                                                                                                            | **KEEP, JUSTIFICATION CORRECTED** — stale "app tree" claim removed; genuinely still vulnerable in both bundle locations |

`git diff .trivyignore` after this task: empty (evidence-only, per the task's own instruction).

### `CVE-2026-55697` — the disputed "10.x backport" (why it stays KEEP despite matching evidence for the other two pnpm CVEs)

GitHub's own advisory record (`GHSA-gj8w-mvpf-x27x`, fetched directly via
`api.github.com/advisories/GHSA-gj8w-mvpf-x27x`) lists `vulnerable_version_range: "< 10.34.2"` /
`first_patched_version: "10.34.2"` for the `npm:pnpm` package on the 10.x line — which, taken at
face value, contradicts this entry's own text ("NO backport to the 10.x line") and would put our
installed `10.34.5` past the fix. This was investigated further rather than accepted, because
three things about the record itself are atypical for a normal reviewed GHSA advisory:

- The `description` field is templated internal tooling output ("Maintainer Action Plan",
  `Advisory: CAND-PNPM-097`), not prose — `CAND-` is a candidate/staging identifier, and the text
  explicitly says the next action is to _"review the shared patch branch..., **set the final
  affected version range**, merge and release the fix, then publish or close the advisory"_ — i.e.
  the version range this record reports may not be the final, released one.
- The "shared patch PR" it cites lives in a separate, non-canonical repository
  (`pnpm/pnpm-ghsa-j2hc-m6cf-6jm8`), not `pnpm/pnpm` itself.
- pnpm's own GitHub release notes for `v10.34.2` (`api.github.com/repos/pnpm/pnpm/releases/tags/v10.34.2`,
  fetched and searched for `configDependenc|pacquet|install engine|GHSA-gj8w`) contain **zero**
  mention of this fix — the only security fix documented in that release is a different,
  unrelated advisory (`GHSA-3qhv-2rgh-x77r`, `.npmrc` environment-variable expansion).

Given the advisory's own text says the affected-version range is not yet finalized, and the
claimed fix release doesn't corroborate it in its own public changelog, the "10.x backport exists"
claim is **not** treated as established fact. `withdrawn_at` is `null` (not retracted) and
`github_reviewed_at` is populated (`2026-06-26`), so this is not simply thrown out either — it is
recorded as **disputed/unconfirmed** and the entry is kept on its existing, independently-solid
runtime-exploitability grounds (below), not on a version-fix claim.

**The runtime clauses the plan requires re-checking, verified against the pruned API image:**

- Does the runtime still never run `pnpm install`? — The only `pnpm install` in the entire
  Dockerfile is `apps/api/Dockerfile:16`, inside the `deps` **build** stage (`RUN pnpm install
--frozen-lockfile`), which does not exist in the final runtime image. `docker-entrypoint.sh` —
  the actual runtime-stage code — contains **zero** `pnpm` invocations of any kind (`grep -n pnpm
apps/api/docker-entrypoint.sh` matches only a comment, "pnpm@10 hoists to root").
- Is `pnpm tsx` still the only pnpm invocation? — Confirmed: the sole pnpm invocation anywhere in
  the chart templates is `cronjob-anonymizer.yaml:51`, `command: ["pnpm", "tsx",
"scripts/anonymize-dump.ts"]`.
- Is the pnpm major line still unchanged? — Yes, `10.34.5` (`packageManager: "pnpm@10.34.5"` in
  root `package.json`), untouched by this phase, per D-05.

**This changes nothing about D-05's outcome** (entry stays, pnpm major line untouched) but the
justification text is rewritten below to state the disputed-advisory finding honestly instead of
asserting "NO backport" as settled fact — an unqualified "no backport exists" claim would itself
now be the kind of stale, unverified assertion this phase exists to correct. Flagged as a fast,
concrete follow-up in `deferred-items.md`: confirm directly (changelog diff or reproduction)
whether pnpm 10.34.2+ actually contains this fix, independent of this phase.
