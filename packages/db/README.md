# @clokr/db

This package holds the Prisma schema (`prisma/schema.prisma`), the generated Prisma client, and
three development seed/reset scripts in `src/`.

## Scripts

| Script              | Invocation                                           | What it does                                                                                                                                          |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/seed.ts`       | `pnpm --filter @clokr/db seed`                       | Minimal demo tenant with an admin and an employee login.                                                                                              |
| `src/seed-demo.ts`  | `pnpm --filter @clokr/db exec tsx src/seed-demo.ts`  | Rich, pseudonymized demo data for showcase screenshots (10 employees, leave requests, shifts, Phorest data, …). Expects an EMPTY database.            |
| `src/reset-demo.ts` | `pnpm --filter @clokr/db exec tsx src/reset-demo.ts` | Deletes all non-admin employees of the admin's tenant and recreates five demo employees with time entries/leave/absences. Development-only (GH #213). |

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
