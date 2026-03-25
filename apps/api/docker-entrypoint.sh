#!/bin/sh
set -e

echo "🔄 Syncing database schema..."
cd /app/packages/db
npx prisma migrate deploy || {
  echo "⚠️  Migration failed, falling back to db push..."
  npx prisma db push --url "$DATABASE_URL"
}

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  echo "🌱 Running database seed..."
  cd /app/packages/db
  npx tsx src/seed.ts || echo "ℹ️  Seed skipped"
else
  echo "ℹ️  Seed skipped (SEED_DEMO_DATA=false)"
fi

echo "🚀 Starting Clokr API..."
cd /app
exec su-exec clokr node apps/api/dist/index.js
