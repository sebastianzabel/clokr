import { defineConfig } from "prisma/config";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://clokr:password@localhost:5432/clokr";
// Shadow DB is only consumed by `migrate diff --from-migrations` (the CI drift check)
// and `migrate dev`. Prisma 7 reads it from here (there is no CLI flag). It is unset at
// container runtime, so the entrypoint's `migrate deploy` / `db push` are unaffected.
const SHADOW_DATABASE_URL = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  datasource: {
    url: DATABASE_URL,
    ...(SHADOW_DATABASE_URL ? { shadowDatabaseUrl: SHADOW_DATABASE_URL } : {}),
  },
  migrate: {
    async adapter() {
      const { Pool } = await import("pg");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      return new PrismaPg(pool);
    },
  },
});
