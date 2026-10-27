# Simulation instance (Issue #715)

A small separate server runs the current release image with a synthetic chain tenant (30 salons, about
300 people) and a small second tenant. Seeded bots use it every day through the real interfaces, the
API cron jobs run unchanged, and a read-only checker verifies invariants every night and files an
issue per violation. It finds what single-case tests cannot: month closes, crons, performance, salon
changes and real click orders over weeks (examples from v1.16.0: #696, #714, #706).

Everything lives in `apps/sim` (`@clokr/sim`, never part of a release image) plus this file. What is
**not** built yet: the time-travel clock (issue section 4, only if real time is not enough) and the
actual server (needs a host decision, see "Open for the owner").

## Rules that must hold

- **No real personal data, ever.** Every name is a fake (`<spelling-alphabet word> Bot-C0042`), every address ends
  in `.invalid`, nothing is imported from prod or int. Never restore a dump into the sim.
- **Not publicly reachable.** All published ports are bound to `127.0.0.1`. A server install reaches
  the web app only through the `edge` profile (Caddy with Basic-Auth, no unauthenticated path) behind
  a firewall that allows the owner's addresses or a VPN only. No port forward to the API, the database
  or the mail catcher.
- **No mail leaves the host.** The API sends through `mailpit`, a mail catcher; nothing is relayed.
- **Never start it on a developer machine's dev stack.** Own compose project (`clokr-sim`), own
  volumes, own ports (API 14100, web 13100, Postgres 15532, mail catcher 18125, edge 18180; never
  3000/4000/3001/4001/5432/5433).
- **The bots have no database access.** Web API with a real login, the NFC terminal key, the WLAN
  presence source, the operator API. Only the checker reads the database, through a role that cannot
  write.

## Layout

```
apps/sim/
  docker-compose.sim.yml   same structure as docker-compose.prod.yml, + mailpit, + edge profile
  Caddyfile                Basic-Auth edge
  sim.env.example          copy to sim.env (git-ignored)
  bin/sim.sh               up | down | destroy | operator | ro-role | logs
  sql/readonly-role.sql    the checker's database role
  src/plan.ts              the synthetic population (pure, from the seed)
  src/provision/           tenants, salons, people through the operator and tenant API
  src/bots/                employee, manager, admin and the second tenant's isolation bot
  src/checker/             invariants, performance trend, issue filing, report
  .sim/                    generated state (git-ignored): state.json, progress.json, logs/, reports/
```

## Server setup

Requirements: Docker with the compose plugin, Node 24 and pnpm 10 (for the bots and the checker, they
run on the same host or on any host that can reach the API port), `gh` logged in for the checker's
issues, 4 GB RAM and 2 vCPUs are enough for 300 people.

```bash
git clone https://github.com/sebastianzabel/clokr.git && cd clokr
pnpm install --frozen-lockfile
cd apps/sim
cp sim.env.example sim.env
# fill every secret: openssl rand -hex 32 (POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET,
# OPERATOR_JWT_SECRET, ENCRYPTION_KEY, MINIO_ROOT_PASSWORD) and set the two image tags to the release
```

Edge with Basic-Auth (server only):

```bash
docker run --rm caddy:2.8.4-alpine caddy hash-password --plaintext '<a long password>'
# in sim.env: SIM_EDGE_USER=<name>  SIM_EDGE_HASH=<the hash>  SIM_EDGE_BIND=<private interface address>
EDGE=1 bin/sim.sh up        # starts web and edge too
```

Firewall: allow `SIM_EDGE_PORT` (default 18180) from the owner's addresses or the VPN only; everything
else stays closed. The edge speaks plain HTTP on that port; terminate TLS on the host's own proxy or
keep the access inside the VPN. Set `APP_URL`/`CORS_ORIGIN` in `sim.env` to the URL users type.

## Install

```bash
cd apps/sim
bin/sim.sh up                  # postgres, redis, minio, mailpit, api (migrations run on start)
bin/sim.sh operator            # one operator account + TOTP secret -> .sim/operator.json (mode 600)
bin/sim.sh ro-role             # prints SIM_DB_URL for the checker -> put it into sim.env
pnpm sim provision --size full --backfill-days 8
pnpm sim backfill              # replays the 8 days before today, in order
```

`--size small` (2 salons, 15 people) is for smoke runs. A backfill is limited by the product itself:
manual web entries older than the retro window (10 days) are refused, so replayed older days carry
only WLAN history (presence events keep their timestamp) and the bots count the skipped web entries
(`entry.skipped-retro`). Months are therefore closed for real only when real time passes: the first
close happens in the first week of the next month. Start with `--backfill-days 0` if in doubt. `provision` creates both tenants through the
operator API (tenant, packages) and the tenant API (admin invitation read from the mail catcher,
salons in different Bundesländer, 300 people, Stammsalon, Springer deployments, Berufsschule
patterns, WLAN opt-in with a device each, NFC terminal key, presence source). The auto break is on.
The population covers FIXED_SCHEDULE, FLEXTIME, MONTHLY_HOURS with and without hours, SHIFT_BASED,
Azubis with Berufsschule, minors, Springer, planned exits and later hires. `pnpm sim plan --size full`
prints the counts without touching anything.

## Daily schedule

One invocation of `pnpm sim day` simulates one real day (today in the tenant time zone, or
`--date`). A day that already ran is refused. Run it in the evening so that all entry times lie in
the past; the API's own cron jobs run in the API container as in any environment.

`/etc/systemd/system/clokr-sim-day.service`

```ini
[Service]
Type=oneshot
User=sim
WorkingDirectory=/opt/clokr/apps/sim
ExecStart=/usr/bin/env pnpm sim day
```

`/etc/systemd/system/clokr-sim-day.timer`: `OnCalendar=*-*-* 22:30:00`, `Persistent=true`.
The checker runs after the API's night crons:

`/etc/systemd/system/clokr-sim-check.service`: `ExecStart=/usr/bin/env pnpm sim check --create-issues`
with a timer at `OnCalendar=*-*-* 03:30:00`.

Logins are spaced out (the API allows 50 per minute and address), so a full day of 300 people takes
several minutes. Exit codes of `sim day`: 0 ok, 3 the bots met a server error. Of `sim check`: 0 all
green, 2 findings, 1 a check itself failed (also red).

## What the bots do

| Who                   | Does                                                                                                                                                                                                                                         | Through                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Employee              | books the contract day (late arrival, jitter, breaks; a few deliberate long days or missing breaks, recorded as intents), sick days (SICK, SICK_CHILD), vacation requests, WLAN connect/disconnect events, NFC taps that forget to clock out | web API with own login, presence source key, NFC terminal key |
| Manager               | plans the next 14 days of shifts, approves or rejects leave (never their own), corrects an end time with a reason, closes last month from a seeded day (sometimes late, with gaps confirmed)                                                 | web API                                                       |
| Admin                 | hires on the hire day, contract change on the 1st, company holiday, exit, anonymization three days later                                                                                                                                     | web API                                                       |
| Second tenant's admin | asks for the chain's employees, salons, entries and leave with a foreign id and with an unknown id and records both answers                                                                                                                  | web API                                                       |

All decisions come from `rngFor(seed, "day", date, person)`: a stream is addressed by its keys, never
by order, so one person's day is reproducible alone.

Known gaps (follow-ups, not blockers): cancellation of approved leave, Zeitnachträge, shift changes of
existing shifts and unlocking a month are not simulated yet; a forgotten NFC clock-out is left to the
API's cron and is not corrected by a manager.

## Nightly checker

`pnpm sim check [--create-issues] [--repo owner/name] [--skip-perf] [--rebaseline]` connects with
`SIM_DB_URL` (read-only), logs in as the chain admin for the API reads, writes
`.sim/reports/YYYY-MM-DD.json` and prints it. Without `--create-issues` it is a dry run that only
lists what it would file. An issue carries the label `simulation`, ids and dates only, a stable
`sim-key` (one open issue per key) and the seed. The checker's database access is read-only three
times over: the role has only SELECT (and no credential tables), every session starts read-only, and
every unit of work is `BEGIN READ ONLY`.

| Invariant                                                                                                                                         | Decided by                                | Proof (red on an injected violation, green on clean data)                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `entries.no-overlap` no two closed entries of one person overlap                                                                                  | SQL                                       | `sim-invariants-715.test.ts`: the exclusion constraint is dropped in a rolled-back transaction, two overlapping rows are inserted |
| `entries.single-open-per-day` at most one open entry per person and day                                                                           | SQL                                       | same, with the partial unique index dropped                                                                                       |
| `months.closed-unchanged` checksums of locked entries and monthly snapshots equal yesterday's                                                     | SQL + baseline in `.sim/check-state.json` | locked entry changed and snapshot deleted after taking the baseline                                                               |
| `audit.coverage` every created or changed entry and leave request has an `AuditLog` row                                                           | SQL                                       | entry without audit row, then with, then changed without a matching row                                                           |
| `tenant.references` entries and shifts reference salons of their own tenant only                                                                  | SQL                                       | entry pointing at a salon of the other tenant                                                                                     |
| `saldo.consistent` live saldo = carry + open months; overtime account, leave surface, overview and period report agree                            | API reads of a seeded sample of 25        | `checker.test.ts` with a fake API (agreeing and drifting surfaces)                                                                |
| `arbzg.only-intended` days over 10 h and entries over 6 h with under 30 min break exist only where a bot caused them (that day or the day before) | SQL + bot intents                         | 11 h entry without intent is red, with intent green, a normal day green                                                           |
| `tenant.isolation` the second tenant gets the identical 404 for foreign and unknown ids                                                           | probe results of the bot days             | `checker.test.ts` (identical / differing / non-404 answers)                                                                       |
| `api.no-server-errors` the bots never met a 5xx                                                                                                   | bot day logs                              | `checker.test.ts`                                                                                                                 |
| `perf.response-times` see below                                                                                                                   | measured by the checker                   | `checker.test.ts` (limits, hard limit, trend, non-200)                                                                            |

Anti-vacuity: a check that throws is reported as an error (exit 1), and a check that examined nothing
although at least two days were simulated becomes a finding of its own (`vacuous:<id>`), so a check
that silently stopped seeing anything cannot stay green. `months.closed-unchanged` is exempt until the
first month is closed. An operator-run unlock of a month is reported by design (the bots never
unlock); acknowledge it with `--rebaseline`.

### Response times and trend

Each run measures `GET /reports/period` for 1, 3 and 12 months, `GET /dashboard`, the Monatsabschluss
status read and the slowest bot-side `close-month` of the last day, and appends one line to
`.sim/trend.jsonl`. Limits:

| Metric                               | Limit                                                     | Source                                      |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------- |
| period 12 months at 300 people       | 15 s; scaled down linearly with person-months (floor 2 s) | #688, #696 acceptance criteria              |
| any period call                      | 30 s hard limit                                           | #696 (web proxy gives up)                   |
| dashboard                            | 3 s                                                       | proposed in #715, not from an earlier issue |
| month close (status read, one close) | 10 s                                                      | proposed in #715                            |
| trend                                | above 2x the median of the last 7 runs and above 1 s      | proposed in #715                            |

A non-200 answer is a finding. A persistent breach is one issue (`perf:<metric>:limit`), not one per
night.

## Reproduce a failure from a seed

Every issue names the seed and the date. On a fresh instance (`bin/sim.sh destroy`, `up`, `operator`,
`ro-role`) run `pnpm sim provision --size full --backfill-days <N>` with `SIM_SEED=<seed>` so that
the epoch matches, then `pnpm sim backfill` up to the date of the finding and `pnpm sim check`. One
person's day alone: the bot decisions of person `c0042` on `2026-11-03` come from
`rngFor(seed, "day", "2026-11-03", "employee", "c0042")` and do not depend on anyone else. The per-day
logs (`.sim/logs/`) list every action with counts and the deliberate intents.

## Upgrading the release under test

Set the new image tags in `sim.env` and `bin/sim.sh up`. The API applies its migrations on start; the
volumes keep the data, so a new release is tested against weeks of history. `bin/sim.sh destroy`
deletes everything (`down -v`) and the generated state.

## 4-week report (template)

After four weeks of daily runs write the report into the issue:

```
## Simulation report <from> to <to>, release <x.y.z>, seed <seed>
- Days simulated / skipped (with reason):
- People / salons / months closed:
- Findings by invariant (count, issue links):
- Findings that were bot or checker bugs (fixed in sim):
- Response times: table of period 1/3/12 m, dashboard, month close: first week vs last week, max
- Trend verdict (stable / growing, which metric)
- Follow-up tickets (one line each, with severity)
- What the simulation did NOT cover (gaps list above) and what to add next
```

## Open for the owner

- The host (where the server runs) and its network exposure (VPN or allow-listed addresses).
- Whether the time-travel clock (issue section 4) is needed after the first four weeks.
- Provisioning the server, the first `provision --size full` and the four-week run are not part of the
  repository change that introduced this setup.
