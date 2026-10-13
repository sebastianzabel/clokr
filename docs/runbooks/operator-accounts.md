# Operator Accounts — Server Runbook

**Audience:** the operator (whoever has shell access to the Clokr server).
**Related script:** `apps/api/scripts/operator-account.ts` (Phase 88, #88)
**Related code:** `apps/api/src/contexts/platform/operator-credentials.ts`

An operator account is the principal **above the tenant**. It exists to run the SaaS (create and
deactivate tenants, re-send an admin invitation); it never sees tenant data. It is created **only** on the
server with the CLI below — there is no route, seed or UI that creates one — and it always has a second
factor from the start: a TOTP authenticator plus 10 single-use recovery codes. Every lifecycle step is
audited in `OperatorAuditLog` (actor type `SCRIPT` with OS user and host), never in a tenant audit log.

## Prerequisites

- Shell on the server (in the API container, whose working directory is `/app`: `docker exec -w /app/apps/api <container> pnpm tsx scripts/operator-account.ts …`; from a checkout:
  `pnpm --filter @clokr/api exec tsx scripts/operator-account.ts …`).
- `DATABASE_URL` of the target environment.
- `ENCRYPTION_KEY` of that environment (min 32 chars). The TOTP secret is stored encrypted with it —
  create the account with the same key the running API uses, or the API cannot decrypt the secret.
- Optional `OPERATOR_PASSWORD`. Without it a password is generated and printed once. The password is
  **never** accepted on the command line (shell history, process list). Policy: at least 16 characters with
  upper case, lower case, digit and special character.
- For the operator API surface itself (sign-in, tenant management) the API needs `OPERATOR_JWT_SECRET`
  (added in plan 88-03). Creating an account does not need it.

## Create an operator

Dry-run first (default; writes nothing):

```bash
DATABASE_URL=… ENCRYPTION_KEY=… \
  pnpm --filter @clokr/api exec tsx scripts/operator-account.ts \
  --create --email <email> --display-name "<name>"
```

Then apply:

```bash
DATABASE_URL=… ENCRYPTION_KEY=… [OPERATOR_PASSWORD=…] \
  pnpm --filter @clokr/api exec tsx scripts/operator-account.ts \
  --create --email <email> --display-name "<name>" --apply
```

The output is shown **once** and is never stored by the script:

1. the generated password (only when `OPERATOR_PASSWORD` was not set),
2. the `otpauth://` URI and the base32 TOTP secret,
3. 10 recovery codes.

Do not redirect the output to a file. Enrol the authenticator by scanning the URI as a QR code (or typing
the secret) in an authenticator app, and store the recovery codes **offline** (password manager or
printout in a safe) — each works exactly once.

## Sign-in flow

Password first, then a 6-digit authenticator code (the API is delivered in plan 88-08). A code is accepted
at most once: signing in twice inside the same 30-second window needs the next code. After 5 failed
attempts the account is locked for 15 minutes. A recovery code replaces the authenticator code once and is
then consumed.

## Lost authenticator

```bash
… scripts/operator-account.ts --reset-mfa --email <email> --apply
```

Replaces the TOTP secret and all recovery codes (old ones stop working), clears the lockout and the replay
state, and prints the new enrolment data once. Writes one `OPERATOR_MFA_RESET` audit row. Every token
already issued for the account (the access token and a pending sign-in challenge) is refused from the next
request on (Issue #557); the operator signs in again with the new authenticator.

## Offboarding

```bash
… scripts/operator-account.ts --deactivate --email <email> --apply
```

The account stays in the database (audit rows reference it and cannot be removed) but can no longer sign
in. Writes one `OPERATOR_DEACTIVATED` audit row. Deactivating an already inactive account is refused.
Every access token already issued is refused from the next request on.

## Tenant management

All routes live under `/api/v1/operator/tenants` and need an operator access token (see "Sign-in flow").
They return tenant metadata only — never employees, time entries or leave. There is no delete route:
a tenant that leaves is deactivated.

**Create** (`POST /`). One request creates the tenant, its configuration, a default salon, the default
leave types and the first admin, and sends the invitation mail. The body needs `name`, `slug` (lowercase
letters, digits and hyphens, 3–63 characters), `federalState` (required: the Bundesland decides the
statutory holidays of the default salon and cannot be changed later while the salon is in use),
optionally `timezone`, and the first admin (`firstName`, `lastName`, `email`, hire date). The invitation
link is valid for 24 hours. The response reports `invitationMailSent`; `false` means the tenant exists
but the mail failed — check the SMTP settings, then re-issue the invitation (below). A taken slug or
e-mail answers 409 and creates nothing.

**Re-issue the first admin's invitation** (`POST /:id/resend-admin-invitation`). Allowed only in the
bootstrap window: the tenant is not deactivated and no user of the tenant is active yet. Once the first
admin has signed in, invitations are the tenant's own business and this route answers a refusal.

**Defaults to know about.** The new tenant's master switch `emailNotificationsEnabled` is **off**; the
tenant's admin switches it on in the admin area once SMTP is configured. Without it no notification
mail is sent.

**Rename** (`PATCH /:id`). Changes the tenant name only; the slug and the default salon's name stay.

**Deactivate** (`POST /:id/deactivate`, a reason of 3–500 characters is required). Effective at once on
every path: sign-in, token refresh, password reset and invitation acceptance are refused, and every
request of an already issued access token, API key or device key is answered with 403 (the per-process
state cache is invalidated by the route; a second API replica sees it within 10 seconds). Open refresh
tokens are revoked. All business data stays untouched. Writing background jobs (month close, attendance
checks, Phorest sync, reminders) skip the tenant; the data-retention purge keeps running for it. Reason
and acting operator are written to the operator audit log.

**Reactivate** (`POST /:id/reactivate`). Clears the deactivation; users sign in again with their existing
credentials, the jobs resume with their next run.

## Int refresh

The prod → int data refresh (`docs/data-refresh-process.md`) neutralises **every** operator account with
the pseudonymizer: prod operator credentials never reach int. After the swap, re-create an int operator
with the CLI above (step 9 of that document), using int's own `ENCRYPTION_KEY`.

## Exit codes

`0` ok, `1` error (bad arguments, validation, unknown or duplicate account, connection failure).
