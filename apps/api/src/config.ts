import { z } from "zod";

const envSchema = z
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
  );

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
