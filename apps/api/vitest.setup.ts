import { config } from "dotenv";
import { resolve } from "path";

// globalSetup runs before any test worker — override DATABASE_URL here
// so the Fastify app connects to the test schema, not the dev database.
export function setup() {
  config({ path: resolve(__dirname, ".env.test"), override: true });
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Create apps/api/.env.test with TEST_DATABASE_URL pointing to ?schema=test"
    );
  }
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
