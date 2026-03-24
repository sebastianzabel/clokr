#!/bin/sh
set -e

echo "🔄 Syncing database schema..."
cd /app/packages/db
npx prisma db push --url "$DATABASE_URL" --accept-data-loss

echo "🌱 Seeding database..."
npx tsx src/seed.ts || echo "ℹ️  Seed skipped (already applied or failed)"

echo "🚀 Starting Clokr API..."
cd /app
exec node apps/api/dist/index.js
