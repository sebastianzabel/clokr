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

| Who                   | Does                                                                                                                                                                                                                                                                                  | Through                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Employee              | books the contract day (late arrival, jitter, breaks; a few deliberate long days or missing breaks, recorded as intents), sick days (SICK, SICK_CHILD), vacation requests and their withdrawal, late Zeitnachträge, WLAN connect/disconnect events, NFC taps that forget to clock out | web API with own login, presence source key, NFC terminal key |
| Manager               | plans the next 14 days of shifts, approves or rejects leave (never their own), corrects an end time with a reason, closes last month from a seeded day (sometimes late, with gaps confirmed)                                                                                          | web API                                                       |
| Admin                 | hires on the hire day, contract change on the 1st, company holiday, exit, anonymization three days later                                                                                                                                                                              | web API                                                       |
| Second tenant's admin | asks for the chain's employees, salons, entries and leave with a foreign id and with an unknown id and records both answers                                                                                                                                                           | web API                                                       |

All decisions come from `rngFor(seed, "day", date, person)`: a stream is addressed by its keys, never
by order, so one person's day is reproducible alone.

The bot extension of Issue #715 adds: withdrawing a future vacation (pending: at once; approved: a
cancellation request that a DIFFERENT manager than the original approver decides, approved or
rejected), Kinderkrank (`SICK_CHILD`, counted as `leave.sick-child`), Zeitnachträge (entry-first: a
manual entry beyond the 10-day window with a reason; an employee sometimes "forgets" to book and files
it once the window is over, a replayed day beyond the window files about half of its entries late; the
manager approves or rejects with the mandatory note), shift edits (the manager moves or withdraws a few
shifts of next week; the product refuses past edits) and the month unlock (admin, with a reason; the
manager bot closes the month again the same day). The WLAN break workaround (`entry.break`) stays until
Issue #799 is on main.

Deliberate cases the checker knows: `intents` (long day, missing break, open entry) and `unlocks`
(`progress.json`). An unlock changes the closed month's entries and snapshots on purpose, so
`months.closed-unchanged` drops findings for exactly that person and month; any other change is still red.

Known gaps (follow-ups, not blockers): withdrawing a Zeitnachtrag and cancelling sick leave are not
simulated; a forgotten NFC clock-out is left to the API's cron and is not corrected by a manager.
