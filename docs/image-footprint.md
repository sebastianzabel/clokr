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

## After: `apps/api` (Plan 03/04)

Not yet measured. `apps/api`'s runtime dependency set has NOT been established empirically yet —
that is Plan 02's job (IMG-02). Do not prune `apps/api/Dockerfile` before Plan 02 completes; see
`102-CONTEXT.md` D-02.

<!-- API_AFTER_SECTION -->
