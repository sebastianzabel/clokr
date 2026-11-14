# @clokr/db

This package holds the Prisma schema (`prisma/schema.prisma`), the generated Prisma client, and
three development seed/reset scripts in `src/`.

## Scripts

| Script              | Invocation                                           | What it does                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/seed.ts`       | `pnpm --filter @clokr/db seed`                       | Minimal demo tenant with an admin and an employee login.                                                                                                                                                                                    |
| `src/seed-demo.ts`  | `pnpm --filter @clokr/db exec tsx src/seed-demo.ts`  | Rich, pseudonymized demo data for showcase screenshots (10 employees in two salons incl. a Springerin, two SHIFT_BASED rosters, open leave requests, break findings, Phorest data; saldi near zero, Issue #577). Expects an EMPTY database. |
| `src/reset-demo.ts` | `pnpm --filter @clokr/db exec tsx src/reset-demo.ts` | Deletes all non-admin employees of the admin's tenant and recreates five demo employees with time entries/leave/absences. Development-only (GH #213).                                                                                       |

## Mutually exclusive seeds

`seed.ts` and `seed-demo.ts` both create their tenant with slug `demo-clokr` and each bails out
early if a tenant with that slug already exists. Run exactly **one** of them against a given
database, never both. `reset-demo.ts` works after either one — it locates the admin and tenant
dynamically rather than assuming which seed ran.

## Admin login

The admin address is the single constant `ADMIN_EMAIL`, exported by `src/seed-credentials.ts`
(Phase 275 D-03). That file deliberately has zero imports and zero side effects, so it is safe to
import from scripts, tests, and e2e helpers without opening a database connection as a side
effect. Both `seed.ts` and `seed-demo.ts` create the admin user with `ADMIN_EMAIL`, and
`reset-demo.ts` looks the admin up by the same constant (issue #343) — do not hardcode the admin
address anywhere else; import the constant instead.

Passwords are their own, separate constants — also referenced by name here, not by value:

- `seed.ts` hashes `ADMIN_PASSWORD` (from `seed-credentials.ts`) for the admin.
- `seed-demo.ts` hashes its own `DEMO_PASSWORD` constant for every user it creates, including the
  admin.
- `reset-demo.ts` does not change the admin's password; the five employees it (re-)creates get the
  password it prints in its own summary output.

## Command sequence: seed-demo.ts, then reset-demo.ts

```bash
# 0. Point at a DEVELOPMENT database with all migrations applied.
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  pnpm --filter @clokr/db exec prisma migrate deploy

# 1. Seed the rich demo tenant (fails fast if a "demo-clokr" tenant already exists).
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  pnpm --filter @clokr/db exec tsx src/seed-demo.ts

# 1b. Close the demo's previous month with Clokr's real closer (Issue #595). The seed no longer
#     invents a closed month: it writes the previous month's entries unlocked and only a zero
#     "pre-tracking" snapshot for the month before. This dev wrapper hands the demo tenant's
#     chain-head employees to the exported core of scripts/backfill-month-snapshots.ts and proves
#     per employee that the stored figures equal the kernel's (exit 3 on any mismatch, exit 2 when
#     nothing is left to close). Dry run first, then write; the database name must be spelled out
#     and must equal the connected one. Without this step the running API's 06:00 auto-close
#     closes the same month the next morning.
#     Since Issue #577 the demo tenant has TWO salons, and the backfill core this wrapper hands
#     on to refuses multi-salon tenants (one tenant-wide holiday set, Phase 71b); the wrapper then
#     reports every person as a mismatch and writes nothing. The previous month stays open (the
#     live saldo is still correct) until the running API's 06:00 auto-close closes it.
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  pnpm --filter @clokr/api exec tsx scripts/demo-close-previous-month.ts --confirm-database clokr
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  pnpm --filter @clokr/api exec tsx scripts/demo-close-previous-month.ts --apply --confirm-database clokr

