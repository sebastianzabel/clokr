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

<!-- WEB_AFTER_SECTION -->

---

## After: `apps/api` (Plan 03/04)

Not yet measured. `apps/api`'s runtime dependency set has NOT been established empirically yet —
that is Plan 02's job (IMG-02). Do not prune `apps/api/Dockerfile` before Plan 02 completes; see
`102-CONTEXT.md` D-02.

<!-- API_AFTER_SECTION -->
