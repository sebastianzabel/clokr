import { defineConfig } from "prisma/config";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://clokr:password@localhost:5432/clokr";

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  datasource: {
    url: DATABASE_URL,
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