# 2. Reset it back to the smaller reset-demo employee set — safe to re-run.
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  CONFIRM_RESET_DEMO=yes \
  pnpm --filter @clokr/db exec tsx src/reset-demo.ts
```

**Safety notes:**

- `reset-demo.ts` refuses to run when `NODE_ENV=production`, or when `CONFIRM_RESET_DEMO=yes` is
  missing — both checks happen at module load, before any database connection is opened (GH #213).
- `reset-demo.ts` hard-deletes `TimeEntry` / `LeaveRequest` / `Absence` / `SaldoSnapshot` /
  `EmployeeSalonAssignment` / `PhorestStaffMapping` / `PhorestAppointment` / `Employee` / `User`
  rows for the employees it removes — exactly what CLAUDE.md § Audit-Proof forbids doing to real
  data. These two scripts are for development databases only, never int or prod.
- Schema changes go through versioned migrations — never `prisma migrate dev` or `db push` on this
  project. See the root `CLAUDE.md` § "Creating a migration" and `docs/migrations.md`.

## UX-test tenant: `apps/api/scripts/seed-ux-test-tenant.ts` (Issue #952)

For user tests by persona (Mitarbeiterin, Salonleitung, Inhaberin, Personalabteilung) run this
script instead of testing on the grown demo data. It needs no empty database: every run creates a
NEW tenant „UX-Test <dd.mm.>“ (slug `ux-test-<yyyymmdd>-<hex>`) and **deactivates** every earlier
UX-test tenant (slug prefix `ux-test-`; never deleted). Run it right before a test session, so the
picture is relative to that day.

```bash
# The local docker stack must be up (postgres on localhost:5432, web on localhost:3000).
DATABASE_URL="postgresql://clokr:<password>@localhost:5432/clokr" \
  pnpm --filter @clokr/api exec tsx scripts/seed-ux-test-tenant.ts [--out <file>]
```

- **Output:** the accounts (role, e-mail, password, employee id, Stammsalon, contract) go to
  `.planning/redesign/ux-test-personas.md` (gitignored, overwritten each run, mode 0600). Passwords
  are generated per run and never printed to stdout.
- **Content:** two salons (Mitte, Nord; NRW; open Monday to Friday); Inhaberin (Inhaber, whole
  tenant), Salonleitung (Salonmanager for Salon Nord), Personalabteilung (whole tenant), and the
  employees Vollzeit 40 h Mo–Fr, Teilzeit 32 h Di–Fr, Schicht (SHIFT_BASED, 5 days), Azubi under 18
  with Berufsschule on Tuesdays, Minijob (MONTHLY_HOURS 40 h). Recorded time with breaks from the
  1st of the previous month through yesterday, no running clock; the previous month is closed with
  the real closer. Deliberate cases: a missing day (Teilzeit), an overtime day, a sick day, a past
  and a future vacation (Vollzeit/Schicht), a pending request (Aufgaben), a still valid carry-over
  (Vollzeit), the shift roster and coverage rules of Salon Nord.
- **How:** tenant, persons, roles, leave, Berufsschule, shifts and the month close go through the
  real provisioning core and the real routes (in-process `app.inject`, so their checks and audit rows
  apply). Only the recorded working time and the zero pre-tracking snapshots of the Vollzeit person
  (hired before tracking began) are written directly — each with an audit row marked
  `trigger: "UX_TEST_SEED"`; the API's own write path books past entries of other persons as
  corrections and refuses them outside the retro window for the person themself.
- **Safety:** refuses `NODE_ENV=production` and any database host other than `localhost`,
  `127.0.0.1`, `::1` or `postgres`; removed from the runtime image (`apps/api/Dockerfile`). JWT and
  encryption secrets are generated per run when unset — they only sign tokens inside the script's
  own process, and the script writes nothing encrypted. Development databases only, never int or
  prod.
