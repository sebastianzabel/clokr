/**
 * Operator account CLI (Phase 88, #88, D-03/D-03a).
 *
 * The ONLY way an operator account (the principal above the tenant) comes into existence. No route, no
 * seed and no UI creates one: whoever can run this script on the server creates the most privileged
 * principal, and every run that writes is audited in `OperatorAuditLog` (actor type SCRIPT with the OS
 * user and host).
 *
 * Usage (dry-run by default; nothing is written without --apply):
 *   DATABASE_URL=<dsn> ENCRYPTION_KEY=<key> [OPERATOR_PASSWORD=<pw>] \
 *     pnpm --filter @clokr/api exec tsx scripts/operator-account.ts \
 *     --create --email <email> --display-name <name> [--apply]
 * In the API container: `pnpm tsx scripts/operator-account.ts …`.
 *
 * The password is never taken from argv (shell history, process list): `OPERATOR_PASSWORD` or, when unset,
 * a generated one printed once. The TOTP secret, otpauth URI and the 10 recovery codes are printed to
 * stdout once and are never written to a file or log.
 *
 * Exit codes: 0 — ok, 1 — error (bad arguments, validation, connection, duplicate).
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  OPERATOR_PASSWORD_POLICY,
  createOperatorAccount,
  normalizeOperatorEmail,
  type OperatorActor,
} from "../src/contexts/platform/operator-credentials";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export type OperatorAccountArgs = {
  mode: "create";
  email: string;
  displayName?: string;
  apply: boolean;
};

/** Parses argv (without node/script). Throws an Error with a readable message on any misuse. */
export function parseOperatorAccountArgs(argv: string[]): OperatorAccountArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      create: { type: "boolean" },
      email: { type: "string" },
      "display-name": { type: "string" },
      apply: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const modes = (["create"] as const).filter((m) => values[m]);
  if (modes.length !== 1) throw new Error("Exactly one mode flag is required: --create");
  if (!values.email) throw new Error("--email is required");
  return {
    mode: modes[0],
    email: values.email,
    displayName: values["display-name"],
    apply: values.apply === true,
  };
}

/** 24 chars of url-safe entropy plus the classes the operator policy requires. */
function generateOperatorPassword(): string {
  return `${randomBytes(18).toString("base64url")}-Aa1!`;
}

async function main(argv: string[]): Promise<number> {
  let args: OperatorAccountArgs;
  try {
    args = parseOperatorAccountArgs(argv);
  } catch (err) {
    console.error(`[operator-account] ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
  if (!process.env.DATABASE_URL) {
    console.error("[operator-account] DATABASE_URL is required");
    return EXIT_ERROR;
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    console.error("[operator-account] ENCRYPTION_KEY is required (min 32 chars)");
    return EXIT_ERROR;
  }

  const email = normalizeOperatorEmail(args.email);
  if (!args.displayName) {
    console.error("[operator-account] --display-name is required for --create");
    return EXIT_ERROR;
  }

  if (!args.apply) {
    console.log(
      `[operator-account] DRY RUN — would create operator account ${email} ("${args.displayName}") ` +
        `with TOTP enrolment and 10 recovery codes (password policy: min ${OPERATOR_PASSWORD_POLICY.passwordMinLength}). ` +
        "Nothing written. Re-run with --apply.",
    );
    return EXIT_OK;
  }

  const suppliedPassword = process.env.OPERATOR_PASSWORD;
  const password = suppliedPassword || generateOperatorPassword();
  const actor: OperatorActor = { type: "SCRIPT", user: userInfo().username, host: hostname() };

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const result = await createOperatorAccount(prisma, {
      email,
      displayName: args.displayName,
      password,
      actor,
    });
    if (result.status === "EMAIL_TAKEN") {
      console.error(`[operator-account] an operator account with ${email} already exists`);
      return EXIT_ERROR;
    }
    if (result.status === "INVALID") {
      console.error(`[operator-account] invalid input: ${result.errors.join("; ")}`);
      return EXIT_ERROR;
    }
    console.log(
      `[operator-account] created operator account ${result.account.email} (${result.account.id})`,
    );
    if (!suppliedPassword) console.log(`password (shown once): ${password}`);
    console.log(`otpauth URI (shown once): ${result.enrollment.otpauthUri}`);
    console.log(`TOTP secret (shown once): ${result.enrollment.secretBase32}`);
    console.log("recovery codes (shown once, store offline):");
    for (const code of result.recoveryCodes) console.log(`  ${code}`);
    return EXIT_OK;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run-guard (Issue #203 class): only bootstrap the DB and execute when invoked as a script, so importing
// the module for unit tests opens no connection and never exits the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
