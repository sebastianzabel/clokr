import { createECDH } from "node:crypto";
import { z } from "zod";

// Blank (or whitespace-only) env values count as unset.
function blankToUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);
}

// Issue #608 (D-01) — push services (Apple in particular) refuse a localhost VAPID subject.
function isUsableVapidSubject(subject: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return true;
  try {
    const url = new URL(subject);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      host !== "127.0.0.1" &&
      host !== "[::1]"
    );
  } catch {
    return false;
  }
}

// Issue #608 (D-01) — the public key a P-256 private key implies, base64url, or null when the
// private key is not a valid scalar. Used for the boot-time pair check only.
function deriveVapidPublicKey(privateKeyBase64Url: string): string | null {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKeyBase64Url, "base64url"));
    return ecdh.getPublicKey().toString("base64url");
  } catch {
    return null;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    API_PORT: z.coerce.number().default(3000),
    API_HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().url(),
    ENCRYPTION_KEY: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().default("15m"),
    JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:5173")
      .refine((v) => v !== "*", {
        message: "CORS_ORIGIN must not be a wildcard (*) — set an explicit origin",
      }),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    APP_URL: z.string().default("http://localhost:5173"),
    POOL_MIN: z.coerce.number().default(2),
    POOL_MAX: z.coerce.number().default(20),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_EMAIL: z.string().optional(),
    SMTP_FROM_NAME: z.string().optional(),
    SMTP_SECURE: z.string().default("false"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    LOG_FILE: z.string().optional(), // Optional file path for log output
    LOG_FORMAT: z.enum(["json", "ecs", "pretty"]).default("json"), // json, ecs (Elastic Common Schema), pretty (dev)
    RATE_LIMIT_MAX: z.coerce.number().default(500), // Max requests per IP per minute
    // Phase 73-01 / 74-03 — gates the /api/v1/test/* surface (bootstrap-tenant,
    // teardown, X-Test-Now header). MUST remain false on int + prod per
    // CONTEXT T-74-01: date-pinning + tenant-bootstrap leak into prod would let
    // attackers backdate leave + create rogue tenants. Default false; CI + dev
    // docker compose set this to "true" explicitly.
    ALLOW_TEST_BOOTSTRAP: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    // Phase 88 (#88, D-02a) — separate signing secret for operator tokens. Optional: unset
    // (or blank — compose renders an unset variable as an empty string) means the operator
    // surface is not registered at all (88-08), so existing deployments boot unchanged. Never
    // reuse JWT_SECRET: access and refresh tokens already share it (research F6).
    OPERATOR_JWT_SECRET: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().min(32).optional(),
    ),
    // Issue #608 (D-01) — VAPID key set for web push. Optional as a SET, like OPERATOR_JWT_SECRET:
    // all three unset (or blank - compose renders an unset variable as an empty string) means the push
    // surface is not registered at all and nothing is offered in the UI. Setting only some of them, a
    // malformed key, a pair that does not match or an unusable subject refuses the start (superRefine
    // below). Never derived from, or defaulted to, another secret.
    VAPID_PUBLIC_KEY: blankToUndefined(z.string().min(1).max(255).optional()),
    VAPID_PRIVATE_KEY: blankToUndefined(z.string().min(1).max(255).optional()),
    VAPID_SUBJECT: blankToUndefined(z.string().min(1).max(255).optional()),
    // Issue #184 — object store (MinIO) for documents and avatars. Outside production the transform at
    // the end fills the docker-compose / CI values so a dev or test run needs no setup. Blank is
    // treated as unset (compose renders an unset variable as an empty string).
    MINIO_ENDPOINT: blankToUndefined(z.string().min(1).optional()),
    MINIO_PORT: blankToUndefined(z.coerce.number().int().min(1).max(65535).optional()),
    MINIO_ACCESS_KEY: blankToUndefined(z.string().min(1).optional()),
    MINIO_SECRET_KEY: blankToUndefined(z.string().min(1).optional()),
    MINIO_BUCKET: blankToUndefined(z.string().min(1).optional()),
    MINIO_USE_SSL: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
  })
  .refine((data) => !data.SMTP_HOST || (data.SMTP_PORT && data.SMTP_USER), {
    message: "SMTP_PORT and SMTP_USER required when SMTP_HOST is set",
  })
  // Defence in depth: with a value equal to a tenant secret the two verifiers would accept each
  // other's signatures. 88-08/88-09 additionally reject a token by claim. Only the message is
  // reported — never a secret value.
  .refine(
    (data) =>
      data.OPERATOR_JWT_SECRET === undefined ||
      (data.OPERATOR_JWT_SECRET !== data.JWT_SECRET &&
        data.OPERATOR_JWT_SECRET !== data.JWT_REFRESH_SECRET &&
        data.OPERATOR_JWT_SECRET !== data.ENCRYPTION_KEY),
    {
      message:
        "OPERATOR_JWT_SECRET must differ from JWT_SECRET, JWT_REFRESH_SECRET and ENCRYPTION_KEY",
      path: ["OPERATOR_JWT_SECRET"],
    },
  )
  // Issue #608 (D-01) — the VAPID set is all-or-none and internally consistent. Issue messages name
  // the rule and the variable, never a value (the private key must not reach a log).
  .superRefine((data, ctx) => {
    const set = [data.VAPID_PUBLIC_KEY, data.VAPID_PRIVATE_KEY, data.VAPID_SUBJECT].filter(
      (v) => v !== undefined,
    ).length;
    if (set === 0) return;
    if (set < 3) {
      ctx.addIssue({
        code: "custom",
        message:
          "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together or not at all",
        path: ["VAPID_PUBLIC_KEY"],
      });
      return;
    }
    const publicKey = data.VAPID_PUBLIC_KEY as string;
    const privateKey = data.VAPID_PRIVATE_KEY as string;
    const subject = data.VAPID_SUBJECT as string;
    let shapeOk = true;
    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) {
      shapeOk = false;
      ctx.addIssue({
        code: "custom",
        message: "VAPID_PUBLIC_KEY must be an uncompressed P-256 key, base64url, 87 characters",
        path: ["VAPID_PUBLIC_KEY"],
      });
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) {
      shapeOk = false;
      ctx.addIssue({
        code: "custom",
        message: "VAPID_PRIVATE_KEY must be a P-256 private key, base64url, 43 characters",
        path: ["VAPID_PRIVATE_KEY"],
      });
    }
    if (!isUsableVapidSubject(subject)) {
      ctx.addIssue({
        code: "custom",
        message:
          "VAPID_SUBJECT must be mailto:<address> or an https: URL whose host is not localhost",
        path: ["VAPID_SUBJECT"],
      });
    }
    if (shapeOk && deriveVapidPublicKey(privateKey) !== publicKey) {
      ctx.addIssue({
        code: "custom",
        message: "VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY",
        path: ["VAPID_PUBLIC_KEY"],
      });
    }
  })
  // Non-production defaults mirror docker-compose.yml's dev MinIO and the CI MinIO step. In
  // production there is NO default (a silent "minio"/"minioadmin" would hit a host that may not
  // exist): a missing value refuses the start and names the variables (Issue #184).
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== "production") return;
    for (const key of ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"] as const) {
      if (data[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is required in production (object store)`,
          path: [key],
        });
      }
    }
  })
  .transform((data) => {
    const dev = data.NODE_ENV !== "production";
    // In production superRefine guarantees the three values; the dev fallbacks never apply there.
    return {
      ...data,
      MINIO_ENDPOINT: (data.MINIO_ENDPOINT ?? (dev ? "minio" : undefined)) as string,
      MINIO_PORT: data.MINIO_PORT ?? 9000,
      MINIO_ACCESS_KEY: (data.MINIO_ACCESS_KEY ?? (dev ? "minioadmin" : undefined)) as string,
      MINIO_SECRET_KEY: (data.MINIO_SECRET_KEY ?? (dev ? "minioadmin" : undefined)) as string,
      MINIO_BUCKET: data.MINIO_BUCKET ?? "clokr",
    };
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
