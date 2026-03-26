import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
dotenvConfig({ path: resolve(__dirname, "../.env") });

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
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
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
  })
  .refine((data) => !data.SMTP_HOST || (data.SMTP_PORT && data.SMTP_USER), {
    message: "SMTP_PORT and SMTP_USER required when SMTP_HOST is set",
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
